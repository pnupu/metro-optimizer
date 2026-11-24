/**
 * Station guidance for the metro legs of an itinerary: which entrance or exit to use, how to
 * get between the street and the platform, and which end of the train to board.
 */
import { angleBetween, bearing, cumulative, decodePolyline, distance } from "./geo";
import type { Leg, Place } from "./transitous";
import { gtfsId } from "./transitous";
import type {
  Entrance,
  LngLat,
  PathStep,
  Platform,
  Profile,
  StationData,
  StationPath,
} from "./station-types";

export type TrainEnd = "front" | "middle" | "back";

export interface StationGuide {
  station: StationData;
  platform: Platform;
  entrance: Entrance;
  path: StationPath;
  /** Steps in walking order (reversed for an exit). */
  steps: PathStep[];
  /** Where the path meets the platform, 0 = back of the train, 1 = front. */
  trainPosition: number;
  /** The profile asked for. */
  profile: Profile;
  /** True when the path for the chosen profile was missing and the fastest path is shown. */
  fallback: boolean;
  /** True when a level change on the path is not described in OSM. */
  uncertain: boolean;
  /** True when the train runs from the platform axis start toward its end. */
  alongAxis: boolean;
}

export interface MetroGuide {
  legIndex: number;
  board?: StationGuide;
  alight?: StationGuide;
  /** The end of the train nearest the exit you need; undefined when there is no exit to aim for. */
  trainEnd?: TrainEnd;
  /** Where you reach the boarding platform. */
  boardEnd?: TrainEnd;
}

export type StationLookup = (id: string) => StationData | undefined;

const WALK_SPEED = 1.3;
/** Street paths wind; straight-line distance times this is a fair walking estimate. */
const DETOUR = 1.3;

export function endOf(position: number): TrainEnd {
  if (position >= 0.6) return "front";
  if (position <= 0.4) return "back";
  return "middle";
}

/** Bearing of travel near the start or the end of a line, measured over about 60 m. */
export function travelBearing(line: LngLat[], at: "start" | "end"): number | undefined {
  if (line.length < 2) return undefined;
  const pts = at === "start" ? line : [...line].reverse();
  const first = pts[0] as LngLat;
  let far = pts[1] as LngLat;
  for (const p of pts) {
    far = p;
    if (distance(first, p) >= 60) break;
  }
  const b = bearing(first, far);
  return at === "start" ? b : (b + 180) % 360;
}

/** Convert a platform axis position (0..1) into a train position (0 = back, 1 = front). */
export function trainPosition(platform: Platform, travel: number, position: number): number {
  const axis = bearing(platform.axis[0], platform.axis[1]);
  return angleBetween(axis, travel) <= 90 ? position : 1 - position;
}

/**
 * Pick the entrance with the lowest total time: street walk (along the itinerary's walk line,
 * then straight to the entrance) plus the in-station path.
 */
export function chooseEntrance(
  station: StationData,
  platformCode: string,
  profile: Profile,
  walkLine: LngLat[],
  direction: "in" | "out",
): { path: StationPath; fallback: boolean } | undefined {
  let candidates = station.paths.filter(
    (p) => p.platform === platformCode && p.profile === profile,
  );
  let fallback = false;
  if (candidates.length === 0) {
    candidates = station.paths.filter(
      (p) => p.platform === platformCode && p.profile === "fastest",
    );
    fallback = candidates.length > 0 && profile !== "fastest";
  }
  if (candidates.length === 0) return undefined;
  const line = direction === "in" ? walkLine : [...walkLine].reverse();
  const along = cumulative(line);
  const entrances = new Map(station.entrances.map((e) => [e.id, e]));
  let best: StationPath | undefined;
  let bestCost = Infinity;
  for (const p of candidates) {
    const e = entrances.get(p.entrance);
    if (!e) continue;
    let street = 0;
    if (line.length > 0) {
      street = Infinity;
      line.forEach((v, i) => {
        street = Math.min(street, (along[i] ?? 0) + DETOUR * distance(v, [e.lng, e.lat]));
      });
    }
    const cost = street / WALK_SPEED + p.seconds;
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  return best ? { path: best, fallback } : undefined;
}

/** Steps of a path walked from the platform to the entrance. */
export function reverseSteps(steps: PathStep[]): PathStep[] {
  return [...steps].reverse().map((s) => ({ ...s, fromLevel: s.toLevel, toLevel: s.fromLevel }));
}

function guideFor(
  station: StationData,
  place: Place,
  profile: Profile,
  walkLine: LngLat[],
  direction: "in" | "out",
  travel: number | undefined,
): StationGuide | undefined {
  // Each direction has its own platform: never guess, a wrong one flips the train end.
  const platform =
    station.platforms.find((p) => p.stopId === gtfsId(place.stopId)) ??
    station.platforms.find((p) => p.code === place.stopCode);
  if (!platform) return undefined;
  const choice = chooseEntrance(station, platform.code, profile, walkLine, direction);
  if (!choice) return undefined;
  const entrance = station.entrances.find((e) => e.id === choice.path.entrance);
  if (!entrance) return undefined;
  const steps = direction === "in" ? choice.path.steps : reverseSteps(choice.path.steps);
  return {
    station,
    platform,
    entrance,
    path: choice.path,
    steps,
    trainPosition:
      travel === undefined ? 0.5 : trainPosition(platform, travel, choice.path.position),
    alongAxis:
      travel === undefined ||
      angleBetween(bearing(platform.axis[0], platform.axis[1]), travel) <= 90,
    profile,
    fallback: choice.fallback,
    uncertain: steps.some((s) => s.mode === "level"),
  };
}

/** Where on the platform a train end stops: a point on the platform axis. */
export function trainEndPoint(guide: StationGuide, end: TrainEnd): LngLat {
  const t = end === "front" ? 0.85 : end === "back" ? 0.15 : 0.5;
  const f = guide.alongAxis ? t : 1 - t;
  const [a, b] = guide.platform.axis;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Line of a leg as [lng, lat] points. */
export const legLine = (leg: Leg): LngLat[] =>
  decodePolyline(leg.legGeometry.points, leg.legGeometry.precision);

export function guideItinerary(legs: Leg[], profile: Profile, lookup: StationLookup): MetroGuide[] {
  const guides: MetroGuide[] = [];
  legs.forEach((leg, i) => {
    if (leg.mode !== "SUBWAY") return;
    const line = legLine(leg);
    const before = legs[i - 1];
    const after = legs[i + 1];
    const guide: MetroGuide = { legIndex: i };

    const boardStation = lookup(gtfsId(leg.from.parentId) ?? "");
    if (boardStation && before?.mode !== "SUBWAY") {
      // Street side: the walk to the station, else the stop where the previous ride ends.
      const arrive = before ? before.to : leg.from;
      const walk = before?.mode === "WALK" ? legLine(before) : [[arrive.lon, arrive.lat] as LngLat];
      const g = guideFor(boardStation, leg.from, profile, walk, "in", travelBearing(line, "start"));
      if (g) {
        guide.board = g;
        guide.boardEnd = endOf(g.trainPosition);
      }
    }
    const alightStation = lookup(gtfsId(leg.to.parentId) ?? "");
    if (alightStation && after?.mode !== "SUBWAY") {
      const leave = after ? after.from : leg.to;
      const walk = after?.mode === "WALK" ? legLine(after) : [[leave.lon, leave.lat] as LngLat];
      const g = guideFor(alightStation, leg.to, profile, walk, "out", travelBearing(line, "end"));
      if (g) {
        guide.alight = g;
        guide.trainEnd = endOf(g.trainPosition);
      }
    }
    guides.push(guide);
  });
  return guides;
}

export function levelName(level: number | null): string {
  if (level === null) return "another level";
  if (level === 0) return "street level";
  return `level ${level > 0 ? level : `−${Math.abs(level)}`}`;
}

/** One plain sentence for a path step. */
export function describeStep(s: PathStep): string {
  const up = s.fromLevel !== null && s.toLevel !== null && s.toLevel > s.fromLevel;
  const dir = s.fromLevel === s.toLevel ? "" : up ? " up" : " down";
  const to = levelName(s.toLevel);
  switch (s.mode) {
    case "walk":
      return `Walk ${Math.max(5, Math.round(s.meters / 5) * 5)} m`;
    case "stairs":
      return `Take the stairs${dir} to ${to}`;
    case "escalator":
      return `Take the escalator${dir} to ${to}`;
    case "elevator":
      return `Take the elevator${dir} to ${to}`;
    case "level":
      return `Go${dir} to ${to} (the map does not show how)`;
  }
}

/**
 * What the station signs say: HSL letters every exit and the signs list the street or building.
 * `short` fits in "Follow signs for …".
 */
export function exitSign(
  e: Entrance,
  direction: "in" | "out",
): { title: string; short: string; where?: string; signs: string[] } {
  const word = direction === "in" ? "Entrance" : "Exit";
  // An unlettered exit is already titled by its street: do not say the street twice.
  const where = [e.ref ? e.street : undefined, e.place].filter(Boolean).join(" · ") || undefined;
  const signs = e.signs ?? [];
  const title = e.ref
    ? `${word} ${e.ref}`
    : e.street
      ? `${word} at ${e.street}`
      : `Unlettered ${word.toLowerCase()}`;
  // The station's own sign text is best; else the street the exit opens onto.
  const hint = signs.length > 0 ? signs.slice(0, 2).join(", ") : e.street;
  const short = e.ref
    ? `exit ${e.ref}${hint ? ` (${hint})` : ""}`
    : e.street
      ? `the exit to ${e.street}`
      : "the exit";
  return { title, short, signs, ...(where ? { where } : {}) };
}

/** "entrance B", or "the exit" when the entrance has no letter. */
export const entranceShort = (e: Entrance) => (e.ref ? `exit ${e.ref}` : "the exit");
