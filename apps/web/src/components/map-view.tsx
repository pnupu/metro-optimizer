import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";
// MapLibre finds its worker next to its own module, which bundling breaks: point to the copied file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "@/components/theme-provider";
import { modeColor } from "@/lib/format";
import type { MetroGuide } from "@/lib/guidance";
import { legLine, levelName } from "@/lib/guidance";
import type { LngLat, StationData } from "@/lib/station-types";
import { loadStation, useStationIndex } from "@/lib/stations";
import type { Itinerary } from "@/lib/transitous";

export interface MapFocus {
  lng: number;
  lat: number;
  level?: number;
  zoom?: number;
  /** Change this to fly again to the same place. */
  nonce: number;
}

interface Props {
  itinerary?: Itinerary;
  guides: MetroGuide[];
  from?: { lat: number; lon: number };
  to?: { lat: number; lon: number };
  focus?: MapFocus;
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

/** Kind filters of the indoor layers; the level filter is added to these. */
const BASE_FILTER: Record<string, maplibregl.FilterSpecification> = {
  "indoor-area": ["==", ["geometry-type"], "Polygon"],
  "indoor-line": ["==", ["geometry-type"], "LineString"],
  "indoor-poi": ["all", ["==", ["get", "kind"], "poi"], ["has", "name"]],
  "indoor-elevator": ["==", ["get", "kind"], "elevator"],
};

const OUR_LAYERS = new Set(["indoor-poi", "entrance-label"]);

const levelFilter = (level: number): maplibregl.FilterSpecification => [
  "all",
  ["<=", ["get", "lmin"], level],
  [">=", ["get", "lmax"], level],
];

function addOverlays(map: MlMap, dark: boolean) {
  const fg = dark ? "#e5e7eb" : "#1f2937";
  const halo = dark ? "#111827" : "#ffffff";
  map.addSource("metro-lines", {
    type: "geojson",
    data: `${import.meta.env.BASE_URL}data/metro-lines.json`,
  });
  map.addSource("indoor", { type: "geojson", data: EMPTY });
  map.addSource("station-paths", { type: "geojson", data: EMPTY });
  map.addSource("route", { type: "geojson", data: EMPTY });
  map.addSource("ends", { type: "geojson", data: EMPTY });

  map.addLayer({
    id: "underground-dim",
    type: "background",
    layout: { visibility: "none" },
    paint: {
      "background-color": dark ? "#000000" : "#0f172a",
      "background-opacity": dark ? 0.55 : 0.45,
    },
  });
  map.addLayer({
    id: "metro-lines",
    type: "line",
    source: "metro-lines",
    paint: {
      "line-color": "#ff6319",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 6],
      "line-opacity": 0.55,
    },
  });
  // Indoor map: areas, then lines, then points.
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
        "#ffb38f",
        "corridor-area",
        dark ? "#374151" : "#f3f4f6",
        "room",
        dark ? "#1f2937" : "#fde9c9",
        dark ? "#273244" : "#e5e7eb",
      ],
      "fill-opacity": 0.9,
      "fill-outline-color": dark ? "#9ca3af" : "#9ca3af",
    },
  });
  map.addLayer({
    id: "indoor-line",
    type: "line",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: BASE_FILTER["indoor-line"],
    paint: {
      "line-color": [
        "match",
        ["get", "kind"],
        "track",
        "#ff6319",
        "platform",
        "#ff8a50",
        "escalator",
        "#2563eb",
        "stairs",
        "#7c3aed",
        "elevator",
        "#059669",
        dark ? "#9ca3af" : "#6b7280",
      ],
      "line-width": [
        "match",
        ["get", "kind"],
        "track",
        3,
        "platform",
        6,
        "escalator",
        4,
        "stairs",
        4,
        2,
      ],
      "line-dasharray": [
        "match",
        ["get", "kind"],
        "stairs",
        ["literal", [1, 0.6]],
        ["literal", [1, 0]],
      ],
    },
  });
  map.addLayer({
    id: "station-path",
    type: "line",
    source: "station-paths",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ff6319",
      "line-width": 5,
      "line-opacity": ["case", ["boolean", ["get", "current"], true], 1, 0.35],
    },
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
    id: "indoor-poi",
    type: "symbol",
    source: "indoor",
    minzoom: 17,
    filter: BASE_FILTER["indoor-poi"],
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT,
      "text-size": 11,
      "text-optional": true,
    },
    paint: { "text-color": fg, "text-halo-color": halo, "text-halo-width": 1.2 },
  });
  map.addLayer({
    id: "indoor-elevator",
    type: "circle",
    source: "indoor",
    minzoom: 16,
    filter: BASE_FILTER["indoor-elevator"],
    paint: {
      "circle-radius": 6,
      "circle-color": "#059669",
      "circle-stroke-color": halo,
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "entrance",
    type: "circle",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: ["==", ["get", "kind"], "entrance"],
    paint: {
      "circle-radius": 10,
      "circle-color": "#ff6319",
      "circle-stroke-color": halo,
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "entrance-label",
    type: "symbol",
    source: "indoor",
    minzoom: INDOOR_ZOOM,
    filter: ["==", ["get", "kind"], "entrance"],
    layout: {
      "text-field": ["coalesce", ["get", "ref"], "M"],
      "text-font": FONT_BOLD,
      "text-size": 12,
      "text-allow-overlap": true,
    },
    paint: { "text-color": "#ffffff" },
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
}

export function MapView({ itinerary, guides, from, to, focus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(0);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const index = useStationIndex();
  const [nearby, setNearby] = useState<StationData[]>([]);
  const [level, setLevel] = useState(0);
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
      void Promise.all(near.map((s) => loadStation(s.id).catch(() => undefined))).then((list) => {
        // A slower, older load must not replace the stations of the current view.
        if (live && request === latest) setNearby(list.filter((s): s is StationData => !!s));
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
      features: shown.flatMap((s) => s.indoor.features),
    } as GeoJSON.FeatureCollection);
  }, [shown, ready]);

  // Level filter and the underground shade.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter = levelFilter(level);
    for (const [id, base] of Object.entries(BASE_FILTER)) {
      map.setFilter(id, ["all", base, filter] as maplibregl.FilterSpecification);
    }
    const underground = level < 0 && levels.length > 0;
    map.setLayoutProperty("underground-dim", "visibility", underground ? "visible" : "none");
    // Street-level labels and icons clutter an underground floor.
    for (const layer of map.getStyle().layers) {
      if (layer.type === "symbol" && !OUR_LAYERS.has(layer.id)) {
        map.setLayoutProperty(layer.id, "visibility", underground ? "none" : "visible");
      }
    }
    map.setPaintProperty("metro-lines", "line-opacity", underground ? 0.9 : 0.55);
  }, [level, ready, levels.length]);

  // Itinerary and in-station paths.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const features: GeoJSON.Feature[] = (itinerary?.legs ?? []).map((leg) => ({
      type: "Feature",
      properties: { mode: leg.mode, color: modeColor(leg.mode) },
      geometry: { type: "LineString", coordinates: legLine(leg) },
    }));
    (map.getSource("route") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features,
    });
    const paths: GeoJSON.Feature[] = guides
      .flatMap((g) => [g.board, g.alight])
      .filter((g) => !!g)
      .flatMap((g) => {
        // Split the path by level so each part can show on its own level.
        const parts: { level: number | null; coords: LngLat[] }[] = [];
        for (const [lng, lat, lv] of g.path.line) {
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
  }, [itinerary, guides, from, to, ready, level]);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? 17.5, duration: 800 });
    if (focus.level !== undefined) setLevel(focus.level);
  }, [focus]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {levels.length > 1 && (
        <div
          className="absolute top-40 right-2.5 z-10 flex max-h-[38svh] flex-col overflow-y-auto rounded-md border bg-background/95 shadow-md md:top-32"
          role="radiogroup"
          aria-label="Floor"
        >
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === level}
              aria-label={levelName(l)}
              onClick={() => setLevel(l)}
              className={`h-9 w-9 text-sm font-medium tabular-nums pointer-coarse:h-11 pointer-coarse:w-11 ${
                l === level ? "bg-[#ff6319] text-white" : "hover:bg-muted"
              }`}
            >
              {l === 0 ? "S" : l > 0 ? l : `−${-l}`}
            </button>
          ))}
        </div>
      )}
      {level < 0 && levels.length > 0 && (
        <div className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-xs text-white md:top-3">
          Underground · {levelName(level)}
        </div>
      )}
    </div>
  );
}
