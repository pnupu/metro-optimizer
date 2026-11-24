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
  PathVertex,
  Platform,
  StationData,
  StationPath,
} from "./station-types";
import { ELEVATOR_SECONDS, PROFILES } from "./station-types";
import { areaAt, areaPolygons, areasAlong, namedAreas, nearestStreet } from "./signs";
import { cheapest, MODES, pathTo, search, type WalkGraph } from "./walk-graph";

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
export interface OsmRelation {
  type: "relation";
  id: number;
  members?: { type: string; ref: number; role: string }[];
  tags?: Tags;
}
export type OsmElement = OsmNode | OsmWay | OsmRelation;

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

export function buildStation(
  station: GtfsStation,
  elements: OsmElement[],
  osmTimestamp: string,
): StationData & { graph: WalkGraph } {
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.push(e);
    else relations.push(e);
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

  // Named buildings, malls and squares, for exit signs and "through X" notes.
  const maybeLl = (id: number): LngLat | undefined => {
    const n = nodes.get(id);
    return n ? [n.lon, n.lat] : undefined;
  };
  const areas = namedAreas(ways, relations, maybeLl);

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
    const street = t["addr:street"] ?? nearestStreet([n.lon, n.lat], ways, maybeLl);
    // Some entrances are a lift (Rautatientori C): the path ends at its lower floor, and the
    // last step is the lift ride to its top.
    const lift = t.highway === "elevator" ? parseLevels(t.level) : [];
    // A lift entrance's own level tag gives both ends; the ways touching it may give either.
    const entranceLevel =
      lift.length > 1 ? (lift[0] as number) : (nodeLevel.get(n.id) ?? parseLevels(t.level)[0] ?? 0);
    const liftTop = lift.length > 1 ? lift.at(-1) : undefined;
    const place = areaAt([n.lon, n.lat], areas);
    entrances.push({
      id,
      ...(t.ref ? { ref: t.ref } : {}),
      ...(t["name:en"] || t.name ? { name: t["name:en"] ?? t.name } : {}),
      lng: n.lon,
      lat: n.lat,
      level: entranceLevel,
      ...(liftTop !== undefined && liftTop !== entranceLevel ? { liftTo: liftTop } : {}),
      ...(t.wheelchair ? { wheelchair: t.wheelchair } : {}),
      ...(street ? { street } : {}),
      ...(place && place !== street ? { place } : {}),
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

  // The compact walking network: the part connected to the platforms.
  const wg = toWalkGraph(graph, nodes, nodeLevel, elevatorNodes, jumpNodes, platformNodes, ways);
  const index = new Map(wg.ids.map((id, k) => [id, k]));

  // Cheapest path from each entrance to each platform, for each profile.
  const paths: StationPath[] = [];
  for (const entrance of entrances) {
    const source = index.get(entranceNode.get(entrance.id) as number);
    if (source === undefined) continue;
    for (const profile of PROFILES) {
      const found = search(wg.graph, [source], profile);
      for (const platform of platforms) {
        const targets = wg.graph.platforms.find((p) => p.code === platform.code)?.nodes ?? [];
        const target = cheapest(found, targets);
        if (target === undefined) continue;
        const result = pathTo(found, target, entrance.level);
        // A lift entrance adds a ride the graph search does not see (the path starts inside it).
        const liftSeconds = entrance.liftTo === undefined ? 0 : ELEVATOR_SECONDS;
        if (result.meters > MAX_PATH_METERS) continue;
        const [tlng, tlat] = wg.graph.nodes[target] as PathVertex;
        paths.push({
          entrance: entrance.id,
          platform: platform.code,
          profile,
          meters: Math.round(result.meters),
          seconds: Math.round(result.seconds + liftSeconds),
          position: Number(projectFraction([tlng, tlat], ...platform.axis).toFixed(3)),
          steps: result.steps,
          line: result.line,
          ...(() => {
            const via = areasAlong(
              result.line.map(([lng, lat]) => [lng, lat] as LngLat),
              areas,
            );
            return via.length > 0 ? { via } : {};
          })(),
        });
      }
    }
  }

  const indoor = extractIndoor(nodes, ways, ll);
  // Named buildings and malls on every floor, so the map shows when a path is inside one.
  for (const area of areas.filter((a) => a.building)) {
    for (const polygon of areaPolygons(area)) {
      indoor.push({
        type: "Feature",
        properties: { kind: "building", name: area.name, lmin: -99, lmax: 99 },
        geometry: { type: "Polygon", coordinates: polygon.map((ring) => ring.map(roundLL)) },
      });
    }
  }
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
    graph: wg.graph,
  };
}

/**
 * The walking network as compact arrays: the part reachable from the platforms, with named
 * shops and amenities that have a floor, snapped to a walkway on that floor.
 */
function toWalkGraph(
  graph: Map<number, Edge[]>,
  nodes: Map<number, OsmNode>,
  nodeLevel: Map<number, number>,
  elevatorNodes: Set<number>,
  jumpNodes: Set<number>,
  platformNodes: Map<string, number[]>,
  ways: OsmWay[],
): { graph: WalkGraph; ids: number[] } {
  const seen = new Set<number>();
  const queue = [...platformNodes.values()].flat().filter((id) => graph.has(id));
  for (const id of queue) seen.add(id);
  while (queue.length > 0) {
    const u = queue.pop() as number;
    for (const e of graph.get(u) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  const ids = [...seen];
  const index = new Map(ids.map((id, k) => [id, k]));
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const out: WalkGraph = {
    nodes: ids.map((id) => {
      const n = nodes.get(id) as OsmNode;
      return [r6(n.lon), r6(n.lat), nodeLevel.get(id) ?? null];
    }),
    edges: [],
    elevators: ids.filter((id) => elevatorNodes.has(id)).map((id) => index.get(id) as number),
    jumps: ids.filter((id) => jumpNodes.has(id)).map((id) => index.get(id) as number),
    platforms: [...platformNodes].map(([code, list]) => ({
      code,
      nodes: list.map((id) => index.get(id)).filter((k): k is number => k !== undefined),
    })),
    pois: [],
  };
  for (const [a, list] of graph) {
    const ia = index.get(a);
    if (ia === undefined) continue;
    for (const e of list) {
      const ib = index.get(e.to);
      if (ib === undefined || ib < ia) continue;
      out.edges.push([
        ia,
        ib,
        Math.max(1, Math.round(e.meters * 10)),
        MODES.indexOf(e.mode),
        e.noWheelchair ? 1 : 0,
      ]);
    }
  }
  // Places people travel to: named shops and amenities with a floor.
  const candidates: {
    name: string;
    local?: string;
    level: number;
    floor?: string;
    lng: number;
    lat: number;
  }[] = [];
  const add = (t: Tags, lng: number, lat: number) => {
    const name = t["name:en"] ?? t.name;
    const local = t["name:en"] && t.name && t.name !== t["name:en"] ? t.name : undefined;
    const level = parseLevels(t.level);
    if (!name || level.length !== 1 || !(t.shop || t.amenity || t.office || t.leisure)) return;
    candidates.push({
      name,
      ...(local ? { local } : {}),
      level: level[0] as number,
      ...(t["level:ref"] ? { floor: t["level:ref"] } : {}),
      lng,
      lat,
    });
  };
  for (const n of nodes.values()) if (n.tags) add(n.tags, n.lon, n.lat);
  for (const w of ways) {
    if (!w.tags || w.nodes[0] !== w.nodes.at(-1)) continue;
    const pts = w.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => !!n);
    if (pts.length < 3) continue;
    add(
      w.tags,
      pts.reduce((s, n) => s + n.lon, 0) / pts.length,
      pts.reduce((s, n) => s + n.lat, 0) / pts.length,
    );
  }
  for (const c of candidates) {
    let best = -1;
    let bestD = 40;
    out.nodes.forEach(([lng, lat, lv], k) => {
      if (lv !== c.level) return;
      const d = distance([lng, lat], [c.lng, c.lat]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best >= 0) out.pois.push({ ...c, lng: r6(c.lng), lat: r6(c.lat), node: best });
  }
  return { graph: out, ids };
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
