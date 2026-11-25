import { cumulative, distance, projectFraction } from "./geo";
import type { IndoorProps, LngLat, PathStep, PathVertex, StationData } from "./station-types";

const FLOOR_SPACING = 3.4;
const MIN_LEVEL = -20;
const PLATE_MARGIN = 5;
const CONTEXT_RADIUS = 20;
export const ROUTE_LIFT = 0.24;

export const floorHeight = (level: number, lowest: number) => (level - lowest + 1) * FLOOR_SPACING;
export const floorNumber = (level: number) => (level < 0 ? `−${-level}` : String(level));

export function floorLabel3d(level: number, names?: ReadonlyMap<number, string>): string {
  const name = names?.get(level);
  if (name && !/^[−-]?\d+[.,]\d+$/.test(name.trim())) return name;
  const number = floorNumber(Math.trunc(level));
  return Number.isInteger(level) ? number : `${number} mezz.`;
}

/** Neighboring buildings can have different refs for the same OSM level. */
export function floorNames3d(
  pois: { level: number | null; floor?: string }[],
): Map<number, string> {
  const names = new Map<number, string>();
  const ambiguous = new Set<number>();
  for (const { level, floor } of pois) {
    const name = floor?.trim();
    if (level === null || !name || ambiguous.has(level)) continue;
    if (names.has(level) && names.get(level) !== name) {
      ambiguous.add(level);
      names.delete(level);
    } else names.set(level, name);
  }
  return names;
}

export type Point3d = [lng: number, lat: number, height: number];
type LevelPoint = [lng: number, lat: number, level: number];

const xy = ([lng, lat]: PathVertex | LngLat): LngLat => [lng, lat];
const atLevel = (p: PathVertex | LngLat, level: number): LevelPoint => [...xy(p), level];
const mix = (a: LngLat, b: LngLat, t: number): LngLat => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

const valid = (level: number) => level >= MIN_LEVEL && Number.isFinite(level);
const knownLevel = (level: number | null | undefined) => level != null && valid(level);

export interface Route3d {
  line: PathVertex[];
  steps: PathStep[];
  fallbackLevel: number;
}

interface RouteSection {
  points: LevelPoint[];
  step?: PathStep;
  /** A shaft between the real walk-in and walk-out points of an OSM point lift. */
  shaft?: [LevelPoint, LevelPoint];
}

function liftSection(a: LevelPoint, b: LevelPoint, lift: LngLat, step: PathStep): RouteSection {
  const shaft: [LevelPoint, LevelPoint] = [atLevel(lift, a[2]), atLevel(lift, b[2])];
  return { points: [a, ...shaft, b], shaft, step };
}

/** Use the same step indices as the walkthrough, even if the walk is in reverse. */
export function routeSections3d(
  { line, steps, fallbackLevel }: Route3d,
  lifts: LngLat[] = [],
): RouteSection[] {
  let level = line.find((p) => knownLevel(p[2]))?.[2] ?? fallbackLevel;
  const vertices = line.map((p) => {
    if (p[2] != null && valid(p[2])) level = p[2];
    return atLevel(p, level);
  });
  const sections: RouteSection[] = [];
  // Point steps may share their index with a walk on either side. Reserve the actual
  // level-changing edge before assigning the walking steps.
  const taken = new Set<number>();
  for (const step of steps) {
    const { a, b, fromLevel, toLevel, mode } = step;
    const start = vertices[a];
    if (
      !start ||
      mode === "walk" ||
      fromLevel == null ||
      toLevel == null ||
      fromLevel === toLevel
    ) {
      continue;
    }
    const end = vertices[b];
    if (!end) continue;
    let first = a;
    let last = b;
    if (a === b) {
      if (start[2] === fromLevel && vertices[a + 1]?.[2] === toLevel) last++;
      else if (vertices[a - 1]?.[2] === fromLevel && start[2] === toLevel) first--;
    }
    const startPoint = atLevel(vertices[first] ?? start, fromLevel);
    const endPoint = atLevel(vertices[last] ?? end, toLevel);
    for (let i = first; i < last; i++) taken.add(i);
    if (mode === "elevator") {
      // A lift can be stored as one vertex beside an edge that also includes a walk.
      // Snap only to mapped lifts next to that edge, or use the step vertex.
      const nearest = (p: LngLat) => {
        const a = xy(startPoint);
        const b = xy(endPoint);
        return distance(p, mix(a, b, projectFraction(p, a, b)));
      };
      const nearby = lifts
        .filter((p) => nearest(p) <= 3)
        .toSorted((a, b) => nearest(a) - nearest(b));
      sections.push(liftSection(startPoint, endPoint, nearby[0] ?? xy(start), step));
    } else {
      const points = vertices.slice(first, last + 1).map(xy);
      const lengths = cumulative(points);
      const total = lengths.at(-1) ?? 0;
      // OSM commonly tags only the landings. Spread the rise along the mapped flight.
      sections.push({
        step,
        points:
          total > 0
            ? points.map((p, i) =>
                atLevel(p, fromLevel + (toLevel - fromLevel) * (lengths[i]! / total)),
              )
            : [startPoint, endPoint],
      });
    }
  }

  const walkSteps = new Map<number, PathStep>();
  for (const step of steps) {
    for (let i = step.a; i < step.b; i++) walkSteps.set(i, step);
  }
  for (let i = 0; i + 1 < vertices.length; i++) {
    if (taken.has(i)) continue;
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const step = walkSteps.get(i);
    const previous = sections.at(-1);
    if (previous?.step === step && previous?.points.at(-1) === a && a[2] === b[2])
      previous.points.push(b);
    else sections.push({ points: [a, b], ...(step ? { step } : {}) });
  }
  return sections;
}

export interface IndoorLabel3d {
  text: string;
  anchors: Point3d[];
  kind: "floor" | "current-floor" | "entrance" | "route" | "active" | "origin" | "destination";
}

export interface RoutePin3d {
  text: string;
  point: LngLat;
  pathPoint?: LngLat;
  level: number | null;
  kind: "entrance" | "route" | "origin" | "destination";
}

export interface Plate3d {
  level: number;
  ring: Point3d[];
  active: boolean;
}

export interface IndoorScene3d {
  plates: Plate3d[];
  context: Point3d[][];
  route: { points: Point3d[]; active: boolean; ramp: boolean; shaft?: [Point3d, Point3d] }[];
  labels: IndoorLabel3d[];
}

function cross(a: LngLat, b: LngLat, p: LngLat) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** A schematic footprint around the mapped area. Add a margin so a narrow path has a plate. */
export function plateOutline(points: LngLat[], latitude: number): LngLat[] {
  const hullSide = (sorted: LngLat[]) => {
    const side: LngLat[] = [];
    for (const p of sorted) {
      while (side.length >= 2 && cross(side.at(-2)!, side.at(-1)!, p) <= 0) side.pop();
      side.push(p);
    }
    return side;
  };
  const hull = (sorted: LngLat[]) =>
    hullSide(sorted).slice(0, -1).concat(hullSide(sorted.toReversed()).slice(0, -1));
  const sort = (points: LngLat[]) => points.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const sorted = sort(points);
  const perimeter = hull(sorted);
  const dy = PLATE_MARGIN / 111_320;
  const dx = dy / Math.cos((latitude * Math.PI) / 180);
  return hull(
    sort(
      (perimeter.length > 0 ? perimeter : sorted.slice(0, 1)).flatMap(([x, y]): LngLat[] => [
        [x - dx, y - dy],
        [x - dx, y + dy],
        [x + dx, y - dy],
        [x + dx, y + dy],
      ]),
    ),
  );
}

function nearRoute(point: LngLat, segments: [LngLat, LngLat][]): boolean {
  return segments.some(([a, b]) => {
    // The angular prefilter avoids distance and projection work for distant features.
    if (point[1] < Math.min(a[1], b[1]) - 0.0002 || point[1] > Math.max(a[1], b[1]) + 0.0002) {
      return false;
    }
    return distance(point, mix(a, b, projectFraction(point, a, b))) <= CONTEXT_RADIUS;
  });
}

const connector = ({ kind }: IndoorProps) =>
  kind === "escalator" || kind === "stairs" || kind === "elevator";

const outlineKinds = new Set(["platform", "room", "area", "corridor-area"]);
const stepNames = {
  stairs: "Stairs",
  escalator: "Escalator",
  elevator: "Lift",
  level: "Floor change",
};

export function buildIndoorScene3d(
  station: StationData,
  routes: Route3d[],
  current: number,
  pins: RoutePin3d[],
  floorNames: ReadonlyMap<number, string>,
  active?: { step?: PathStep; points: LngLat[]; level: number | null },
): IndoorScene3d {
  const features = station.indoor.features;
  const lifts = features.flatMap(({ geometry, properties }) =>
    geometry.type === "Point" && properties.kind === "elevator" ? [geometry.coordinates] : [],
  );
  const sections = routes.flatMap((route) => routeSections3d(route, lifts));
  const floorPoints = new Map<number, LngLat[]>();
  const floorSegments = new Map<number, [LngLat, LngLat][]>();
  const remember = (level: number, p: LngLat) => {
    if (!valid(level)) return;
    const list = floorPoints.get(level);
    if (list) list.push(p);
    else floorPoints.set(level, [p]);
  };
  for (const { points } of sections) {
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) continue;
    remember(first[2], xy(first));
    remember(last[2], xy(last));
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (a[2] !== b[2]) continue;
      remember(a[2], xy(a));
      const segment: [LngLat, LngLat] = [xy(a), xy(b)];
      const list = floorSegments.get(a[2]);
      if (list) list.push(segment);
      else floorSegments.set(a[2], [segment]);
    }
  }
  for (const pin of pins) {
    remember(pin.level ?? current, pin.point);
    if (pin.pathPoint) remember(pin.level ?? current, pin.pathPoint);
  }
  const routeAnchors = new Map([...floorPoints].map(([level, points]) => [level, [...points]]));
  const routedFloors = new Set(floorPoints.keys());
  const hasRoute = routedFloors.size > 0;
  const lowest = lowestFloor(station, routes);
  const z = (level: number) => floorHeight(level, lowest);
  const raised = ([lng, lat, level]: LevelPoint): Point3d => [lng, lat, z(level) + ROUTE_LIFT];
  const context: Point3d[][] = [];

  for (const feature of features) {
    const { geometry, properties: props } = feature;
    const { kind, lmin, lmax } = props;
    if (!valid(lmin) || (hasRoute ? !routedFloors.has(lmin) : lmin > current)) continue;
    const rings =
      geometry.type === "Polygon"
        ? geometry.coordinates
        : geometry.type === "LineString"
          ? [geometry.coordinates]
          : [];
    const around = routeAnchors.get(lmin) ?? [];
    const segments = floorSegments.get(lmin) ?? [];
    const isNearby = hasRoute
      ? (p: LngLat) =>
          nearRoute(p, segments) || around.some((a) => distance(p, a) <= CONTEXT_RADIUS)
      : () => true;

    if (connector(props) && lmax > lmin && (hasRoute ? routedFloors.has(lmax) : lmax <= current)) {
      const first = geometry.type === "Point" ? geometry.coordinates : rings[0]?.[0];
      const last = geometry.type === "Point" ? geometry.coordinates : rings[0]?.at(-1);
      if (first && last && isNearby(first))
        context.push([
          [...first, z(lmin)],
          [...last, z(lmax)],
        ]);
      continue;
    }
    if (!outlineKinds.has(kind) && kind !== "footway") continue;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1]!;
        const b = ring[i]!;
        if (!isNearby(a) || !isNearby(b)) continue;
        remember(lmin, a);
        remember(lmin, b);
        context.push([
          [...a, z(lmin)],
          [...b, z(lmin)],
        ]);
      }
    }
  }

  const plates: Plate3d[] = [];
  const labels: IndoorLabel3d[] = pins.map(({ point, level, text, kind }) => ({
    text,
    kind,
    anchors: [raised(atLevel(point, level ?? current))],
  }));
  for (const [level, points] of [...floorPoints].sort(([a], [b]) => a - b)) {
    const ring = plateOutline(points, station.lat);
    const height = z(level);
    plates.push({ level, active: level === current, ring: ring.map((p) => [...p, height]) });
    const anchors = ring.flatMap((p, i) => {
      const next = ring[(i + 1) % ring.length]!;
      return [0.5, 0.25, 0.75].map((t): Point3d => [...mix(p, next, t), height]);
    });
    labels.push({
      text: floorLabel3d(level, floorNames),
      kind: level === current ? "current-floor" : "floor",
      anchors,
    });
  }
  const route = sections.map(({ points, step, shaft }) => {
    const onStep = active?.step != null && step === active.step;
    const mode = step?.mode;
    const from = step?.fromLevel;
    const to = step?.toLevel;
    const ramp = (mode === "escalator" || mode === "stairs") && from !== to;
    if (mode && mode !== "walk" && from != null && to != null && from !== to) {
      const a = shaft?.[0] ?? points[0]!;
      const b = shaft?.[1] ?? points.at(-1)!;
      const p = points.length > 2 && !shaft ? points[Math.floor(points.length / 2)]! : undefined;
      labels.push({
        kind: onStep ? "active" : "route",
        text: `${stepNames[mode]} ${to > from ? "↑" : "↓"} ${floorLabel3d(to, floorNames)}`,
        anchors: [raised(p ?? atLevel(mix(xy(a), xy(b), 0.5), (a[2] + b[2]) / 2))],
      });
    }
    return {
      points: points.map(raised),
      active: onStep,
      ramp,
      ...(shaft ? { shaft: [raised(shaft[0]), raised(shaft[1])] as [Point3d, Point3d] } : {}),
    };
  });
  for (const { point, pathPoint, level } of pins) {
    if (!pathPoint || distance(point, pathPoint) < 0.1) continue;
    route.push({
      points: [point, pathPoint].map((p) => raised(atLevel(p, level ?? current))),
      active: false,
      ramp: false,
    });
  }
  if (
    active &&
    !route.some((section) => section.active) &&
    active.level !== null &&
    active.points.length
  ) {
    route.push({
      points: active.points.map((p) => raised(atLevel(p, active.level!))),
      active: true,
      ramp: false,
    });
  }
  return { plates, context, route, labels };
}

export function lowestFloor(station: StationData, routes: Route3d[]): number {
  const levels = [
    ...station.levels,
    ...routes.map(({ fallbackLevel }) => fallbackLevel),
    ...station.indoor.features.map(({ properties }) => properties.lmin),
    ...routes.flatMap(({ line, steps }) => [
      ...line.map((p) => p[2]),
      ...steps.flatMap((step) => [step.fromLevel, step.toLevel]),
    ]),
  ];
  return levels.reduce<number>(
    (lowest, l) => (l != null && valid(l) ? Math.min(lowest, l) : lowest),
    0,
  );
}
