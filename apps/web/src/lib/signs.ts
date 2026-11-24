/**
 * Sign text for station exits. OSM has no sign data, so the builder labels each exit with the
 * street it opens onto and the named building or shopping centre it leads into.
 */
import { distance } from "./geo";
import type { LngLat } from "./station-types";

export interface NamedArea {
  name: string;
  rings: LngLat[][];
}

type Tags = Record<string, string>;
interface Way {
  id: number;
  nodes: number[];
  tags?: Tags;
}
interface Relation {
  id: number;
  members?: { type: string; ref: number; role: string }[];
  tags?: Tags;
}

const STREETS = new Set([
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "pedestrian",
  "service",
]);

const nameOf = (t: Tags | undefined) => t?.["name:en"] ?? t?.name;

/** A building, mall or square that people would recognise on a sign. */
function isPlace(t: Tags | undefined): boolean {
  if (!t || !nameOf(t)) return false;
  // Station names and floor names are not useful on an exit sign.
  if (/metro|\(M\)|station$|\blevel\b|kerros/i.test(nameOf(t) ?? "")) return false;
  return (
    t.shop === "mall" ||
    t.building !== undefined ||
    t.amenity === "bus_station" ||
    t.place === "square" ||
    t.highway === "pedestrian"
  );
}

/** Join way segments into closed rings (multipolygon outers). */
function joinRings(segments: LngLat[][]): LngLat[][] {
  const rings: LngLat[][] = [];
  const open = segments.map((s) => [...s]);
  const same = (a?: LngLat, b?: LngLat) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  while (open.length > 0) {
    let ring = open.pop() as LngLat[];
    let grown = true;
    while (!same(ring[0], ring.at(-1)) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i] as LngLat[];
        if (same(ring.at(-1), s[0])) ring = ring.concat(s.slice(1));
        else if (same(ring.at(-1), s.at(-1))) ring = ring.concat([...s].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (same(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

export function namedAreas(
  ways: Way[],
  relations: Relation[],
  ll: (id: number) => LngLat | undefined,
): NamedArea[] {
  const coords = (w: Way) => w.nodes.map(ll).filter((p): p is LngLat => !!p);
  const out: NamedArea[] = [];
  for (const w of ways) {
    if (!isPlace(w.tags) || w.nodes[0] !== w.nodes.at(-1)) continue;
    const ring = coords(w);
    if (ring.length >= 4) out.push({ name: nameOf(w.tags) as string, rings: [ring] });
  }
  const byId = new Map(ways.map((w) => [w.id, w]));
  for (const r of relations) {
    if (r.tags?.type !== "multipolygon" || !isPlace(r.tags)) continue;
    const outers = (r.members ?? [])
      .filter((m) => m.type === "way" && m.role !== "inner")
      .map((m) => byId.get(m.ref))
      .filter((w): w is Way => !!w)
      .map(coords);
    const rings = joinRings(outers);
    if (rings.length > 0) out.push({ name: nameOf(r.tags) as string, rings });
  }
  return out;
}

export function inside(p: LngLat, area: NamedArea): boolean {
  let hit = false;
  for (const ring of area.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as LngLat;
      const [xj, yj] = ring[j] as LngLat;
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** Distance from p to the segment a-b in meters (local flat approximation). */
function toSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k;
  const ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k;
  const by = b[1] - p[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy) * 111_320;
}

/** The nearest named street within `max` meters. */
export function nearestStreet(
  p: LngLat,
  ways: Way[],
  ll: (id: number) => LngLat | undefined,
  max = 60,
): string | undefined {
  let best: string | undefined;
  let bestD = max;
  for (const w of ways) {
    const t = w.tags;
    if (!t?.highway || !STREETS.has(t.highway) || !nameOf(t)) continue;
    const pts = w.nodes.map(ll);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b) continue;
      const d = toSegment(p, a, b);
      if (d < bestD) {
        bestD = d;
        best = nameOf(t);
      }
    }
  }
  return best;
}

/** The named area that contains p, or whose edge is within `max` meters of it. */
export function areaAt(p: LngLat, areas: NamedArea[], max = 15): string | undefined {
  const containing = areas.filter((a) => inside(p, a));
  // The smallest containing area is the most specific one (a mall inside a block).
  const size = (a: NamedArea) => a.rings.reduce((s, r) => s + r.length, 0);
  if (containing.length > 0) return containing.toSorted((a, b) => size(a) - size(b))[0]?.name;
  for (const a of areas) {
    for (const ring of a.rings) if (ring.some((q) => distance(p, q) < max)) return a.name;
  }
  return undefined;
}

/** Named areas a path passes through, in walking order, at most `limit`. */
export function areasAlong(line: LngLat[], areas: NamedArea[], limit = 2): string[] {
  const out: string[] = [];
  for (const p of line) {
    const name = areas.find((a) => inside(p, a))?.name;
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}
