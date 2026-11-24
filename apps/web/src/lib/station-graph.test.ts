import { describe, expect, test } from "bun:test";

import { buildStation, type GtfsStation, type OsmElement, parseLevels } from "./station-graph";

// A made-up station: platform at level -1 running west to east, entrance A at street level.
// Stairs reach the west end of the platform; an elevator reaches its middle.
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
  node(1, 60.17, 24.93), // platform west end
  node(2, 60.17, 24.9309), // platform middle
  node(3, 60.17, 24.9318), // platform east end
  node(10, 60.1702, 24.9295, { railway: "subway_entrance", ref: "A", wheelchair: "yes" }),
  node(11, 60.1701, 24.9298),
  node(12, 60.1702, 24.9309, { highway: "elevator", level: "-1;0" }),
  node(13, 60.1701, 24.9309),
  way(100, [1, 2, 3], {
    railway: "platform",
    public_transport: "platform",
    ref: "H9001",
    level: "-1",
  }),
  way(101, [10, 11], { highway: "footway", level: "0" }),
  way(102, [11, 1], { highway: "steps", level: "-1;0" }),
  way(103, [10, 12], { highway: "footway", level: "0" }),
  way(104, [12, 13, 2], { highway: "footway", level: "-1" }),
];
const station: GtfsStation = {
  id: "9000",
  name: "Testi",
  lat: 60.17,
  lon: 24.9309,
  platforms: [{ stopId: "9001", code: "H9001", lat: 60.17, lon: 24.9309 }],
};

describe("parseLevels", () => {
  test("lists, ranges and negatives", () => {
    expect(parseLevels("-2;-1;0")).toEqual([-2, -1, 0]);
    expect(parseLevels("0-2")).toEqual([0, 1, 2]);
    expect(parseLevels("-3--1")).toEqual([-3, -2, -1]);
    expect(parseLevels(undefined)).toEqual([]);
  });
});

describe("buildStation", () => {
  const data = buildStation(station, elements, "2026-11-24T00:00:00Z");
  const path = (profile: string) => data.paths.find((p) => p.profile === profile);

  test("matches the GTFS platform to the OSM platform by stop code", () => {
    expect(data.platforms[0]?.mapped).toBe(true);
    expect(data.platforms[0]?.level).toBe(-1);
  });

  test("the fastest path takes the stairs to the west end", () => {
    const p = path("fastest");
    expect(p?.steps.map((s) => s.mode)).toEqual(["walk", "stairs"]);
    expect(p?.position).toBeLessThan(0.1);
  });

  test("the step-free path takes the elevator to the middle", () => {
    const p = path("stepFree");
    expect(p?.steps.some((s) => s.mode === "stairs")).toBe(false);
    expect(p?.steps.find((s) => s.mode === "elevator")).toMatchObject({
      fromLevel: 0,
      toLevel: -1,
    });
    expect(p?.position).toBeCloseTo(0.5, 1);
  });

  test("indoor features carry their level range", () => {
    const platform = data.indoor.features.find((f) => f.properties.kind === "platform");
    expect(platform?.properties).toMatchObject({ lmin: -1, lmax: -1 });
    expect(data.levels).toContain(-1);
  });
});
