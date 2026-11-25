import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";
// MapLibre finds its worker next to its own module, which bundling breaks: point to the copied file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";

import { IndoorLabels3d } from "@/components/indoor-labels-3d";
import { IndoorStack3d } from "@/components/indoor-stack-3d";
import { useTheme } from "@/components/theme-provider";
import { modeColor } from "@/lib/format";
import type { MetroGuide } from "@/lib/guidance";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import type { WalkItem } from "@/lib/guidance";
import {
  describeStepWithFloorName,
  exitSign,
  legLine,
  levelName,
  trainEndPoint,
} from "@/lib/guidance";
import type { LngLat, StationData } from "@/lib/station-types";
import {
  buildIndoorScene3d,
  floorHeight,
  floorLabel3d,
  floorNames3d,
  floorNumber,
  lowestFloor,
  type Route3d,
  type RoutePin3d,
} from "@/lib/indoor-3d";
import { DATA_VERSION, loadStation, useStationIndex } from "@/lib/stations";
import { walkGeometry } from "@/lib/trip-walk";
import type { Itinerary } from "@/lib/transitous";
import type { WalkGraph } from "@/lib/walk-graph";

interface Props {
  itinerary?: Itinerary;
  guides: MetroGuide[];
  graphs: ReadonlyMap<string, WalkGraph>;
  from?: { lat: number; lon: number };
  to?: { lat: number; lon: number };
  /** The floor-by-floor walkthrough of one station path, and the item shown now. */
  walk?: { items: WalkItem[]; index: number };
  onWalk?: (index: number | undefined) => void;
}

maplibregl.setWorkerUrl(workerUrl);

const STYLE = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];
const EMPTY = { type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection;
/** Indoor maps load at this zoom and closer. */
const INDOOR_ZOOM = 15;
const INDOOR_PITCH = 58;

/** Show English names where OSM has them. */
function englishLabels(map: MlMap) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const field = map.getLayoutProperty(layer.id, "text-field");
    if (field && JSON.stringify(field).includes("name")) {
      map.setLayoutProperty(layer.id, "text-field", [
        "coalesce",
        ["get", "name:en"],
        ["get", "name_en"],
        ["get", "name:latin"],
        ["get", "name"],
      ]);
    }
  }
}

/** Kind filters of the floor-dependent layers; the level filter is added to these. */
const BASE_FILTER: Record<string, maplibregl.FilterSpecification> = {
  "indoor-area": ["all", ["==", ["geometry-type"], "Polygon"], ["!=", ["get", "kind"], "building"]],
  "indoor-outline": [
    "all",
    ["==", ["geometry-type"], "Polygon"],
    ["!=", ["get", "kind"], "building"],
  ],
  "indoor-line": [
    "all",
    ["==", ["geometry-type"], "LineString"],
    ["!", ["in", ["get", "kind"], ["literal", ["stairs", "escalator", "elevator"]]]],
  ],
  "indoor-line-casing": [
    "all",
    ["==", ["geometry-type"], "LineString"],
    ["==", ["get", "kind"], "footway"],
  ],
  "indoor-vertical": [
    "all",
    ["==", ["geometry-type"], "LineString"],
    ["in", ["get", "kind"], ["literal", ["stairs", "escalator", "elevator"]]],
  ],
  "indoor-vertical-label": [
    "all",
    ["==", ["geometry-type"], "LineString"],
    ["in", ["get", "kind"], ["literal", ["stairs", "escalator", "elevator"]]],
  ],
  "indoor-poi": ["all", ["==", ["get", "kind"], "poi"], ["has", "name"]],
  "indoor-room-label": [
    "all",
    ["==", ["geometry-type"], "Polygon"],
    ["has", "name"],
    ["!=", ["get", "kind"], "building"],
  ],
  "indoor-elevator": [
    "all",
    ["==", ["geometry-type"], "Point"],
    ["==", ["get", "kind"], "elevator"],
  ],
};

/** Our symbol layers stay visible underground; the basemap's are hidden there. */
const OUR_LAYERS = new Set([
  "building-label",
  "indoor-poi",
  "indoor-room-label",
  "indoor-vertical-label",
  "indoor-elevator-label",
  "entrance-letter",
  "entrance-label",
  "station-path-arrows",
  "pins-label",
]);

export const INDOOR_COLORS = {
  path: "#ff6319",
  stairs: "#7c3aed",
  escalator: "#2563eb",
  elevator: "#059669",
  platform: "#ffb38f",
};

/** 2D indoor layers that the 3D view replaces. */
const FLAT_INDOOR_LAYERS = [
  "indoor-area",
  "indoor-outline",
  "indoor-line-casing",
  "indoor-line",
  "indoor-vertical",
  "indoor-vertical-label",
  "indoor-elevator",
  "indoor-elevator-label",
  "indoor-room-label",
  "indoor-poi",
  "building-label",
  "entrance",
  "entrance-letter",
  "entrance-label",
  "station-path-casing",
  "station-path",
  "station-path-arrows",
  "pins",
  "pins-label",
];

const levelFilter = (level: number): maplibregl.FilterSpecification => [
  "all",
  ["<=", ["get", "lmin"], level],
  [">=", ["get", "lmax"], level],
];

/** A level as text with a real minus sign, like the floor picker. */
const levelText = (key: string): maplibregl.ExpressionSpecification => [
  "case",
  ["<", ["get", key], 0],
  ["concat", "−", ["to-string", ["abs", ["get", key]]]],
  ["to-string", ["get", key]],
];

/** " −2…0" from a feature's level range, or nothing for a single level. */
const levelRange: maplibregl.ExpressionSpecification = [
  "case",
  ["==", ["get", "lmin"], ["get", "lmax"]],
  "",
  ["concat", " ", levelText("lmin"), "…", levelText("lmax")],
];

function addOverlays(map: MlMap, dark: boolean) {
  const fg = dark ? "#e5e7eb" : "#1f2937";
  const halo = dark ? "#0b1220" : "#ffffff";
  const C = INDOOR_COLORS;
  for (const id of [
    "indoor",
    "station-paths",
    "route",
    "ends",
    "entrances",
    "pins",
    "walk-active",
  ]) {
    map.addSource(id, { type: "geojson", data: EMPTY });
  }
  map.addSource("metro-lines", {
    type: "geojson",
    data: `${import.meta.env.BASE_URL}data/metro-lines.json?v=${DATA_VERSION}`,
  });

  // Underground the street map fades almost away, so the station plan reads like a floor plan.
  map.addLayer({
    id: "underground-dim",
    type: "background",
    layout: { visibility: "none" },
    paint: {
      "background-color": dark ? "#05080f" : "#cfd6df",
      "background-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "metro-lines",
    type: "line",
    source: "metro-lines",
    paint: {
      "line-color": C.path,
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 6],
      "line-opacity": 0.55,
    },
  });
  // Named buildings and malls: a tinted footprint with a strong edge and the name, on every
  // floor, so it is clear when the path runs inside one.
  map.addLayer({
    id: "building-fill",
    type: "fill",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: ["==", ["get", "kind"], "building"],
    paint: { "fill-color": dark ? "#1e293b" : "#e2e8f0", "fill-opacity": dark ? 0.75 : 0.6 },
  });
  map.addLayer({
    id: "building-outline",
    type: "line",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: ["==", ["get", "kind"], "building"],
    paint: { "line-color": dark ? "#94a3b8" : "#475569", "line-width": 2 },
  });
  map.addLayer({
    id: "indoor-area",
    type: "fill",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: BASE_FILTER["indoor-area"],
    paint: {
      "fill-color": [
        "match",
        ["get", "kind"],
        "platform",
        C.platform,
        "corridor-area",
        dark ? "#475569" : "#ffffff",
        "room",
        dark ? "#57472d" : "#fbe7cc",
        dark ? "#2b3a52" : "#f8fafc",
      ],
      "fill-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "indoor-outline",
    type: "line",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: BASE_FILTER["indoor-outline"],
    paint: {
      "line-color": dark ? "#cbd5e1" : "#64748b",
      "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.6, 19, 1.6],
    },
  });
  // Walkways read as hallways: a grey edge with a light fill.
  map.addLayer({
    id: "indoor-line-casing",
    type: "line",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: BASE_FILTER["indoor-line-casing"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": dark ? "#cbd5e1" : "#94a3b8",
      "line-width": ["interpolate", ["linear"], ["zoom"], 16, 4, 19, 14],
    },
  });
  map.addLayer({
    id: "indoor-line",
    type: "line",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: BASE_FILTER["indoor-line"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "match",
        ["get", "kind"],
        "track",
        dark ? "#7c2d12" : "#c2410c",
        "platform",
        "#ff8a50",
        dark ? "#64748b" : "#ffffff",
      ],
      "line-opacity": ["match", ["get", "kind"], "track", 0.45, 1],
      // A zoom expression must be the outermost one, so the kinds go inside each stop.
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        16,
        ["match", ["get", "kind"], "track", 1.5, "platform", 5, 2.5],
        19,
        ["match", ["get", "kind"], "track", 1.5, "platform", 5, 11],
      ],
      "line-dasharray": [
        "match",
        ["get", "kind"],
        "track",
        ["literal", [4, 3]],
        ["literal", [1, 0]],
      ],
    },
  });
  map.addLayer({
    id: "indoor-vertical",
    type: "line",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: BASE_FILTER["indoor-vertical"],
    layout: { "line-cap": "butt" },
    paint: {
      "line-color": [
        "match",
        ["get", "kind"],
        "stairs",
        C.stairs,
        "escalator",
        C.escalator,
        C.elevator,
      ],
      "line-width": ["interpolate", ["linear"], ["zoom"], 16, 4, 19, 10],
      "line-dasharray": [
        "match",
        ["get", "kind"],
        "stairs",
        ["literal", [0.35, 0.25]],
        ["literal", [1, 0]],
      ],
    },
  });
  // In-station path: casing, line, and arrows in walking direction.
  map.addLayer({
    id: "station-path-casing",
    type: "line",
    source: "station-paths",
    filter: ["boolean", ["get", "current"], true],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": halo, "line-width": 10 },
  });
  map.addLayer({
    id: "station-path",
    type: "line",
    source: "station-paths",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": C.path,
      "line-width": ["case", ["boolean", ["get", "current"], true], 6, 3],
      "line-opacity": ["case", ["boolean", ["get", "current"], true], 1, 0.4],
      "line-dasharray": [
        "case",
        ["boolean", ["get", "current"], true],
        ["literal", [1, 0]],
        ["literal", [1.5, 1.5]],
      ],
    },
  });
  map.addLayer({
    id: "station-path-arrows",
    type: "symbol",
    source: "station-paths",
    filter: ["boolean", ["get", "current"], true],
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 40,
      "text-field": "›",
      "text-font": FONT_BOLD,
      "text-size": 20,
      "text-keep-upright": false,
      "text-allow-overlap": true,
      "text-offset": [0, -0.1],
    },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": halo, "line-width": 8 },
  });
  map.addLayer({
    id: "route",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["==", ["get", "mode"], "WALK"], 4, 5],
      "line-dasharray": [
        "case",
        ["==", ["get", "mode"], "WALK"],
        ["literal", [0.6, 1.4]],
        ["literal", [1, 0]],
      ],
    },
  });
  map.addLayer({
    id: "indoor-room-label",
    type: "symbol",
    source: "indoor",
    minzoom: 17.5,
    filter: BASE_FILTER["indoor-room-label"],
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT,
      "text-size": 11,
      "text-max-width": 8,
      "text-optional": true,
    },
    paint: {
      "text-color": dark ? "#cbd5e1" : "#475569",
      "text-halo-color": halo,
      "text-halo-width": 1,
    },
  });
  map.addLayer({
    id: "building-label",
    type: "symbol",
    source: "indoor",
    minzoom: 16,
    filter: ["==", ["get", "kind"], "building"],
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT_BOLD,
      "text-size": 13,
      "text-max-width": 9,
      "text-optional": true,
    },
    paint: {
      "text-color": fg,
      "text-halo-color": halo,
      "text-halo-width": 2,
      "text-opacity": 0.85,
    },
  });
  map.addLayer({
    id: "indoor-poi",
    type: "symbol",
    source: "indoor",
    minzoom: 18,
    filter: BASE_FILTER["indoor-poi"],
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT,
      "text-size": 10,
      "text-optional": true,
    },
    paint: {
      "text-color": dark ? "#cbd5e1" : "#475569",
      "text-halo-color": halo,
      "text-halo-width": 1,
    },
  });
  map.addLayer({
    id: "indoor-vertical-label",
    type: "symbol",
    source: "indoor",
    minzoom: 17.5,
    filter: BASE_FILTER["indoor-vertical-label"],
    layout: {
      "symbol-placement": "line-center",
      "text-field": [
        "concat",
        ["match", ["get", "kind"], "stairs", "Stairs", "escalator", "Escalator", "Lift"],
        levelRange,
      ],
      "text-font": FONT_BOLD,
      "text-size": 11,
      "text-offset": [0, -1],
      "text-optional": true,
    },
    paint: {
      "text-color": [
        "match",
        ["get", "kind"],
        "stairs",
        C.stairs,
        "escalator",
        C.escalator,
        C.elevator,
      ],
      "text-halo-color": halo,
      "text-halo-width": 1.5,
    },
  });
  map.addLayer({
    id: "indoor-elevator",
    type: "circle",
    source: "indoor",
    minzoom: 16,
    filter: BASE_FILTER["indoor-elevator"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 5, 19, 9],
      "circle-color": C.elevator,
      "circle-stroke-color": halo,
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "indoor-elevator-label",
    type: "symbol",
    source: "indoor",
    minzoom: 18,
    filter: BASE_FILTER["indoor-elevator"],
    layout: {
      "text-field": ["concat", "Lift", levelRange],
      "text-font": FONT_BOLD,
      "text-size": 11,
      "text-offset": [0, 1.3],
      "text-optional": true,
    },
    paint: { "text-color": C.elevator, "text-halo-color": halo, "text-halo-width": 1.5 },
  });
  // Entrances on every floor: a lettered disc, and the sign text when zoomed in.
  map.addLayer({
    id: "entrance",
    type: "circle",
    source: "entrances",
    minzoom: INDOOR_ZOOM,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 7, 18, 12],
      "circle-color": [
        "case",
        ["boolean", ["get", "used"], false],
        C.path,
        dark ? "#475569" : "#334155",
      ],
      "circle-stroke-color": halo,
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "entrance-letter",
    type: "symbol",
    source: "entrances",
    minzoom: INDOOR_ZOOM,
    layout: {
      "text-field": ["coalesce", ["get", "ref"], "M"],
      "text-font": FONT_BOLD,
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 13],
      "text-allow-overlap": true,
    },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: "entrance-label",
    type: "symbol",
    source: "entrances",
    minzoom: 17,
    filter: ["has", "sign"],
    layout: {
      "text-field": ["get", "sign"],
      "text-font": FONT,
      "text-size": 11,
      "text-anchor": "left",
      "text-offset": [1.3, 0],
      "text-max-width": 10,
      "text-optional": true,
    },
    paint: { "text-color": fg, "text-halo-color": halo, "text-halo-width": 1.5 },
  });
  // The walkthrough step shown now: a bright, thick line (or a ring for a single point).
  map.addLayer({
    id: "walk-active-casing",
    type: "line",
    source: "walk-active",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": halo, "line-width": 16 },
  });
  map.addLayer({
    id: "walk-active-line",
    type: "line",
    source: "walk-active",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#facc15", "line-width": 9 },
  });
  map.addLayer({
    id: "walk-active-point",
    type: "circle",
    source: "walk-active",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 16,
      "circle-color": "rgba(250, 204, 21, 0.25)",
      "circle-stroke-color": "#facc15",
      "circle-stroke-width": 4,
    },
  });
  map.addLayer({
    id: "pins",
    type: "circle",
    source: "pins",
    minzoom: INDOOR_ZOOM,
    paint: {
      "circle-radius": 7,
      "circle-color": "#111827",
      "circle-stroke-color": C.path,
      "circle-stroke-width": 3,
    },
  });
  map.addLayer({
    id: "pins-label",
    type: "symbol",
    source: "pins",
    minzoom: INDOOR_ZOOM,
    layout: {
      "text-field": ["get", "label"],
      "text-font": FONT_BOLD,
      "text-size": 12,
      "text-variable-anchor": ["top", "bottom", "left", "right"],
      "text-radial-offset": 0.9,
      "text-justify": "auto",
      "text-max-width": 12,
    },
    paint: { "text-color": fg, "text-halo-color": halo, "text-halo-width": 2 },
  });
  map.addLayer({
    id: "ends",
    type: "circle",
    source: "ends",
    paint: {
      "circle-radius": 8,
      "circle-color": ["match", ["get", "end"], "from", "#16a34a", "#dc2626"],
      "circle-stroke-color": halo,
      "circle-stroke-width": 3,
    },
  });
  map.addLayer({
    id: "indoor-3d-shade",
    type: "background",
    minzoom: INDOOR_ZOOM - 0.5,
    layout: { visibility: "none" },
    paint: {
      "background-color": dark ? "#0f1823" : "#eaf0f4",
      "background-opacity": dark ? 0.64 : 0.78,
    },
  });
}

function Key({
  color,
  label,
  dashed,
  dot,
  block,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  dot?: boolean;
  block?: boolean;
}) {
  return (
    <li className="flex items-center gap-1.5">
      {dot ? (
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      ) : block ? (
        <span className="h-2.5 w-4 shrink-0 rounded-sm" style={{ background: color }} />
      ) : (
        <span
          className="h-1 w-4 shrink-0 rounded"
          style={
            dashed
              ? {
                  backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 5px)`,
                }
              : { background: color }
          }
        />
      )}
      {label}
    </li>
  );
}

export function MapView({ itinerary, guides, graphs, from, to, walk, onWalk }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(0);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const index = useStationIndex();
  const [nearby, setNearby] = useState<StationData[]>([]);
  const [level, setLevel] = useState(0);
  const [threeD, setThreeD] = useState(false);
  const [zoom, setZoom] = useState(11.5);

  // Create the map once. Every style load (first load and theme changes) adds the overlays again.
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const styleUrl = useRef("");
  useEffect(() => {
    if (!container.current) return;
    styleUrl.current = darkRef.current ? STYLE.dark : STYLE.light;
    const map = new maplibregl.Map({
      container: container.current,
      style: styleUrl.current,
      center: [24.94, 60.17],
      zoom: 11.5,
      attributionControl: false,
    });
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          '<a href="https://transitous.org/sources/" target="_blank" rel="noreferrer">Routing: Transitous</a> · HSL GTFS (CC BY 4.0)',
      }),
    );
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "top-right",
    );
    map.on("style.load", () => {
      englishLabels(map);
      addOverlays(map, darkRef.current);
      setReady((n) => n + 1);
    });
    const onZoom = () => setZoom(map.getZoom());
    map.on("zoomend", onZoom);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const want = dark ? STYLE.dark : STYLE.light;
    if (!map || styleUrl.current === want) return;
    styleUrl.current = want;
    setReady(0);
    map.setStyle(want, { diff: false });
  }, [dark]);

  // Load the indoor maps of stations near the map centre, and of the itinerary's stations.
  const routeStations = useMemo(
    () =>
      guides
        .flatMap((g) => [g.board?.station, g.alight?.station])
        .filter((s): s is StationData => !!s),
    [guides],
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !index) return;
    let latest = 0;
    let live = true;
    const update = () => {
      const request = ++latest;
      if (map.getZoom() < INDOOR_ZOOM - 0.5) {
        setNearby([]);
        return;
      }
      const c = map.getCenter();
      const near = index.stations.filter(
        (s) => Math.abs(s.lat - c.lat) < 0.008 && Math.abs(s.lng - c.lng) < 0.016,
      );
      const distanceToCenter = (s: (typeof near)[number]) =>
        Math.hypot(s.lat - c.lat, (s.lng - c.lng) * Math.cos((c.lat * Math.PI) / 180));
      near.sort((a, b) => distanceToCenter(a) - distanceToCenter(b));
      void Promise.all(near.map((s) => loadStation(s.id).catch(() => undefined))).then((list) => {
        // A slower, older load must not replace the stations of the current view.
        if (live && request === latest) {
          const next = list.filter((s): s is StationData => !!s);
          setNearby((previous) =>
            next.length === previous.length && next.every((s, i) => s === previous[i])
              ? previous
              : next,
          );
        }
      });
    };
    update();
    map.on("moveend", update);
    return () => {
      live = false;
      map.off("moveend", update);
    };
  }, [index, ready]);

  const shown = useMemo(() => {
    const all = new Map<string, StationData>();
    for (const s of [...nearby, ...routeStations]) all.set(s.id, s);
    return [...all.values()];
  }, [nearby, routeStations]);
  const walked = useMemo(
    () =>
      guides.flatMap((g) =>
        [g.board, g.alight]
          .filter((guide) => !!guide)
          .map((guide) => ({
            guide,
            line: guide.line,
            end: g.trainEnd,
            out: guide.direction === "out",
          })),
      ),
    [guides],
  );
  const indoorRoutes = useMemo(
    () =>
      shown.map((station) => {
        const walks = walked.filter(({ guide }) => guide.station.id === station.id);
        const routes = walks.map(({ guide, line }): Route3d => ({
          line,
          steps: guide.steps,
          fallbackLevel: guide.platform.level ?? guide.entrance.level ?? 0,
        }));
        const floorNames = floorNames3d(graphs.get(station.id)?.pois ?? []);
        for (const { guide } of walks) {
          const poi = guide.poi;
          if (poi?.floor && poi.level !== null) floorNames.set(poi.level, poi.floor);
        }
        return { station, routes, floorNames, lowest: lowestFloor(station, routes) };
      }),
    [graphs, shown, walked],
  );
  // The floor picker follows the stations near the map centre.
  const levels = useMemo(
    () =>
      zoom < INDOOR_ZOOM - 0.5
        ? []
        : [...new Set(nearby.flatMap((s) => s.levels))].toSorted((a, b) => b - a),
    [nearby, zoom],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("indoor") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      // Stations near each other share buildings: draw each building once.
      features: (() => {
        const seen = new Set<string>();
        return shown.flatMap((s) =>
          s.indoor.features.filter((f) => {
            if (f.properties.kind === "entrance") return false;
            if (f.properties.kind !== "building") return true;
            const key = `${f.properties.name}|${JSON.stringify(f.geometry.coordinates).slice(0, 60)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        );
      })(),
    } as GeoJSON.FeatureCollection);
    const used = new Set(
      guides.flatMap((g) => [g.board?.entrance.id, g.alight?.entrance.id]).filter(Boolean),
    );
    (map.getSource("entrances") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: shown.flatMap((s) =>
        s.entrances.map((e) => {
          const where = exitSign(e, "out").where;
          return {
            type: "Feature" as const,
            properties: {
              ...(e.ref ? { ref: e.ref } : {}),
              ...(where ? { sign: e.ref ? `${e.ref} · ${where}` : where } : {}),
              used: used.has(e.id),
            },
            geometry: { type: "Point" as const, coordinates: [e.lng, e.lat] },
          };
        }),
      ),
    });
  }, [shown, ready, guides]);

  // Level filter and the underground shade.
  const closeIndoor3d = threeD && zoom >= INDOOR_ZOOM - 0.5 && levels.length > 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter = levelFilter(level);
    for (const [id, base] of Object.entries(BASE_FILTER)) {
      map.setFilter(id, ["all", base, filter] as maplibregl.FilterSpecification);
    }
    // The 3D view shows every floor over the street map, so the street map stays visible.
    const underground = level < 0 && levels.length > 0 && !threeD;
    map.setLayoutProperty("underground-dim", "visibility", underground ? "visible" : "none");
    // Street-level labels and icons clutter an underground floor.
    for (const layer of map.getStyle().layers) {
      if (layer.type === "symbol" && !OUR_LAYERS.has(layer.id)) {
        const sourceLayer = layer["source-layer"];
        const groundDetail =
          sourceLayer === "poi" || sourceLayer === "building" || sourceLayer === "housenumber";
        map.setLayoutProperty(
          layer.id,
          "visibility",
          underground || (closeIndoor3d && groundDetail) ? "none" : "visible",
        );
      }
    }
    map.setPaintProperty(
      "metro-lines",
      "line-opacity",
      underground ? 0.9 : closeIndoor3d ? 0.22 : 0.55,
    );
    // The street part of the trip is not on this floor.
    const streetOpacity: maplibregl.ExpressionSpecification = [
      "case",
      ["==", ["get", "mode"], "SUBWAY"],
      closeIndoor3d ? 0.34 : 1,
      underground ? 0.3 : closeIndoor3d ? 0.6 : 1,
    ];
    map.setPaintProperty("route", "line-opacity", streetOpacity);
    map.setPaintProperty("route-casing", "line-opacity", streetOpacity);
  }, [level, ready, levels.length, threeD, closeIndoor3d]);

  const stationPins = useMemo(
    () =>
      walked.map(({ guide, line, end, out }) => {
        // The board / get-off pin marks the train end on the platform, not where the path arrives.
        const platformArrival = out ? line[0] : line.at(-1);
        const platformPoint = end ? trainEndPoint(guide, end) : platformArrival;
        const exitPoint = out ? line.at(-1) : line[0];
        const sign = guide.poi
          ? { title: guide.poi.name }
          : exitSign(guide.entrance, out ? "out" : "in");
        const pins: (RoutePin3d & { flatPoint: LngLat; flatOnly?: true })[] = [];
        const pin = (
          p: LngLat | undefined,
          text: string,
          level: number | null,
          kind: RoutePin3d["kind"] = "route",
          raisedPoint = p,
          options: { flatOnly?: true; pathPoint?: LngLat } = {},
        ) => {
          if (p && raisedPoint)
            pins.push({
              flatPoint: p,
              point: raisedPoint,
              text,
              level,
              kind,
              ...options,
            });
        };
        pin(
          platformPoint && [platformPoint[0], platformPoint[1]],
          out ? `Get off${end ? ` at the ${end}` : ""}` : `Board${end ? ` at the ${end}` : ""}`,
          guide.platform.level ?? platformArrival?.[2] ?? guide.entrance.level ?? 0,
          "route",
          undefined,
          platformArrival ? { pathPoint: [platformArrival[0], platformArrival[1]] } : {},
        );
        const { lng, lat, level, liftTo } = guide.entrance;
        const goalPoint: LngLat = [lng, lat];
        pin(
          exitPoint && [exitPoint[0], exitPoint[1]],
          sign.title,
          guide.poi?.level ?? liftTo ?? level ?? exitPoint?.[2] ?? null,
          // A mapped shop is the trip's start when the guide walks into the station.
          guide.poi ? (out ? "destination" : "origin") : "entrance",
          goalPoint,
          exitPoint ? { pathPoint: [exitPoint[0], exitPoint[1]] } : {},
        );
        for (const step of guide.steps) {
          if (step.mode === "walk" || step.toLevel === step.fromLevel) continue;
          const a = line[step.a];
          if (!a) continue;
          const { fromLevel, toLevel } = step;
          const arrow =
            fromLevel === null || toLevel === null ? "" : toLevel > fromLevel ? " ↑" : " ↓";
          const name = {
            stairs: "Stairs",
            escalator: "Escalator",
            elevator: "Lift",
            level: "Floor change",
          }[step.mode];
          const target =
            toLevel === null ? "" : ` to ${toLevel === 0 ? "street" : floorNumber(toLevel)}`;
          pin(
            [a[0], a[1]],
            `${name}${arrow}${target}`,
            fromLevel ?? a[2] ?? toLevel,
            "route",
            undefined,
            { flatOnly: true },
          );
        }
        return { stationId: guide.station.id, pins };
      }),
    [walked],
  );

  // Itinerary and in-station paths.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // A walk next to a guided station is drawn from the exit (to the entrance) the app chose,
    // not along the routing engine's own way through the station: the map must match the steps.
    const byLeg = new Map(guides.map((g) => [g.legIndex, g]));
    const features: GeoJSON.Feature[] = (itinerary?.legs ?? []).map((leg, i) => {
      const exit = byLeg.get(i - 1)?.alight?.entrance;
      const entrance = byLeg.get(i + 1)?.board?.entrance;
      // The indoor path to a shop replaces the street walk entirely.
      const indoor = byLeg.get(i - 1)?.alight?.poi || byLeg.get(i + 1)?.board?.poi;
      const coordinates = indoor
        ? []
        : leg.mode === "WALK" && (exit || entrance)
          ? walkGeometry(
              leg,
              exit ? [exit.lng, exit.lat] : undefined,
              entrance ? [entrance.lng, entrance.lat] : undefined,
            )
          : legLine(leg);
      return {
        type: "Feature",
        properties: { mode: leg.mode, color: modeColor(leg.mode) },
        geometry: { type: "LineString", coordinates },
      };
    });
    (map.getSource("route") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features,
    });
    (map.getSource("pins") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: stationPins.flatMap(({ pins }) =>
        pins.map(({ flatPoint, text }) => ({
          type: "Feature",
          properties: { label: text },
          geometry: { type: "Point", coordinates: flatPoint },
        })),
      ),
    });
    const paths: GeoJSON.Feature[] = walked.flatMap(({ line }) => {
      // Split the path by level so each part can show on its own level.
      const parts: { level: number | null; coords: LngLat[] }[] = [];
      for (const [lng, lat, lv] of line) {
        const last = parts.at(-1);
        if (last && last.level === lv) last.coords.push([lng, lat]);
        else {
          const prev = last?.coords.at(-1);
          parts.push({ level: lv, coords: prev ? [prev, [lng, lat]] : [[lng, lat]] });
        }
      }
      return parts
        .filter((p) => p.coords.length > 1)
        .map((p) => ({
          type: "Feature" as const,
          properties: { current: p.level === null || p.level === level },
          geometry: { type: "LineString" as const, coordinates: p.coords },
        }));
    });
    (map.getSource("station-paths") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: paths,
    });
    const ends: GeoJSON.Feature[] = [];
    if (from)
      ends.push({
        type: "Feature",
        properties: { end: "from" },
        geometry: { type: "Point", coordinates: [from.lon, from.lat] },
      });
    if (to)
      ends.push({
        type: "Feature",
        properties: { end: "to" },
        geometry: { type: "Point", coordinates: [to.lon, to.lat] },
      });
    (map.getSource("ends") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: ends,
    });
  }, [itinerary, guides, walked, stationPins, from, to, ready, level]);

  // Walkthrough: show the current item on its own floor and fit it into view.
  const item = walk ? walk.items[walk.index] : undefined;
  const indoorItem = indoorRoutes.find(({ station }) => item?.stationId === station.id);
  const floorNames = threeD
    ? (indoorItem ?? indoorRoutes.find(({ station }) => station.id === nearby[0]?.id))?.floorNames
    : undefined;
  const raisedFloorName = (l: number | null) =>
    l === null
      ? levelName(l)
      : l === 0 && !floorNames?.get(0)
        ? "street level"
        : `floor ${floorLabel3d(l, floorNames)}`;
  const fitted = useRef<WalkItem | undefined>(undefined);
  const fittedTilt = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const pts = item?.points ?? [];
    (map.getSource("walk-active") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features:
        pts.length === 0 || (threeD && indoorItem)
          ? []
          : [
              {
                type: "Feature",
                properties: {},
                geometry:
                  pts.length > 1
                    ? { type: "LineString", coordinates: pts }
                    : { type: "Point", coordinates: pts[0] as LngLat },
              },
            ],
    });
    // Fit only when the step changes, not when a style reload (theme change) bumps `ready`:
    // that would undo the user's own floor choice and pan.
    if (!item) fitted.current = undefined;
    // Fit again when the step or the 3D tilt changes; a theme reload alone does not refit.
    if (!item || pts.length === 0 || (fitted.current === item && fittedTilt.current === threeD)) {
      return;
    }
    const entering3d = threeD && !fittedTilt.current;
    const pitch = threeD ? (entering3d ? INDOOR_PITCH : map.getPitch()) : 0;
    fitted.current = item;
    fittedTilt.current = threeD;
    if (item.level !== null) setLevel(item.level);
    const indoor = threeD ? indoorItem : undefined;
    const tripPoints =
      indoor?.routes.flatMap(({ line }) => line.map(([lng, lat]): LngLat => [lng, lat])) ?? [];
    const tripPins = indoor
      ? stationPins
          .filter((p) => p.stationId === indoor.station.id)
          .flatMap((p) => p.pins.filter((pin) => !pin.flatOnly))
      : [];
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    for (const p of tripPoints) b.extend(p);
    for (const pin of tripPins) b.extend(pin.point);
    const phone = window.innerWidth < 768;
    const padding = indoor
      ? phone
        ? { top: 180, bottom: 286, left: 55, right: 87 }
        : { top: 110, bottom: 240, left: 215, right: 200 }
      : phone
        ? { top: 130, bottom: 290, left: 60, right: 90 }
        : { top: 130, bottom: 150, left: 120, right: 120 };
    const maxZoom = indoor
      ? 18.5
      : item.kind === "entrance" || item.kind === "arrive" || item.kind === "board"
        ? 17.5
        : 19;
    let bearing = threeD ? map.getBearing() : 0;
    if (entering3d && phone && indoor && bearing === 0) {
      // A long east-west station fits diagonally on a narrow screen.
      const width = (b.getEast() - b.getWest()) * Math.cos((b.getCenter().lat * Math.PI) / 180);
      if (width > (b.getNorth() - b.getSouth()) * 1.8) bearing = 42;
    }
    const fit = { padding, maxZoom, bearing };
    let offsetY = 0;
    if (indoor) {
      const targetZoom = map.cameraForBounds(b, fit)?.zoom ?? maxZoom;
      const coordinate = maplibregl.MercatorCoordinate.fromLngLat(b.getCenter());
      const pixelsPerMeter = coordinate.meterInMercatorCoordinateUnits() * 512 * 2 ** targetZoom;
      const heights = indoor.routes.flatMap(({ line, steps }) => [
        ...line.flatMap((p) => (p[2] === null ? [] : [p[2]])),
        ...steps.flatMap(({ fromLevel, toLevel }) =>
          [fromLevel, toLevel].filter((l): l is number => l !== null),
        ),
      ]);
      const middle = heights.length
        ? (Math.min(...heights) + Math.max(...heights)) / 2
        : (item.level ?? 0);
      offsetY = Math.min(
        map.getCanvas().clientHeight * 0.16,
        floorHeight(middle, indoor.lowest) * pixelsPerMeter * Math.sin((pitch * Math.PI) / 180),
      );
    }
    map.fitBounds(b, {
      ...fit,
      offset: [0, offsetY],
      pitch,
      duration: 700,
    });
  }, [item, indoorItem, stationPins, ready, threeD]);

  const view3d = useMemo(() => {
    if (!threeD) return;
    const display = indoorItem ?? indoorRoutes.find(({ station }) => station.id === nearby[0]?.id);
    if (!display) return;
    const { station, routes, floorNames } = display;
    const pins = stationPins
      .filter((p) => p.stationId === station.id)
      .flatMap((p) => p.pins.filter((pin) => !pin.flatOnly));
    const active =
      item?.stationId === station.id
        ? {
            points: item.points,
            level: item.level ?? level,
            ...(item.indoorStep ? { step: item.indoorStep } : {}),
          }
        : undefined;
    return buildIndoorScene3d(station, routes, level, pins, floorNames, active);
  }, [threeD, indoorItem, indoorRoutes, nearby, stationPins, item, level]);

  // Swap the flat indoor layers for the 3D stack.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const id of FLAT_INDOOR_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", threeD ? "none" : "visible");
    }
    map.setLayoutProperty("indoor-3d-shade", "visibility", threeD ? "visible" : "none");
    // Keep the raised stack in front of the street-map buildings.
    for (const layer of map.getStyle().layers) {
      if (layer.type === "fill-extrusion") {
        map.setLayoutProperty(layer.id, "visibility", threeD ? "none" : "visible");
      }
    }
    const indoorFrom = walked.some(({ guide, out }) => guide.poi && !out);
    const indoorTo = walked.some(({ guide, out }) => guide.poi && out);
    map.setFilter(
      "ends",
      threeD
        ? [
            "!",
            [
              "in",
              ["get", "end"],
              ["literal", [...(indoorFrom ? ["from"] : []), ...(indoorTo ? ["to"] : [])]],
            ],
          ]
        : null,
    );
  }, [threeD, ready, walked]);
  useEffect(() => {
    if (!fitted.current)
      mapRef.current?.easeTo({ pitch: threeD ? INDOOR_PITCH : 0, duration: 600 });
  }, [threeD]);

  const usedLevels = useMemo(() => {
    const set = new Set<number>();
    for (const g of guides) {
      for (const guide of [g.board, g.alight]) {
        for (const v of guide?.line ?? []) if (v[2] !== null) set.add(v[2]);
        for (const st of guide?.steps ?? []) {
          if (st.fromLevel !== null) set.add(st.fromLevel);
          if (st.toLevel !== null) set.add(st.toLevel);
        }
        if (guide?.platform.level != null) set.add(guide.platform.level);
      }
    }
    return set;
  }, [guides]);

  // Fit the itinerary.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !itinerary) return;
    const pts = itinerary.legs.flatMap(legLine);
    if (pts.length === 0) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    // On a phone the route panel covers the lower part of the map.
    const phone = window.innerWidth < 768;
    map.fitBounds(b, {
      padding: phone
        ? { top: 60, bottom: Math.round(window.innerHeight * 0.6), left: 30, right: 60 }
        : { top: 60, bottom: 60, left: 60, right: 80 },
      maxZoom: 16,
      duration: 600,
    });
  }, [itinerary]);

  const routedFloors = view3d?.route.length
    ? view3d.plates.map((plate) => plate.level).toReversed()
    : undefined;
  const floorOptions = routedFloors ?? levels;

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {view3d && (
        <>
          <IndoorStack3d mapRef={mapRef} ready={ready} scene={view3d} dark={dark} />
          <IndoorLabels3d mapRef={mapRef} ready={ready} labels={view3d.labels} walking={!!walk} />
        </>
      )}
      {walk && item && (
        <div className="absolute inset-x-2 bottom-[148px] z-20 mx-auto max-w-md rounded-xl border bg-background/97 p-2 shadow-lg md:bottom-4">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous step"
              disabled={walk.index === 0}
              onClick={() => onWalk?.(walk.index - 1)}
              className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="size-5" />
            </button>
            <div className="min-w-0 flex-1 px-1" aria-live="polite">
              <div className="text-muted-foreground text-xs">
                Step {walk.index + 1} of {walk.items.length} ·{" "}
                <span className="font-semibold text-[#c2410c] dark:text-[#ff8a50]">
                  {item.kind === "ride"
                    ? "On board"
                    : item.kind === "board"
                      ? "Boarding"
                      : threeD && item.level !== null
                        ? raisedFloorName(item.level).replace(/^./, (c) => c.toUpperCase())
                        : item.level === null
                          ? "floor unknown"
                          : item.level === 0
                            ? "Street level"
                            : `Level ${item.level > 0 ? item.level : `−${-item.level}`}`}
                </span>
              </div>
              <div className="font-medium text-sm leading-snug">
                {threeD && item.indoorStep && item.indoorStep.mode !== "walk"
                  ? describeStepWithFloorName(item.indoorStep, raisedFloorName)
                  : threeD
                    ? item.text.replace(/\blevel ([−-]?\d+\.\d+)/g, (_, value: string) =>
                        raisedFloorName(Number(value.replace("−", "-"))),
                      )
                    : item.text}
              </div>
            </div>
            <button
              type="button"
              aria-label="Next step"
              disabled={walk.index === walk.items.length - 1}
              onClick={() => onWalk?.(walk.index + 1)}
              className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#ff6319] text-white hover:bg-[#ea580c] disabled:opacity-30"
            >
              <ChevronRight className="size-5" />
            </button>
            <button
              type="button"
              aria-label="End the walkthrough"
              onClick={() => onWalk?.(undefined)}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}
      {(levels.length > 0 || threeD) && (
        <button
          type="button"
          aria-pressed={threeD}
          aria-label={threeD ? "Show the map flat" : "Show all floors in 3D"}
          onClick={() => setThreeD((v) => !v)}
          className={`absolute top-40 right-2.5 z-10 h-9 w-9 rounded-md border text-sm font-semibold shadow-md pointer-coarse:h-11 pointer-coarse:w-11 md:top-44 ${
            threeD ? "bg-[#ff6319] text-white" : "bg-background/95 hover:bg-muted"
          }`}
        >
          3D
        </button>
      )}
      {levels.length > 0 && floorOptions.length > 1 && (
        <div
          className="absolute top-[13.5rem] right-2.5 z-10 flex max-h-[34svh] flex-col overflow-y-auto rounded-md border bg-background/95 shadow-md md:top-56"
          role="radiogroup"
          aria-label="Floor"
        >
          {floorOptions.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === level}
              aria-label={threeD ? raisedFloorName(l) : levelName(l)}
              onClick={() => setLevel(l)}
              aria-description={usedLevels.has(l) ? "Your path uses this floor" : undefined}
              className={`relative w-9 font-medium tabular-nums pointer-coarse:w-11 ${threeD ? "min-h-9 shrink-0 break-words px-1 text-xs pointer-coarse:min-h-11" : "h-9 text-sm pointer-coarse:h-11"} ${
                l === level ? "bg-[#ff6319] text-white" : "hover:bg-muted"
              }`}
            >
              {threeD ? floorLabel3d(l, floorNames) : floorNumber(l)}
              {usedLevels.has(l) && l !== level && (
                <span
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-[#ff6319]"
                  aria-hidden
                />
              )}
            </button>
          ))}
        </div>
      )}
      {!threeD && levels.length > 0 && (
        <div
          className={`pointer-events-none absolute top-2 left-2 z-10 max-w-[60%] rounded-lg bg-background/95 px-2.5 py-1.5 text-[11px] shadow-md md:top-3 md:left-3 ${walk ? "max-md:hidden" : ""}`}
        >
          <div className="mb-1 font-semibold text-xs">
            {level === 0 ? "Street level" : `Level ${floorNumber(level)}`}
            <span className="font-normal text-muted-foreground">
              {level < 0 ? " · below street" : level > 0 ? " · above street" : ""}
            </span>
          </div>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <Key color={INDOOR_COLORS.path} label="Your path" />
            <Key color={INDOOR_COLORS.platform} label="Platform" block />
            <Key color={INDOOR_COLORS.stairs} label="Stairs" dashed />
            <Key color={INDOOR_COLORS.escalator} label="Escalator" />
            <Key color={INDOOR_COLORS.elevator} label="Lift" dot />
            <Key color={dark ? "#475569" : "#334155"} label="Exit letter" dot />
            <Key color={INDOOR_COLORS.path} label="Your exit" dot />
          </ul>
        </div>
      )}
    </div>
  );
}
