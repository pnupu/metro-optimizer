/**
 * Shapes for the 3D view of multi-floor indoor maps. MapLibre raises only polygons
 * (fill-extrusion), so walkways and the path become narrow strips, and stairs, escalators and
 * lifts become columns between their floors.
 */
import type { Entrance, IndoorFeature, LngLat, PathVertex, StationData } from "./station-types";

/** Height of one floor in the 3D view, metres (a little more than real, to see between). */
export const FLOOR_HEIGHT = 8;
const SLAB = 0.6;
export const STREET_LINK = "#0e7490";

export const floorHeight = (level: number, lowest: number) => (level - lowest + 1) * FLOOR_HEIGHT;

export const floorNumber = (level: number) => (level < 0 ? `−${-level}` : String(level));

export interface Shape3d {
  type: "Feature";
  properties: { color: string; base: number; top: number };
  geometry: { type: "Polygon"; coordinates: LngLat[][] };
}

/** The part of the path the walkthrough shows now, drawn in yellow on its floor. */
export interface Active3d {
  points: LngLat[];
  level: number | null;
  /** The real elevations of a walkthrough step that changes floor. */
  line?: PathVertex[];
}

interface Palette {
  floor: string;
  floorDim: string;
  room: string;
  roomDim: string;
  platform: string;
  platformDim: string;
  stairs: string;
  escalator: string;
  lift: string;
  path: string;
  active: string;
}

export const palette = (dark: boolean): Palette => ({
  floor: dark ? "#8299b4" : "#eef5ff",
  floorDim: dark ? "#344054" : "#cbd5e1",
  room: dark ? "#8a7350" : "#fbe7cc",
  roomDim: dark ? "#4a3f2e" : "#e7dccb",
  platform: "#ffb38f",
  platformDim: dark ? "#8a5a44" : "#f1c9b5",
  stairs: "#7c3aed",
  escalator: "#2563eb",
  lift: "#059669",
  path: "#ff6319",
  active: "#facc15",
});

/** A rectangle of `width` metres around the segment a→b. */
export function strip(a: LngLat, b: LngLat, width: number): LngLat[] {
  const k = Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1e-9;
  // Half the width as a perpendicular, back in degrees.
  const half = width / 2 / 111_320;
  const px = (-dy / len) * half;
  const py = (dx / len) * half;
  const ox = px / k;
  return [
    [a[0] + ox, a[1] + py],
    [b[0] + ox, b[1] + py],
    [b[0] - ox, b[1] - py],
    [a[0] - ox, a[1] - py],
    [a[0] + ox, a[1] + py],
  ];
}

/** A square of `size` metres around a point. */
function square(p: LngLat, size: number): LngLat[] {
  const h = size / 2 / 111_320;
  const w = h / Math.cos((p[1] * Math.PI) / 180);
  return [
    [p[0] - w, p[1] - h],
    [p[0] + w, p[1] - h],
    [p[0] + w, p[1] + h],
    [p[0] - w, p[1] + h],
    [p[0] - w, p[1] - h],
  ];
}

const shape = (ring: LngLat[], color: string, base: number, top: number): Shape3d => ({
  type: "Feature",
  properties: { color, base, top },
  geometry: { type: "Polygon", coordinates: [ring] },
});

function lineCenter(points: LngLat[]): LngLat | undefined {
  const middle = Math.floor(points.length / 2);
  const a = points[middle];
  const b = points[middle - 1];
  if (!a || !b || points.length % 2 !== 0) return a;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Indoor levels below this are data errors (or the building marker's -99). */
const MIN_LEVEL = -20;

/** An entrance on OSM level zero, an explicit street lift, or a route's street handoff. */
function streetLanding(entrance: Entrance, current: number, used: boolean): number | null {
  const { level, liftTo } = entrance;
  const landing = used ? (liftTo ?? level) : liftTo === 0 || level === 0 ? 0 : null;
  if (landing !== null && landing <= current) return landing;
  return liftTo === 0 && level !== null && level <= current ? level : null;
}

/**
 * The lowest floor among the features and path vertices. Pass a value computed from the route's
 * stations to keep the floors still while the map pans past other stations.
 */
export function lowestFloor(stations: StationData[], paths: PathVertex[][]): number {
  let low = 0;
  for (const s of stations) {
    for (const f of s.indoor.features) {
      const l = f.properties.lmin;
      if (l >= MIN_LEVEL && l < low) low = l;
    }
    for (const { level, liftTo } of s.entrances)
      for (const l of [level, liftTo]) if (l != null && l >= MIN_LEVEL && l < low) low = l;
  }
  for (const line of paths)
    for (const v of line) if (v[2] !== null && v[2] >= MIN_LEVEL && v[2] < low) low = v[2];
  return low;
}

export function build3d(
  stations: StationData[],
  paths: PathVertex[][],
  current: number,
  dark: boolean,
  active?: Active3d,
  /** The floor that sits one floor above the ground; see `lowestFloor`. */
  lowest = lowestFloor(stations, paths),
  streetEntrances: ReadonlySet<string> = new Set(),
): { type: "FeatureCollection"; features: Shape3d[] } {
  const c = palette(dark);
  const features = stations.flatMap((s) => s.indoor.features);
  // Floors float above the street map: the lowest floor sits one floor above the ground.
  const z = (level: number) => floorHeight(level, lowest);
  const out: Shape3d[] = [];
  const slab = (ring: LngLat[], color: string, level: number) =>
    out.push(shape(ring, color, z(level), z(level) + SLAB));

  // Cut-away: floors above the current one would hide it, so they are left out, and columns
  // stop one floor above it so the next connection stays visible.
  for (const f of features as IndoorFeature[]) {
    const { kind, lmin } = f.properties;
    if (kind === "building" || lmin < MIN_LEVEL || lmin > current) continue;
    const lmax = Math.min(f.properties.lmax, current + 1);
    const g = f.geometry;
    if (g.type === "Polygon") {
      // Floors below the current one are dimmed, rooms and platforms too.
      const here = lmin === current;
      const color =
        kind === "platform"
          ? here
            ? c.platform
            : c.platformDim
          : kind === "room"
            ? here
              ? c.room
              : c.roomDim
            : here
              ? c.floor
              : c.floorDim;
      // All rings, so courtyards and atriums stay open.
      out.push({
        type: "Feature",
        properties: { color, base: z(lmin), top: z(lmin) + SLAB },
        geometry: { type: "Polygon", coordinates: g.coordinates },
      });
    } else if (g.type === "LineString") {
      const pts = g.coordinates;
      const vertical = kind === "stairs" || kind === "escalator" || kind === "elevator";
      if (!vertical && kind !== "footway" && kind !== "platform") continue;
      const color =
        kind === "stairs"
          ? c.stairs
          : kind === "escalator"
            ? c.escalator
            : kind === "elevator"
              ? c.lift
              : kind === "platform"
                ? lmin === current
                  ? c.platform
                  : c.platformDim
                : lmin === current
                  ? c.floor
                  : c.floorDim;
      // Raising the whole footprint of a long staircase makes it look like a wall.
      // Keep the footprint on its floor and show the connection with a narrow post.
      const anchor = vertical ? lineCenter(pts) : undefined;
      if (anchor && lmax > lmin)
        out.push(shape(square(anchor, 1.8), color, z(lmin), z(lmax) + SLAB));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as LngLat;
        const b = pts[i] as LngLat;
        slab(strip(a, b, vertical ? 2 : kind === "platform" ? 4 : 3), color, lmin);
      }
    } else if (kind === "elevator") {
      out.push(shape(square(g.coordinates, 2.5), c.lift, z(lmin), z(lmax) + SLAB));
    }
  }

  for (const station of stations) {
    for (const entrance of station.entrances) {
      const landing = streetLanding(entrance, current, streetEntrances.has(entrance.id));
      if (landing === null) continue;
      const point: LngLat = [entrance.lng, entrance.lat];
      const used = streetEntrances.has(entrance.id);
      const color = used ? c.path : STREET_LINK;
      out.push(
        shape(square(point, used ? 4 : 2.8), color, 0, 0.7),
        shape(square(point, used ? 1.7 : 1.2), color, 0, z(landing) + SLAB),
      );
    }
  }

  // The path: a strip on each visible floor, and a column where it changes floor.
  const drawPath = (line: PathVertex[], highlighted: boolean) => {
    const width = highlighted ? 2.8 : 1.8;
    const height = highlighted ? 1 : 0.45;
    const run = (a: LngLat, b: LngLat, level: number, color: string) => {
      if (a[0] === b[0] && a[1] === b[1]) return;
      const base = z(level) + SLAB;
      if (highlighted) out.push(shape(strip(a, b, width + 1), "#78350f", base, base + 0.65));
      out.push(shape(strip(a, b, width), color, base, base + height));
    };
    for (let i = 1; i < line.length; i++) {
      const [alng, alat, al] = line[i - 1] as PathVertex;
      const [blng, blat, bl] = line[i] as PathVertex;
      const known = al ?? bl;
      if (known === null) continue;
      const low = Math.min(al ?? known, bl ?? known);
      const high = Math.max(al ?? known, bl ?? known);
      if (low > current) continue;
      const color = highlighted ? c.active : c.path;
      run([alng, alat], [blng, blat], low, color);
      if (low !== high) {
        // Reverse walks still put the column at the upper landing.
        const upper: LngLat = al === high ? [alng, alat] : [blng, blat];
        out.push(
          shape(
            square(upper, width + 0.4),
            color,
            z(low),
            z(Math.min(high, current + 1)) + SLAB + height,
          ),
        );
      }
    }
  };
  for (const line of paths) drawPath(line, false);
  if (active?.level != null && active.level <= current) {
    const { level, points } = active;
    const point = points[0];
    if (points.length === 1 && point) {
      const top = z(level) + SLAB;
      out.push(shape(square(point, 3.8), c.active, top, top + 1.5));
    } else drawPath(active.line ?? points.map(([lng, lat]) => [lng, lat, level]), true);
  }
  return { type: "FeatureCollection", features: out };
}

export interface IndoorLabel3d {
  text: string;
  anchors: LngLat[];
  height: number;
  kind:
    | "floor"
    | "current-floor"
    | "entrance"
    | "street"
    | "route"
    | "origin"
    | "destination"
    | "detail";
}

export interface RoutePin3d {
  text: string;
  point: LngLat;
  level: number | null;
  kind: "route" | "origin" | "destination";
}

const connectionName: Record<string, string> = {
  elevator: "Lift",
  escalator: "Escalator",
  stairs: "Stairs",
};

export function build3dLabels(
  station: StationData,
  paths: PathVertex[][],
  current: number,
  lowest: number,
  pins: RoutePin3d[],
  streetEntrances: ReadonlySet<string>,
  floorNames: ReadonlyMap<number, string>,
): IndoorLabel3d[] {
  const floors = new Map<number, LngLat[]>();
  const remember = (level: number, point: LngLat) => {
    if (level < MIN_LEVEL || level > current) return;
    const anchors = floors.get(level);
    if (!anchors) floors.set(level, [point]);
    else anchors.push(point);
  };
  const height = (level: number) => floorHeight(level, lowest) + SLAB;
  const details: IndoorLabel3d[] = [];
  for (const path of paths)
    for (const [lng, lat, level] of path) if (level !== null) remember(level, [lng, lat]);
  for (const { geometry, properties } of station.indoor.features) {
    const { kind, lmin, lmax, name } = properties;
    if (lmin < MIN_LEVEL || lmin > current || kind === "building" || kind === "track") continue;
    const anchor =
      geometry.type === "Point"
        ? geometry.coordinates
        : lineCenter(
            geometry.type === "Polygon" ? (geometry.coordinates[0] ?? []) : geometry.coordinates,
          );
    if (!anchor) continue;
    remember(lmin, anchor);
    const connection = connectionName[kind];
    if (connection && lmin !== lmax) remember(lmax, anchor);
    const namedDetail =
      name && lmin === current && !pins.some((pin) => pin.level === lmin && pin.text === name);
    if (kind !== "entrance" && (connection || namedDetail)) {
      const level = connection && lmax <= current ? lmax : lmin;
      const text =
        connection && lmin !== lmax
          ? `${connection} ${floorNumber(lmin)}…${floorNumber(lmax)}`
          : (connection ?? name);
      if (text) details.push({ text, anchors: [anchor], height: height(level), kind: "detail" });
    }
  }
  for (const entrance of station.entrances) {
    const used = streetEntrances.has(entrance.id);
    const landing = streetLanding(entrance, current, used);
    const level = landing ?? entrance.level;
    if (level === null || level > current) continue;
    const anchor: LngLat = [entrance.lng, entrance.lat];
    remember(level, anchor);
    if (used && landing !== null) {
      details.push({ text: "Street", anchors: [anchor], height: 0.7, kind: "street" });
    }
    if (
      !used ||
      !pins.some((p) => p.level === level && p.point[0] === anchor[0] && p.point[1] === anchor[1])
    )
      details.push({
        text: entrance.ref ? `Exit ${entrance.ref}` : "Entrance",
        anchors: [anchor],
        height: height(level),
        kind: "entrance",
      });
  }
  return [
    // A pin with no known floor (some platforms have no level in OSM) stays on the current floor,
    // since the flat pins are hidden in 3D.
    ...pins.flatMap(({ level, point, text, kind }) =>
      level === null || level <= current
        ? [{ text, kind, anchors: [point], height: height(level ?? current) }]
        : [],
    ),
    ...Array.from(floors, ([level, anchors]): IndoorLabel3d => ({
      text: floorNames.get(level) ?? floorNumber(level),
      kind: level === current ? "current-floor" : "floor",
      anchors,
      height: height(level),
    })),
    ...details,
  ];
}
