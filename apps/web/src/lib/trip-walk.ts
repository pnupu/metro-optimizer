/**
 * The whole trip as one step-by-step sequence for the map: street walks (from the routing
 * engine's turn-by-turn steps), each station path floor by floor, and every ride.
 */
import { cumulative, decodePolyline, distance } from "./geo";
import { MODE_NAME, time } from "./format";
import type { MetroGuide, StationGuide, WalkItem } from "./guidance";
import { legLine, walkthrough } from "./guidance";
import type { LngLat } from "./station-types";
import type { Itinerary, Leg, Place } from "./transitous";

/** Modes that have stops and a vehicle to board. */
const TRANSIT = new Set([
  "SUBWAY",
  "BUS",
  "REGIONAL_BUS",
  "COACH",
  "TRAM",
  "RAIL",
  "REGIONAL_RAIL",
  "SUBURBAN",
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "FERRY",
  "FUNICULAR",
  "AERIAL_LIFT",
]);

export interface TripWalk {
  items: WalkItem[];
  /** Index of the first item of each station path, so a station card can open the walk there. */
  starts: Map<StationGuide, number>;
}

interface Chunk {
  street: string;
  /** The routing engine's floor for this part of the walk. */
  level: number;
  points: LngLat[];
}

/** Turn-by-turn steps merged by street; very short steps join their neighbour. */
function streetChunks(leg: Leg): Chunk[] {
  const chunks: Chunk[] = [];
  for (const st of leg.steps ?? []) {
    const pts = st.polyline ? decodePolyline(st.polyline.points, st.polyline.precision) : [];
    if (pts.length === 0) continue;
    const level = st.fromLevel === st.toLevel ? st.fromLevel : 0;
    const last = chunks.at(-1);
    if (last && (last.street === st.streetName || st.distance < 15) && last.level === level) {
      last.points.push(...pts.slice(1));
    } else chunks.push({ street: st.streetName, level, points: pts });
  }
  return chunks.length > 0 ? chunks : [{ street: "", level: 0, points: legLine(leg) }];
}

/**
 * Fold pieces under 20 m into the piece before them (the first one into the next): a step bar
 * of "Walk 5 m" items helps no one.
 */
function mergeShort(chunks: Chunk[]): Chunk[] {
  const length = (c: Chunk) => cumulative(c.points).at(-1) ?? 0;
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const last = merged.at(-1);
    if (last && (length(c) < 20 || length(last) < 20)) {
      if (length(c) > length(last)) {
        last.street = c.street;
        last.level = c.level;
      }
      last.points.push(...c.points.slice(1));
    } else merged.push({ ...c, points: [...c.points] });
  }
  return merged;
}

/** Keep only the part of the walk between `from` and `to` (exit and entrance points). */
export function cut(chunks: Chunk[], from?: LngLat, to?: LngLat): Chunk[] {
  const flat = chunks.flatMap((c, ci) => c.points.map((p) => ({ p, ci })));
  if (flat.length === 0) return [];
  const nearest = (target: LngLat) => {
    let best = 0;
    flat.forEach((x, k) => {
      if (distance(x.p, target) < distance((flat[best] as { p: LngLat }).p, target)) best = k;
    });
    return best;
  };
  // Both ends are found on the same, uncut line, so they cannot cross.
  const start = from ? nearest(from) : 0;
  const end = to ? nearest(to) : flat.length - 1;
  if (start > end) {
    // Exit and entrance meet before the walk's own line does: walk straight across.
    const c = chunks[flat[end]?.ci ?? 0] as Chunk;
    return from && to ? [{ ...c, points: [from, to] }] : [];
  }
  const out: (Chunk & { ci: number })[] = [];
  for (let k = start; k <= end; k++) {
    const x = flat[k] as { p: LngLat; ci: number };
    const last = out.at(-1);
    if (last && last.ci === x.ci) last.points.push(x.p);
    else {
      const prev = last?.points.at(-1);
      const src = chunks[x.ci] as Chunk;
      out.push({ ...src, ci: x.ci, points: prev ? [prev, x.p] : [x.p] });
    }
  }
  if (from) out[0]?.points.unshift(from);
  if (to) out.at(-1)?.points.push(to);
  return out
    .map(({ street, level, points }) => ({ street, level, points }))
    .filter((c) => c.points.length > 1);
}

const meters = (pts: LngLat[]) => Math.max(5, Math.round((cumulative(pts).at(-1) ?? 0) / 5) * 5);

function streetItems(chunks: Chunk[], goal: string): WalkItem[] {
  return chunks.map((c, i) => ({
    text: `Walk ${meters(c.points)} m${c.street ? ` along ${c.street}` : ""}${i === chunks.length - 1 ? ` to ${goal}` : ""}`,
    level: c.level,
    points: c.points,
    kind: "street",
  }));
}

/** A street walk next to a guided station, cut at the exit and entrance the app chose. */
export function walkGeometry(leg: Leg, exit?: LngLat, entrance?: LngLat): LngLat[] {
  return cut(streetChunks(leg), exit, entrance).flatMap((c, i) =>
    i === 0 ? c.points : c.points.slice(1),
  );
}

export function tripWalkthrough(
  itinerary: Itinerary,
  guides: MetroGuide[],
  nameOf: (p: Place) => string,
): TripWalk {
  const byLeg = new Map(guides.map((g) => [g.legIndex, g]));
  const items: WalkItem[] = [];
  const starts = new Map<StationGuide, number>();
  const legs = itinerary.legs;
  const lastLeg = legs.length - 1;

  legs.forEach((leg, i) => {
    if (!TRANSIT.has(leg.mode)) {
      if (leg.mode !== "WALK") {
        // Bike, car or other street travel: one item, no "board" or "stops".
        items.push({
          text: `${leg.mode.charAt(0)}${leg.mode.slice(1).toLowerCase()} to ${i === lastLeg ? "your destination" : nameOf(leg.to)}`,
          level: 0,
          points: legLine(leg),
          kind: "street",
        });
        return;
      }
      const before = byLeg.get(i - 1);
      const after = byLeg.get(i + 1);
      // The station path already goes indoors to (or from) the shop: no street walk.
      if (before?.alight?.poi || after?.board?.poi) return;
      const exit = before?.alight?.entrance;
      const entrance = after?.board?.entrance;
      const chunks = mergeShort(
        cut(
          streetChunks(leg),
          exit ? [exit.lng, exit.lat] : undefined,
          entrance ? [entrance.lng, entrance.lat] : undefined,
        ),
      );
      const goal = entrance
        ? entrance.ref
          ? `entrance ${entrance.ref}`
          : entrance.street
            ? `the entrance at ${entrance.street}`
            : "the station entrance"
        : i === lastLeg
          ? "your destination"
          : nameOf(leg.to);
      items.push(...streetItems(chunks, goal));
      return;
    }

    const metro = byLeg.get(i);
    const mode = MODE_NAME[leg.mode]?.toLowerCase() ?? "";
    const line = leg.routeShortName ?? leg.displayName;
    // "metro M1", or just "bus" when the leg has no line name.
    const name = [mode, line].filter(Boolean).join(" ");
    const toward = leg.headsign ? ` toward ${leg.headsign}` : "";
    if (metro?.board) {
      starts.set(metro.board, items.length);
      items.push(...walkthrough(metro.board, metro.trainEnd, leg.headsign));
    } else {
      const change = legs[i - 1]?.mode === "SUBWAY" ? "Change to" : "Board";
      items.push({
        text: `${change} ${name}${toward} at ${nameOf(leg.from)} (${time(leg.startTime)})`,
        level: leg.mode === "SUBWAY" ? null : 0,
        points: [[leg.from.lon, leg.from.lat]],
        kind: "board",
      });
    }
    const stops = (leg.intermediateStops?.length ?? 0) + 1;
    const sit = metro?.trainEnd ? ` Stay near the ${metro.trainEnd} of the train.` : "";
    items.push({
      text: `Ride ${name}${toward} for ${stops} stop${stops === 1 ? "" : "s"}; get off at ${nameOf(leg.to)} (${time(leg.endTime)}).${sit}`,
      // Keep the floor shown: the whole line is in view, below the indoor-map zoom.
      level: null,
      points: legLine(leg),
      kind: "ride",
    });
    if (metro?.alight) {
      starts.set(metro.alight, items.length);
      items.push(...walkthrough(metro.alight, metro.trainEnd));
    }
  });

  const end = legs[lastLeg]?.to;
  // A path that ends at a shop already says "Arrive at …": add the time to it.
  const lastItem = items.at(-1);
  if (lastItem?.kind === "arrive") lastItem.text = `${lastItem.text} (${time(itinerary.endTime)})`;
  else if (end) {
    items.push({
      text: `Arrive at your destination (${time(itinerary.endTime)})`,
      level: 0,
      points: [[end.lon, end.lat]],
      kind: "arrive",
    });
  }
  return { items, starts };
}
