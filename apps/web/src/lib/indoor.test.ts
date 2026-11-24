import { describe, expect, test } from "bun:test";

import { findPoi, guideToPoi } from "./guidance";
import { buildStation, type GtfsStation, type OsmElement } from "./station-graph";
import type { Place } from "./transitous";

// A platform at level -1 (west to east), a corridor north to a bakery on the same floor,
// and stairs from the corridor up to a street-level entrance.
const node = (id: number, lat: number, lon: number, tags?: Record<string, string>): OsmElement => ({
  type: "node",
  id,
  lat,
  lon,
  ...(tags ? { tags } : {}),
});
const way = (id: number, nodes: number[], tags: Record<string, string>): OsmElement => ({
  type: "way",
  id,
  nodes,
  tags,
});
const elements: OsmElement[] = [
  node(1, 60.17, 24.93),
  node(2, 60.17, 24.9309),
  node(3, 60.17, 24.9318),
  node(4, 60.1703, 24.9316),
  node(5, 60.1705, 24.9316),
  node(6, 60.1706, 24.9316, { railway: "subway_entrance", ref: "A" }),
  node(9, 60.17052, 24.93162, { shop: "bakery", name: "Leipomo", level: "-1", "level:ref": "K" }),
  way(100, [1, 2, 3], { railway: "platform", ref: "H1", level: "-1" }),
  way(101, [3, 4, 5], { highway: "corridor", level: "-1" }),
  way(102, [5, 6], { highway: "steps", level: "-1;0" }),
];
const station: GtfsStation = {
  id: "s",
  name: "Testi",
  lat: 60.17,
  lon: 24.9309,
  platforms: [{ stopId: "s1", code: "H1", lat: 60.17, lon: 24.9309 }],
};
const built = buildStation(station, elements, "");
const place = { name: "Testi", lat: 60.17, lon: 24.9309, stopId: "fi-hsl_s1" } as Place;

describe("indoor shops", () => {
  test("the walking network lists the shop on its floor", () => {
    expect(built.graph.pois).toMatchObject([{ name: "Leipomo", level: -1, floor: "K" }]);
  });

  test("a trip end matches the shop by name, or by being right next to it", () => {
    expect(findPoi(built.graph, { lat: 60.1708, lon: 24.9316, label: "Leipomo" })?.name).toBe(
      "Leipomo",
    );
    // Right next to it but with no name: a pavement point must not match a shop on floor -1.
    expect(findPoi(built.graph, { lat: 60.17052, lon: 24.93163 })).toBeUndefined();
    expect(findPoi(built.graph, { lat: 60.18, lon: 24.95 })).toBeUndefined();
  });

  test("the path goes from the platform to the shop without going up to the street", () => {
    const poi = built.graph.pois[0];
    if (!poi) throw new Error("no poi");
    const g = guideToPoi(built, built.graph, place, poi, "fastest", "out", 90);
    expect(g?.steps.map((s) => s.mode)).toEqual(["walk"]);
    expect(g?.line[0]?.[2]).toBe(-1);
    expect(g?.line.at(-1)?.[2]).toBe(-1);
    // The train runs east and the corridor leaves from the east end: get off at the front.
    expect(g?.trainPosition).toBeGreaterThan(0.9);
  });
});

describe("indoor paths that run outdoors", () => {
  test("are rejected, so the street route is used", () => {
    // The same corridor with no floor tag: it is a street, not an indoor walkway.
    // Node 4 moves south so the untagged stretch 4-5 is 44 m, over the 30 m allowance.
    const outdoor = elements.map((e) =>
      e.type === "way" && e.id === 101
        ? { ...e, tags: { highway: "footway" } }
        : e.type === "node" && e.id === 4
          ? { ...e, lat: 60.1701 }
          : e,
    );
    const b = buildStation(station, outdoor, "");
    const poi = { ...(built.graph.pois[0] as NonNullable<(typeof built.graph.pois)[0]>) };
    poi.node = b.graph.nodes.findIndex(([lng, lat]) => lng === 24.9316 && lat === 60.1705);
    expect(guideToPoi(b, b.graph, place, poi, "fastest", "out", 90)).toBeUndefined();
  });
});
