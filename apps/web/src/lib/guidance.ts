/**
 * Station guidance for the metro legs of an itinerary: which entrance or exit to use, how to
 * get between the street and the platform, and which end of the train to board.
 */
import {
  angleBetween,
  bearing,
  cumulative,
  decodePolyline,
  distance,
  projectFraction,
} from "./geo";
import type { Leg, Place } from "./transitous";
import { gtfsId } from "./transitous";
import type {
  Entrance,
  LngLat,
  PathStep,
  PathVertex,
  Platform,
  Profile,
  StationData,
  StationPath,
} from "./station-types";
import { ELEVATOR_SECONDS } from "./station-types";
import { cheapest, type GraphPoi, pathTo, search, type WalkGraph } from "./walk-graph";

export type TrainEnd = "front" | "middle" | "back";

export interface StationGuide {
  station: StationData;
  platform: Platform;
  entrance: Entrance;
  path: StationPath;
  /** Steps in walking order (reversed for an exit); `a`/`b` index into `line`. */
  steps: PathStep[];
  /** The path in walking order. */
  line: PathVertex[];
  direction: "in" | "out";
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
  /** Set when the path goes straight to (or comes from) a shop or place inside the building. */
  poi?: GraphPoi;
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
export function reverseSteps(steps: PathStep[], lineLength: number): PathStep[] {
  const last = lineLength - 1;
  return [...steps].reverse().map((s) => ({
    ...s,
    fromLevel: s.toLevel,
    toLevel: s.fromLevel,
    a: Math.max(0, last - s.b),
    b: Math.max(0, last - s.a),
  }));
}

function entranceLift(station: StationData, id: string) {
  const e = station.entrances.find((x) => x.id === id);
  return e?.liftTo !== undefined && e.level !== null
    ? { top: e.liftTo, bottom: e.level }
    : undefined;
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
  const line = direction === "in" ? choice.path.line : [...choice.path.line].reverse();
  let steps = direction === "in" ? choice.path.steps : reverseSteps(choice.path.steps, line.length);
  const lift = entranceLift(station, choice.path.entrance);
  if (lift) {
    // The entrance itself is a lift: ride it between the street and the path's first floor.
    const at = direction === "in" ? 0 : line.length - 1;
    const ride: PathStep = {
      mode: "elevator",
      fromLevel: direction === "in" ? lift.top : lift.bottom,
      toLevel: direction === "in" ? lift.bottom : lift.top,
      meters: 0,
      seconds: ELEVATOR_SECONDS,
      a: at,
      b: at,
    };
    steps = direction === "in" ? [ride, ...steps] : [...steps, ride];
  }
  return {
    station,
    platform,
    entrance,
    path: choice.path,
    steps,
    line,
    direction,
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

/** Where the trip starts and ends, and the station walking networks loaded so far. */
export interface TripEnds {
  from?: { lat: number; lon: number; label?: string };
  to?: { lat: number; lon: number; label?: string };
  graph: (stationId: string) => WalkGraph | undefined;
}

/**
 * The shop or place a trip end points at, when it lies in a station's walking network: the
 * nearest one with the same name within 35 m, else the nearest street-level one within 12 m (a
 * point on the pavement must not send the rider to a shop on another floor).
 */
export function findPoi(
  graph: WalkGraph,
  end: { lat: number; lon: number; label?: string },
): GraphPoi | undefined {
  const label = end.label?.toLowerCase().trim();
  let named: GraphPoi | undefined;
  let namedD = 35;
  let nearest: GraphPoi | undefined;
  let nearestD = 12;
  for (const p of graph.pois) {
    const d = distance([p.lng, p.lat], [end.lon, end.lat]);
    const same = label && (p.name.toLowerCase() === label || p.local?.toLowerCase() === label);
    if (same && d < namedD) {
      namedD = d;
      named = p;
    }
    if (p.level === 0 && d < nearestD) {
      nearestD = d;
      nearest = p;
    }
  }
  return named ?? nearest;
}

/** An indoor path may cross a few metres with no floor tag (a door, a gap in the data). */
const MAX_OUTDOOR_METERS = 30;
/** Longer "indoor" paths are data errors or another building. */
const MAX_INDOOR_METERS = 650;

/** A path inside the building between the platform and a shop, as a station guide. */
export function guideToPoi(
  station: StationData,
  graph: WalkGraph,
  place: Place,
  poi: GraphPoi,
  profile: Profile,
  direction: "in" | "out",
  travel: number | undefined,
): StationGuide | undefined {
  const platform =
    station.platforms.find((p) => p.stopId === gtfsId(place.stopId)) ??
    station.platforms.find((p) => p.code === place.stopCode);
  const nodes = graph.platforms.find((p) => p.code === platform?.code)?.nodes ?? [];
  if (!platform || nodes.length === 0) return undefined;
  // No indoor path for this profile (step-free, no stairs): use the street route, which can
  // use a lift entrance, rather than show an indoor path with stairs.
  const found = search(graph, direction === "out" ? nodes : [poi.node], profile);
  const target = direction === "out" ? poi.node : cheapest(found, nodes);
  if (target === undefined || !Number.isFinite(found.cost[target] as number)) return undefined;
  const result = pathTo(found, target, direction === "out" ? platform.level : poi.level);
  // Only a path that really stays inside replaces the street walk.
  if (result.outdoorMeters > MAX_OUTDOOR_METERS || result.meters > MAX_INDOOR_METERS)
    return undefined;
  const fallback = false;
  // The search runs from where you start, so the line is already in walking order.
  const line = result.line;
  const touch = (direction === "out" ? line[0] : line.at(-1)) as PathVertex;
  const position = projectFraction([touch[0], touch[1]], ...platform.axis);
  const entrance: Entrance = {
    id: `poi:${poi.node}`,
    name: poi.name,
    lng: poi.lng,
    lat: poi.lat,
    level: poi.level,
  };
  const path: StationPath = {
    entrance: entrance.id,
    platform: platform.code,
    profile,
    meters: Math.round(result.meters),
    seconds: Math.round(result.seconds),
    position,
    steps: result.steps,
    line,
  };
  return {
    station,
    platform,
    entrance,
    path,
    steps: result.steps,
    line,
    direction,
    trainPosition: travel === undefined ? 0.5 : trainPosition(platform, travel, position),
    alongAxis:
      travel === undefined ||
      angleBetween(bearing(platform.axis[0], platform.axis[1]), travel) <= 90,
    profile,
    fallback,
    uncertain: result.steps.some((s) => s.mode === "level"),
    poi,
  };
}

export function guideItinerary(
  legs: Leg[],
  profile: Profile,
  lookup: StationLookup,
  ends?: TripEnds,
): MetroGuide[] {
  const guides: MetroGuide[] = [];
  legs.forEach((leg, i) => {
    if (leg.mode !== "SUBWAY") return;
    const line = legLine(leg);
    const before = legs[i - 1];
    const after = legs[i + 1];
    const guide: MetroGuide = { legIndex: i };

    const boardStation = lookup(gtfsId(leg.from.parentId) ?? "");
    // A trip that starts inside a building joined to the station: walk from the shop indoors.
    const startPoi =
      boardStation && ends?.from && (i === 0 || (i === 1 && before?.mode === "WALK"))
        ? (() => {
            const g = ends.graph(boardStation.id);
            const poi = g && ends.from ? findPoi(g, ends.from) : undefined;
            return g && poi ? { g, poi } : undefined;
          })()
        : undefined;
    const indoorStart = startPoi
      ? guideToPoi(
          boardStation as StationData,
          startPoi.g,
          leg.from,
          startPoi.poi,
          profile,
          "in",
          travelBearing(line, "start"),
        )
      : undefined;
    if (indoorStart) {
      guide.board = indoorStart;
      guide.boardEnd = endOf(indoorStart.trainPosition);
    } else if (boardStation && before?.mode !== "SUBWAY") {
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
    const last = legs.length - 1;
    const endPoi =
      alightStation && ends?.to && (i === last || (i === last - 1 && after?.mode === "WALK"))
        ? (() => {
            const g = ends.graph(alightStation.id);
            const poi = g && ends.to ? findPoi(g, ends.to) : undefined;
            return g && poi ? { g, poi } : undefined;
          })()
        : undefined;
    const indoorEnd = endPoi
      ? guideToPoi(
          alightStation as StationData,
          endPoi.g,
          leg.to,
          endPoi.poi,
          profile,
          "out",
          travelBearing(line, "end"),
        )
      : undefined;
    if (indoorEnd) {
      guide.alight = indoorEnd;
      guide.trainEnd = endOf(indoorEnd.trainPosition);
    } else if (alightStation && after?.mode !== "SUBWAY") {
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
  return describeStepWithFloorName(s, levelName);
}

export function describeStepWithFloorName(s: PathStep, nameOfLevel: typeof levelName): string {
  const up = s.fromLevel !== null && s.toLevel !== null && s.toLevel > s.fromLevel;
  const dir = s.fromLevel === s.toLevel ? "" : up ? " up" : " down";
  const to = nameOfLevel(s.toLevel);
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
  const lift = e.liftTo !== undefined ? " (lift)" : "";
  const title = e.ref
    ? `${word} ${e.ref}${lift}`
    : e.street
      ? `${word} at ${e.street}${lift}`
      : `Unlettered ${word.toLowerCase()}${lift}`;
  // The station's own sign text is best; else the street the exit opens onto.
  const hint = signs.length > 0 ? signs.slice(0, 2).join(", ") : e.street;
  const short = e.ref
    ? `exit ${e.ref}${hint ? ` (${hint})` : ""}`
    : e.street
      ? `the exit to ${e.street}`
      : "the exit";
  return { title, short, signs, ...(where ? { where } : {}) };
}

/** "exit B"; a shop's name for a path that ends at a shop; "the exit" with no letter. */
export const entranceShort = (e: Entrance) =>
  e.id.startsWith("poi:") ? (e.name ?? "your destination") : e.ref ? `exit ${e.ref}` : "the exit";

/** "Dif Döner & Dizza (floor M)". */
export const poiLabel = (p: GraphPoi) =>
  `${p.name} (${p.floor ? `floor ${p.floor}` : levelName(p.level)})`;

/** One stop of the floor-by-floor walkthrough on the map. */
export interface WalkItem {
  text: string;
  /** The floor to show for this item. */
  level: number | null;
  /** The part of the path to show: one point or a line. */
  points: LngLat[];
  kind: "entrance" | "platform" | PathStep["mode"] | "street" | "board" | "ride" | "arrive";
  /** The station and surveyed path used to draw this item in the indoor map. */
  stationId?: string;
  indoorStep?: PathStep;
}

/**
 * The in-station path as a sequence of map views: the entrance or the platform, each step on its
 * own floor, then the platform or the exit.
 */
export function walkthrough(guide: StationGuide, trainEnd?: TrainEnd, toward?: string): WalkItem[] {
  const ll = (v: PathVertex | undefined): LngLat[] => (v ? [[v[0], v[1]]] : []);
  const span = (a: number, b: number) =>
    guide.line.slice(Math.max(0, a), b + 1).map(([lng, lat]) => [lng, lat] as LngLat);
  const sign = exitSign(guide.entrance, guide.direction);
  const entrance: LngLat = [guide.entrance.lng, guide.entrance.lat];
  const platformArrival = guide.direction === "in" ? guide.line.at(-1) : guide.line[0];
  const platformPoints = [
    ...ll(platformArrival),
    ...(trainEnd ? [trainEndPoint(guide, trainEnd)] : []),
  ];
  const level = (s: PathStep) => s.fromLevel ?? s.toLevel;
  const steps: WalkItem[] = guide.steps.map((s) => ({
    text: describeStep(s),
    level: level(s),
    // A floor change is a point in the data: show it with its neighbours for context.
    points: s.mode === "walk" ? span(s.a, s.b) : span(s.a - 1, s.b + 1),
    kind: s.mode,
    indoorStep: s,
  }));
  const platform: WalkItem = {
    text:
      guide.direction === "in"
        ? `Platform (${levelName(guide.platform.level)}): follow signs for trains${toward ? ` toward ${toward}` : ""}${trainEnd && trainEnd !== endOf(guide.trainPosition) ? ` and walk to the ${trainEnd}` : ""}`
        : guide.poi
          ? `Get off at the ${trainEnd ?? "nearest door"}, then head for ${poiLabel(guide.poi)}`
          : `Get off at the ${trainEnd ?? "nearest door"}, then follow signs for ${sign.short}`,
    level: guide.platform.level,
    points: platformPoints,
    kind: "platform",
  };
  const door: WalkItem = guide.poi
    ? {
        text: `${guide.direction === "in" ? "Start at" : "Arrive at"} ${poiLabel(guide.poi)}`,
        level: guide.poi.level,
        points: [entrance],
        kind: guide.direction === "in" ? "entrance" : "arrive",
      }
    : {
        text:
          guide.direction === "in"
            ? `${sign.title}${sign.where ? ` · ${sign.where}` : ""}: go in here`
            : `${sign.title}: you come out at ${sign.where ?? "street level"}`,
        level: guide.entrance.liftTo ?? guide.entrance.level,
        points: [entrance],
        kind: "entrance",
      };
  // Say where each walk leads: the next floor change, the platform, or the exit.
  const target = (next: PathStep | undefined) => {
    if (!next) return guide.direction === "in" ? "the platform" : entranceShort(guide.entrance);
    return {
      stairs: "the stairs",
      escalator: "the escalator",
      elevator: "the lift",
      level: "the floor change",
      walk: "",
    }[next.mode];
  };
  guide.steps.forEach((s, i) => {
    const t = s.mode === "walk" ? target(guide.steps[i + 1]) : "";
    const item = steps[i];
    if (t && item) item.text = `${item.text} to ${t}`;
  });
  return (guide.direction === "in" ? [door, ...steps, platform] : [platform, ...steps, door]).map(
    (item) => ({ ...item, stationId: guide.station.id }),
  );
}
