import { describe, expect, test } from "bun:test";

import { exitSign } from "./guidance";
import { areaAt, areasAlong, namedAreas, nearestStreet } from "./signs";
import type { LngLat } from "./station-types";

// A square "Itis" mall, one street south of it, and a station building that must be ignored.
const pts: Record<number, LngLat> = {
  1: [25.0, 60.2],
  2: [25.002, 60.2],
  3: [25.002, 60.201],
  4: [25.0, 60.201],
  10: [24.999, 60.1998],
  11: [25.003, 60.1998],
};
const ll = (id: number) => pts[id];
const ways: { id: number; nodes: number[]; tags: Record<string, string> }[] = [
  { id: 100, nodes: [1, 2, 3, 4, 1], tags: { shop: "mall", name: "Itis", building: "retail" } },
  { id: 101, nodes: [1, 2, 3, 4, 1], tags: { building: "yes", name: "Itäkeskuksen metroasema" } },
  { id: 102, nodes: [10, 11], tags: { highway: "residential", name: "Tallinnanaukio" } },
];

describe("signs", () => {
  const areas = namedAreas(ways, [], ll);

  test("keeps named malls and drops station buildings", () => {
    expect(areas.map((a) => a.name)).toEqual(["Itis"]);
  });

  test("finds the area an exit leads into and the street it opens onto", () => {
    const exit: LngLat = [25.001, 60.2001];
    expect(areaAt(exit, areas)).toBe("Itis");
    expect(nearestStreet(exit, ways, ll)).toBe("Tallinnanaukio");
  });

  test("lists the areas a path goes through", () => {
    expect(
      areasAlong(
        [
          [24.99, 60.2005],
          [25.001, 60.2005],
        ],
        areas,
      ),
    ).toEqual(["Itis"]);
  });

  test("builds the follow-signs text", () => {
    const sign = exitSign(
      { id: "1", ref: "D", lng: 0, lat: 0, level: 0, street: "Tallinnanaukio", place: "Itis" },
      "out",
    );
    expect(sign).toEqual({
      title: "Exit D",
      short: "exit D (Tallinnanaukio)",
      where: "Tallinnanaukio · Itis",
      signs: [],
    });
  });

  test("prefers the station's own sign destinations", () => {
    const sign = exitSign(
      {
        id: "1",
        ref: "D",
        lng: 0,
        lat: 0,
        level: 0,
        street: "Narinkkatori",
        signs: ["Kamppi Shopping Centre", "Forum Shopping Centre", "Kiasma"],
      },
      "out",
    );
    expect(sign.short).toBe("exit D (Kamppi Shopping Centre, Forum Shopping Centre)");
  });
});
