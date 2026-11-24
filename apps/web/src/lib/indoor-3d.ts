/**
 * Shapes for the 3D view of multi-floor indoor maps. MapLibre raises only polygons
 * (fill-extrusion), so walkways and the path become narrow strips, and stairs, escalators and
 * lifts become columns between their floors.
 */
import type { IndoorFeature, LngLat, PathVertex, StationData } from "./station-types";

/** Height of one floor in the 3D view, metres (a little more than real, to see between). */
export const FLOOR_HEIGHT = 6;
const SLAB = 0.6;

export interface Shape3d {
  type: "Feature";
  properties: { color: string; base: number; top: number };
  geometry: { type: "Polygon"; coordinates: LngLat[][] };
}

/** The part of the path the walkthrough shows now, drawn in yellow on its floor. */
export interface Active3d {
  points: LngLat[];
  level: number | null;
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
  floor: dark ? "#64748b" : "#e2e8f0",
  floorDim: dark ? "#273449" : "#cbd5e1",
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

/** Indoor levels below this are data errors (or the building marker's -99). */
const MIN_LEVEL = -20;

/**
 * The lowest floor among the features and path vertices. Pass a value computed from the route's
 * stations to keep the floors still while the map pans past other stations.
 */
export function lowestFloor(stations: StationData[], paths: PathVertex[][]): number {
  let low = 0;
  for (const s of stations) {
    for (const f of s.indoor.features) {
      const l = f.properties.lmin;
      if (l >= MIN_LEVEL && Number.isInteger(l) && l < low) low = l;
    }
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
): { type: "FeatureCollection"; features: Shape3d[] } {
  const c = palette(dark);
  const features = stations.flatMap((s) => s.indoor.features);
  // Floors float above the street map: the lowest floor sits one floor above the ground.
  const z = (level: number) => (level - lowest + 1) * FLOOR_HEIGHT;
  const out: Shape3d[] = [];
  const slab = (ring: LngLat[], color: string, level: number) =>
    out.push(shape(ring, color, z(level), z(level) + SLAB));

  // Cut-away: floors above the current one would hide it, so they are left out, and columns
  // stop one floor above it. The path is always drawn.
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
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as LngLat;
        const b = pts[i] as LngLat;
        if (vertical) {
          const color = kind === "stairs" ? c.stairs : kind === "escalator" ? c.escalator : c.lift;
          out.push(shape(strip(a, b, 2), color, z(lmin), z(lmax) + SLAB));
        } else if (kind === "footway" || kind === "platform") {
          slab(
            strip(a, b, kind === "platform" ? 4 : 3),
            kind === "platform" ? c.platform : lmin === current ? c.floor : c.floorDim,
            lmin,
          );
        }
      }
    } else if (kind === "elevator") {
      out.push(shape(square(g.coordinates, 2.5), c.lift, z(lmin), z(lmax) + SLAB));
    }
  }

  // The path: a strip on each floor, and a column where it changes floor.
  for (const line of paths) {
    for (let i = 1; i < line.length; i++) {
      const [alng, alat, al] = line[i - 1] as PathVertex;
      const [blng, blat, bl] = line[i] as PathVertex;
      const la = al ?? bl ?? 0;
      const lb = bl ?? al ?? 0;
      if (la === lb) {
        out.push(
          shape(strip([alng, alat], [blng, blat], 1.6), c.path, z(la) + SLAB, z(la) + SLAB + 0.5),
        );
      } else {
        // A floor change: the run along the lower floor, then a column to the other floor.
        const low = Math.min(la, lb);
        out.push(
          shape(strip([alng, alat], [blng, blat], 1.6), c.path, z(low) + SLAB, z(low) + SLAB + 0.5),
        );
        out.push(
          shape(square([blng, blat], 2.2), c.path, z(low), z(Math.max(la, lb)) + SLAB + 0.5),
        );
      }
    }
  }
  if (active && active.points.length > 0) {
    const level = active.level ?? current;
    const top = z(level) + SLAB;
    if (active.points.length === 1) {
      out.push(shape(square(active.points[0] as LngLat, 4), c.active, top, top + 1.5));
    }
    for (let i = 1; i < active.points.length; i++) {
      out.push(
        shape(
          strip(active.points[i - 1] as LngLat, active.points[i] as LngLat, 2.4),
          c.active,
          top,
          top + 0.9,
        ),
      );
    }
  }
  return { type: "FeatureCollection", features: out };
}
