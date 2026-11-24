/**
 * Builds the in-station walking graph from OpenStreetMap data and finds the best path from
 * every entrance to every platform. Runs at build time (scripts/build-data.ts) and in tests.
 */
import { distance, projectFraction } from "./geo";
import type {
  Entrance,
  IndoorFeature,
  LngLat,
  Mode,
  PathStep,
  PathVertex,
  Platform,
  Profile,
  StationData,
  StationPath,
} from "./station-types";
import { PROFILES } from "./station-types";

export type Tags = Record<string, string>;
export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}
export interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Tags;
}
export type OsmElement = OsmNode | OsmWay | { type: "relation"; id: number; tags?: Tags };

export interface GtfsPlatform {
  stopId: string;
  code: string;
  description?: string;
  lat: number;
  lon: number;
}
export interface GtfsStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  platforms: GtfsPlatform[];
}

/** Parse an OSM `level` value: "-2", "-2;-1;0", "0-2", "-1--3". */
export function parseLevels(value: string | undefined): number[] {
  if (!value) return [];
  const out = new Set<number>();
  for (const part of value.split(";")) {
    const p = part.trim();
    const range = /^(-?\d+)-(-?\d+)$/.exec(p);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let l = Math.min(a, b); l <= Math.max(a, b); l++) out.add(l);
    } else if (p !== "" && Number.isFinite(Number(p))) {
      out.add(Number(p));
    }
  }
  return [...out].toSorted((a, b) => a - b);
}

const WALKABLE = new Set([
  "footway",
  "steps",
  "corridor",
  "path",
  "pedestrian",
  "elevator",
  "living_street",
  "residential",
  "service",
  "unclassified",
  "tertiary",
  "secondary",
  "primary",
  "cycleway",
  "platform",
  "track",
]);

const SPEED = { walk: 1.3, stairs: 0.55, escalator: 0.9, elevator: 1, level: 1 } as const;
/** Extra cost of a level change that OSM does not describe, seconds. */
const UNKNOWN_LEVEL_SECONDS = 20;
/** Fixed cost of one elevator ride (wait + ride), seconds. */
const ELEVATOR_SECONDS = 45;
/** Paths longer than this belong to another station or are data errors. */
const MAX_PATH_METERS = 650;

const isPlatformWay = (t: Tags) =>
  t.railway === "platform" || (t.public_transport === "platform" && t.highway !== "bus_stop");

function wayMode(t: Tags): Mode {
  if (t.highway === "steps") return t.conveying && t.conveying !== "no" ? "escalator" : "stairs";
  if (t.highway === "elevator") return "elevator";
  // A footway tagged with several levels connects them in a way OSM does not describe.
  if (parseLevels(t.level).length > 1 && !t.incline && t.ramp !== "yes") return "level";
  return "walk";
}

function walkable(t: Tags): boolean {
  if (t.access === "no" || t.access === "private" || t.foot === "no") return false;
  if (t.highway === "motorway" || t.highway === "trunk") return false;
  return (t.highway !== undefined && WALKABLE.has(t.highway)) || isPlatformWay(t);
}

interface Edge {
  to: number;
  meters: number;
  mode: Mode;
  noWheelchair: boolean;
}

function allowed(e: Edge, profile: Profile): boolean {
  if (profile === "fastest") return true;
  if (e.mode === "stairs") return false;
  if (profile === "stepFree")
    return e.mode !== "escalator" && e.mode !== "level" && !e.noWheelchair;
  return true;
}

class MinHeap {
  private a: [number, number][] = [];
  get size() {
    return this.a.length;
  }
  push(item: [number, number]) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as [number, number])[0] <= item[0]) break;
      a[i] = a[p] as [number, number];
      i = p;
    }
    a[i] = item;
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length === 0 || !last) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = last[0];
      let m = -1;
      if (l < a.length && (a[l] as [number, number])[0] < smallest) {
        m = l;
        smallest = (a[l] as [number, number])[0];
      }
      if (r < a.length && (a[r] as [number, number])[0] < smallest) m = r;
      if (m === -1) break;
      a[i] = a[m] as [number, number];
      i = m;
    }
    a[i] = last;
    return top;
  }
}

export function buildStation(
  station: GtfsStation,
  elements: OsmElement[],
  osmTimestamp: string,
): StationData {
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const e of elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.push(e);
  }
  const ll = (id: number): LngLat => {
    const n = nodes.get(id);
    return n ? [n.lon, n.lat] : [0, 0];
  };

  // Node levels from the horizontal ways that touch them.
  const nodeLevel = new Map<number, number>();
  for (const w of ways) {
    const t = w.tags ?? {};
    if (!walkable(t) || wayMode(t) !== "walk") continue;
    const lv = parseLevels(t.level);
    if (lv.length !== 1) continue;
    for (const id of w.nodes) if (!nodeLevel.has(id)) nodeLevel.set(id, lv[0] as number);
  }
  for (const [id, n] of nodes) {
    const lv = parseLevels(n.tags?.level);
    if (!nodeLevel.has(id) && lv.length === 1) nodeLevel.set(id, lv[0] as number);
  }

  // Graph.
  const graph = new Map<number, Edge[]>();
  const link = (a: number, b: number, mode: Mode, noWheelchair: boolean) => {
    const meters = distance(ll(a), ll(b));
    const push = (from: number, to: number) => {
      let list = graph.get(from);
      if (!list) graph.set(from, (list = []));
      list.push({ to, meters, mode, noWheelchair });
    };
    push(a, b);
    push(b, a);
  };
  for (const w of ways) {
    const t = w.tags ?? {};
    if (!walkable(t)) continue;
    const mode = wayMode(t);
    const noWheelchair = t.wheelchair === "no";
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1] as number;
      const b = w.nodes[i] as number;
      if (nodes.has(a) && nodes.has(b)) link(a, b, mode, noWheelchair);
    }
  }
  const elevatorNodes = new Set(
    [...nodes.values()].filter((n) => n.tags?.highway === "elevator").map((n) => n.id),
  );
  // Nodes where horizontal ways of different levels meet with nothing vertical mapped.
  const levelsAt = new Map<number, Set<number>>();
  for (const w of ways) {
    const t = w.tags ?? {};
    if (!walkable(t) || wayMode(t) !== "walk") continue;
    const lv = parseLevels(t.level);
    if (lv.length !== 1) continue;
    for (const id of w.nodes) {
      let set = levelsAt.get(id);
      if (!set) levelsAt.set(id, (set = new Set()));
      set.add(lv[0] as number);
    }
  }
  const jumpNodes = new Set(
    [...levelsAt].filter(([id, set]) => set.size > 1 && !elevatorNodes.has(id)).map(([id]) => id),
  );

  // Entrances. Snap an entrance that is not on a way to the nearest graph node.
  const graphIds = [...graph.keys()];
  const entrances: Entrance[] = [];
  const entranceNode = new Map<string, number>();
  for (const n of nodes.values()) {
    const t = n.tags ?? {};
    if (t.railway !== "subway_entrance") continue;
    let at = n.id;
    if (!graph.has(n.id)) {
      let best = Infinity;
      for (const g of graphIds) {
        const d = distance([n.lon, n.lat], ll(g));
        if (d < best) {
          best = d;
          at = g;
        }
      }
      if (best > 30) continue;
    }
    const id = String(n.id);
    entranceNode.set(id, at);
    entrances.push({
      id,
      ...(t.ref ? { ref: t.ref } : {}),
      ...(t["name:en"] || t.name ? { name: t["name:en"] ?? t.name } : {}),
      lng: n.lon,
      lat: n.lat,
      level: nodeLevel.get(n.id) ?? parseLevels(t.level)[0] ?? 0,
      ...(t.wheelchair ? { wheelchair: t.wheelchair } : {}),
    });
  }

  // Platforms: match the GTFS stop code to the OSM `ref`, else take the nearest OSM platform.
  const osmPlatforms = ways.filter((w) => {
    const t = w.tags ?? {};
    return isPlatformWay(t) && t.train !== "yes" && t.tram !== "yes" && t.bus !== "yes";
  });
  const platforms: Platform[] = [];
  const platformNodes = new Map<string, number[]>();
  for (const p of station.platforms) {
    let way = osmPlatforms.find((w) => (w.tags?.ref ?? "").split(";").includes(p.code));
    if (!way) {
      let best = 150;
      for (const w of osmPlatforms) {
        const t = w.tags ?? {};
        if (t.subway !== "yes" && t.railway !== "platform") continue;
        for (const id of w.nodes) {
          const d = distance([p.lon, p.lat], ll(id));
          if (d < best) {
            best = d;
            way = w;
          }
        }
      }
    }
    if (!way) {
      platforms.push({
        code: p.code,
        stopId: p.stopId,
        ...(p.description ? { description: p.description } : {}),
        axis: [
          [p.lon, p.lat],
          [p.lon, p.lat],
        ],
        meters: 0,
        level: null,
        mapped: false,
      });
      continue;
    }
    const ids = way.nodes.filter((id) => nodes.has(id));
    let axis: [LngLat, LngLat] = [ll(ids[0] as number), ll(ids[0] as number)];
    let longest = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = distance(ll(ids[i] as number), ll(ids[j] as number));
        if (d > longest) {
          longest = d;
          axis = [ll(ids[i] as number), ll(ids[j] as number)];
        }
      }
    }
    platformNodes.set(p.code, ids);
    platforms.push({
      code: p.code,
      stopId: p.stopId,
      ...(p.description ? { description: p.description } : {}),
      axis,
      meters: Math.round(longest),
      level: parseLevels(way.tags?.level)[0] ?? null,
      mapped: true,
    });
  }

  // Dijkstra from each entrance, for each profile.
  const paths: StationPath[] = [];
  for (const entrance of entrances) {
    const source = entranceNode.get(entrance.id) as number;
    for (const profile of PROFILES) {
      const dist = new Map<number, number>([[source, 0]]);
      const prev = new Map<number, { from: number; edge: Edge }>();
      const heap = new MinHeap();
      heap.push([0, source]);
      while (heap.size > 0) {
        const [c, u] = heap.pop() as [number, number];
        if (c > (dist.get(u) ?? Infinity)) continue;
        for (const e of graph.get(u) ?? []) {
          if (!allowed(e, profile)) continue;
          const jump = jumpNodes.has(e.to);
          // An undescribed level change can be stairs: never use it for step-free paths.
          if (jump && profile === "stepFree") continue;
          let cost = e.meters / SPEED[e.mode];
          if (elevatorNodes.has(e.to) && !elevatorNodes.has(u)) cost += ELEVATOR_SECONDS;
          if (jump) cost += UNKNOWN_LEVEL_SECONDS;
          const nc = c + cost;
          if (nc < (dist.get(e.to) ?? Infinity)) {
            dist.set(e.to, nc);
            prev.set(e.to, { from: u, edge: e });
            heap.push([nc, e.to]);
          }
        }
      }
      for (const platform of platforms) {
        const ids = platformNodes.get(platform.code);
        if (!ids) continue;
        let target: number | undefined;
        let best = Infinity;
        for (const id of ids) {
          const d = dist.get(id) ?? Infinity;
          if (d < best) {
            best = d;
            target = id;
          }
        }
        if (target === undefined) continue;
        const chain: { node: number; edge?: Edge }[] = [];
        for (let x: number | undefined = target; x !== undefined;) {
          const p = prev.get(x);
          chain.push({ node: x, ...(p ? { edge: p.edge } : {}) });
          x = p?.from;
        }
        chain.reverse();
        const result = summarize(chain, nodeLevel, elevatorNodes, ll, entrance.level);
        if (result.meters > MAX_PATH_METERS) continue;
        paths.push({
          entrance: entrance.id,
          platform: platform.code,
          profile,
          meters: Math.round(result.meters),
          seconds: Math.round(best),
          position: Number(projectFraction(ll(target), ...platform.axis).toFixed(3)),
          steps: result.steps,
          line: result.line,
        });
      }
    }
  }

  const indoor = extractIndoor(nodes, ways, ll);
  // Floors for the picker: whole levels that have at least a few indoor features.
  const counts = new Map<number, number>();
  for (const f of indoor) {
    const l = f.properties.lmin;
    if (l === f.properties.lmax && Number.isInteger(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const levels = new Set<number>([0]);
  for (const [l, n] of counts) if (n >= 3) levels.add(l);
  for (const p of platforms) if (p.level !== null) levels.add(p.level);
  return {
    id: station.id,
    name: station.name,
    lng: station.lon,
    lat: station.lat,
    levels: [...levels].toSorted((a, b) => b - a),
    entrances: entrances.filter((e) => paths.some((p) => p.entrance === e.id)),
    platforms,
    paths,
    indoor: { type: "FeatureCollection", features: indoor },
    osmTimestamp,
  };
}

function summarize(
  chain: { node: number; edge?: Edge }[],
  nodeLevel: Map<number, number>,
  elevatorNodes: Set<number>,
  ll: (id: number) => LngLat,
  startLevel: number | null,
): { meters: number; steps: PathStep[]; line: PathVertex[] } {
  const line: PathVertex[] = [];
  const steps: PathStep[] = [];
  let level: number | null = startLevel;
  let meters = 0;
  let viaElevator = false;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  for (let i = 0; i < chain.length; i++) {
    const { node, edge } = chain[i] as { node: number; edge?: Edge };
    const before = level;
    const known = nodeLevel.get(node);
    if (known !== undefined) level = known;
    const [lng, lat] = ll(node);
    line.push([round(lng), round(lat), level]);
    const prevNode = chain[i - 1]?.node;
    if (prevNode !== undefined && elevatorNodes.has(prevNode)) viaElevator = true;
    if (!edge) continue;
    meters += edge.meters;
    let from = before;
    // A level change on a horizontal way: an elevator (a point in OSM) or an undescribed change.
    if (edge.mode === "walk" && before !== null && level !== null && before !== level) {
      const elevator = viaElevator || elevatorNodes.has(node);
      steps.push({
        mode: elevator ? "elevator" : "level",
        fromLevel: before,
        toLevel: level,
        meters: 0,
        seconds: elevator ? ELEVATOR_SECONDS : UNKNOWN_LEVEL_SECONDS,
      });
      viaElevator = false;
      from = level;
    } else if (edge.mode !== "walk") {
      viaElevator = false;
    }
    const last = steps.at(-1);
    const seconds = edge.meters / SPEED[edge.mode];
    if (last && last.mode === edge.mode && (edge.mode === "walk" || last.toLevel === from)) {
      last.meters += edge.meters;
      last.seconds += seconds;
      last.toLevel = level;
    } else {
      steps.push({
        mode: edge.mode,
        fromLevel: from,
        toLevel: level,
        meters: edge.meters,
        seconds,
      });
    }
  }
  for (const s of steps) {
    s.meters = Math.round(s.meters);
    s.seconds = Math.round(s.seconds);
  }
  return { meters, steps, line };
}

const AREA_KINDS = new Set(["room", "area", "corridor", "level"]);

function extractIndoor(
  nodes: Map<number, OsmNode>,
  ways: OsmWay[],
  ll: (id: number) => LngLat,
): IndoorFeature[] {
  const out: IndoorFeature[] = [];
  const levelsOf = (t: Tags, fallback: number | null): [number, number] | null => {
    const lv = parseLevels(t.level ?? t["level:ref"]);
    if (lv.length > 0) return [lv[0] as number, lv.at(-1) as number];
    if (t.layer && Number(t.layer) < 0 && (t.tunnel || t.railway === "subway")) {
      return [Number(t.layer), Number(t.layer)];
    }
    return fallback === null ? null : [fallback, fallback];
  };
  const name = (t: Tags) => t["name:en"] ?? t.name;
  for (const w of ways) {
    const t = w.tags ?? {};
    const coords = w.nodes.filter((id) => nodes.has(id)).map(ll);
    if (coords.length < 2) continue;
    const closed = w.nodes[0] === w.nodes.at(-1) && coords.length >= 4;
    let kind: string | undefined;
    let range: [number, number] | null = null;
    if (t.railway === "subway") {
      kind = "track";
      range = levelsOf(t, t.tunnel ? -1 : 0);
    } else if (isPlatformWay(t) && t.highway !== "bus_stop") {
      kind = "platform";
      range = levelsOf(t, 0);
    } else if (t.indoor && AREA_KINDS.has(t.indoor) && closed) {
      kind = t.indoor === "corridor" ? "corridor-area" : t.indoor;
      range = levelsOf(t, 0);
    } else if (t.highway === "steps") {
      kind = wayMode(t) === "escalator" ? "escalator" : "stairs";
      range = levelsOf(t, null);
    } else if (t.highway === "elevator") {
      kind = "elevator";
      range = levelsOf(t, null);
    } else if (
      (t.highway === "footway" || t.highway === "corridor" || t.highway === "pedestrian") &&
      (t.level || t.indoor || t.tunnel || t.layer)
    ) {
      kind = "footway";
      range = levelsOf(t, t.tunnel || (t.layer && Number(t.layer) < 0) ? -1 : null);
    } else if ((t.shop || t.amenity) && t.level && closed) {
      kind = "room";
      range = levelsOf(t, null);
    }
    if (!kind || !range) continue;
    const properties = {
      kind,
      ...(name(t) ? { name: name(t) as string } : {}),
      ...(t.ref ? { ref: t.ref } : {}),
      lmin: range[0],
      lmax: range[1],
    };
    const area =
      closed && kind !== "stairs" && kind !== "escalator" && kind !== "track" && kind !== "footway";
    out.push({
      type: "Feature",
      properties,
      geometry: area
        ? { type: "Polygon", coordinates: [coords.map(roundLL)] }
        : { type: "LineString", coordinates: coords.map(roundLL) },
    });
  }
  for (const n of nodes.values()) {
    const t = n.tags ?? {};
    let kind: string | undefined;
    if (t.railway === "subway_entrance") kind = "entrance";
    else if (t.highway === "elevator") kind = "elevator";
    else if ((t.shop || t.amenity) && t.level && name(t)) kind = "poi";
    if (!kind) continue;
    const lv = parseLevels(t.level);
    out.push({
      type: "Feature",
      properties: {
        kind,
        ...(name(t) ? { name: name(t) as string } : {}),
        ...(t.ref ? { ref: t.ref } : {}),
        lmin: lv[0] ?? 0,
        lmax: lv.at(-1) ?? 0,
      },
      geometry: { type: "Point", coordinates: roundLL([n.lon, n.lat]) },
    });
  }
  return out;
}

const roundLL = ([lng, lat]: LngLat): LngLat => [
  Math.round(lng * 1e6) / 1e6,
  Math.round(lat * 1e6) / 1e6,
];
