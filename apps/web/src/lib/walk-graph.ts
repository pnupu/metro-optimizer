/**
 * A compact walking network of one station area, and the path search on it. The data builder
 * uses it for entrance-to-platform paths; the app uses the same code to route from a platform to
 * a shop or other place inside a connected building.
 */
import {
  ELEVATOR_SECONDS,
  type Mode,
  type PathStep,
  type PathVertex,
  type Profile,
} from "./station-types";

export const MODES: readonly Mode[] = ["walk", "stairs", "escalator", "elevator", "level"];

export interface GraphPoi {
  name: string;
  /** The local name when `name` is the English one. */
  local?: string;
  /** OSM level, and the floor's own name when OSM gives one (`level:ref`, e.g. "M"). */
  level: number;
  floor?: string;
  node: number;
  lng: number;
  lat: number;
}

export interface WalkGraph {
  /** One entry per node: longitude, latitude, level (null when OSM gives none). */
  nodes: PathVertex[];
  /** a, b, length in decimetres, index into MODES, 1 when tagged wheelchair=no. */
  edges: [number, number, number, number, number][];
  /** Lift nodes (OSM maps a lift as one point). */
  elevators: number[];
  /** Nodes where floors meet with no stairs, escalator or lift mapped. */
  jumps: number[];
  platforms: { code: string; nodes: number[] }[];
  pois: GraphPoi[];
}

const SPEED: Record<Mode, number> = {
  walk: 1.3,
  stairs: 0.55,
  escalator: 0.9,
  elevator: 1,
  level: 1,
};
/** Extra cost of a level change that OSM does not describe, seconds. */
export const UNKNOWN_LEVEL_SECONDS = 20;

interface Adjacent {
  to: number;
  edge: number;
}

export interface Search {
  graph: WalkGraph;
  cost: Float64Array;
  prevEdge: Int32Array;
  prevNode: Int32Array;
}

function adjacency(g: WalkGraph): Adjacent[][] {
  const adj: Adjacent[][] = g.nodes.map(() => []);
  g.edges.forEach(([a, b], i) => {
    adj[a]?.push({ to: b, edge: i });
    adj[b]?.push({ to: a, edge: i });
  });
  return adj;
}

const adjCache = new WeakMap<WalkGraph, Adjacent[][]>();

/** Cheapest walking time from the sources to every node, for one profile. */
export function search(g: WalkGraph, sources: number[], profile: Profile): Search {
  let adj = adjCache.get(g);
  if (!adj) adjCache.set(g, (adj = adjacency(g)));
  const n = g.nodes.length;
  const cost = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prevEdge = new Int32Array(n).fill(-1);
  const prevNode = new Int32Array(n).fill(-1);
  const elevators = new Set(g.elevators);
  const jumps = new Set(g.jumps);
  const heap = new MinHeap();
  for (const s of sources) {
    cost[s] = 0;
    heap.push([0, s]);
  }
  while (heap.size > 0) {
    const [c, u] = heap.pop() as [number, number];
    if (c > (cost[u] as number)) continue;
    for (const { to, edge } of adj[u] ?? []) {
      const [, , dm, modeIndex, noWheel] = g.edges[edge] as WalkGraph["edges"][number];
      const mode = MODES[modeIndex] as Mode;
      if (profile !== "fastest" && mode === "stairs") continue;
      if (profile === "stepFree" && (mode === "escalator" || mode === "level" || noWheel)) continue;
      const jump = jumps.has(to);
      // An undescribed level change can be stairs: never use it for step-free paths.
      if (jump && profile === "stepFree") continue;
      let step = dm / 10 / SPEED[mode];
      if (elevators.has(to) && !elevators.has(u)) step += ELEVATOR_SECONDS;
      if (jump) step += UNKNOWN_LEVEL_SECONDS;
      const nc = c + step;
      if (nc < (cost[to] as number)) {
        cost[to] = nc;
        prevEdge[to] = edge;
        prevNode[to] = u;
        heap.push([nc, to]);
      }
    }
  }
  return { graph: g, cost, prevEdge, prevNode };
}

/** The cheapest of the targets, or undefined when none is reachable. */
export function cheapest(s: Search, targets: number[]): number | undefined {
  let best: number | undefined;
  for (const t of targets) {
    if (
      (s.cost[t] as number) <
      (best === undefined ? Number.POSITIVE_INFINITY : (s.cost[best] as number))
    ) {
      best = t;
    }
  }
  return best === undefined || !Number.isFinite(s.cost[best] as number) ? undefined : best;
}

/** The path from the search sources to the target, as steps and a line with levels. */
export function pathTo(
  s: Search,
  target: number,
  startLevel: number | null,
): {
  meters: number;
  seconds: number;
  steps: PathStep[];
  line: PathVertex[];
  outdoorMeters: number;
} {
  const chain: { node: number; edge?: number }[] = [];
  for (let x = target; x !== -1; x = s.prevNode[x] as number) {
    const e = s.prevEdge[x] as number;
    chain.push({ node: x, ...(e >= 0 ? { edge: e } : {}) });
  }
  chain.reverse();
  // Walking between nodes with no floor tag at all is walking outdoors (streets, squares).
  let outdoorMeters = 0;
  for (const { node, edge } of chain) {
    if (edge === undefined) continue;
    const [a, b, dm] = s.graph.edges[edge] as WalkGraph["edges"][number];
    if (s.graph.nodes[a]?.[2] === null && s.graph.nodes[b]?.[2] === null) outdoorMeters += dm / 10;
    void node;
  }
  return {
    ...summarize(s.graph, chain, startLevel),
    seconds: s.cost[target] as number,
    outdoorMeters,
  };
}

function summarize(
  g: WalkGraph,
  chain: { node: number; edge?: number }[],
  startLevel: number | null,
): { meters: number; steps: PathStep[]; line: PathVertex[] } {
  const elevators = new Set(g.elevators);
  const line: PathVertex[] = [];
  const steps: PathStep[] = [];
  let level: number | null = startLevel;
  let meters = 0;
  let viaElevator = false;
  for (let i = 0; i < chain.length; i++) {
    const { node, edge } = chain[i] as { node: number; edge?: number };
    const before = level;
    const [lng, lat, known] = g.nodes[node] as PathVertex;
    if (known !== null) level = known;
    line.push([lng, lat, level]);
    const prevNode = chain[i - 1]?.node;
    if (prevNode !== undefined && elevators.has(prevNode)) viaElevator = true;
    if (edge === undefined) continue;
    const [, , dm, modeIndex] = g.edges[edge] as WalkGraph["edges"][number];
    const mode = MODES[modeIndex] as Mode;
    const length = dm / 10;
    meters += length;
    let from = before;
    let start = i - 1;
    // A level change on a horizontal way: a lift (a point in OSM) or an undescribed change.
    if (mode === "walk" && before !== null && level !== null && before !== level) {
      const elevator = viaElevator || elevators.has(node);
      steps.push({
        mode: elevator ? "elevator" : "level",
        fromLevel: before,
        toLevel: level,
        meters: 0,
        seconds: elevator ? ELEVATOR_SECONDS : UNKNOWN_LEVEL_SECONDS,
        a: i - 1,
        b: i - 1,
      });
      viaElevator = false;
      from = level;
      // The walk after the change starts on the new floor, not at the vertex before it.
      start = i;
    } else if (mode !== "walk") {
      viaElevator = false;
    }
    const last = steps.at(-1);
    const seconds = length / SPEED[mode];
    if (last && last.mode === mode && (mode === "walk" || last.toLevel === from)) {
      last.meters += length;
      last.seconds += seconds;
      last.toLevel = level;
      last.b = i;
    } else {
      steps.push({
        mode,
        fromLevel: from,
        toLevel: level,
        meters: length,
        seconds,
        a: start,
        b: i,
      });
    }
  }
  for (const s of steps) {
    s.meters = Math.round(s.meters);
    s.seconds = Math.round(s.seconds);
  }
  return { meters, steps, line };
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
