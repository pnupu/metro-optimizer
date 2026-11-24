import { describe, expect, test } from "bun:test";

import { build3d, FLOOR_HEIGHT, lowestFloor, strip } from "./indoor-3d";
import type { StationData } from "./station-types";

const station = {
  indoor: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "footway", lmin: -2, lmax: -2 },
        geometry: {
          type: "LineString",
          coordinates: [
            [24.93, 60.17],
            [24.931, 60.17],
          ],
        },
      },
      {
        type: "Feature",
        properties: { kind: "escalator", lmin: -2, lmax: 0 },
        geometry: {
          type: "LineString",
          coordinates: [
            [24.931, 60.17],
            [24.931, 60.1705],
          ],
        },
      },
    ],
  },
} as unknown as StationData;

describe("build3d", () => {
  const shapes = build3d([station], [], 0, false).features;

  test("puts the lowest floor one floor above the ground and stacks the rest", () => {
    // The walkway is on floor -2, below the current floor 0, so it has the dimmed colour.
    const walkway = shapes.find((s) => s.properties.color === "#cbd5e1");
    expect(walkway?.properties.base).toBe(FLOOR_HEIGHT);
  });

  test("an escalator is a column from its lower floor to its upper floor", () => {
    const esc = shapes.find((s) => s.properties.color === "#2563eb");
    expect(esc?.properties.base).toBe(FLOOR_HEIGHT);
    expect(esc?.properties.top).toBeGreaterThan(3 * FLOOR_HEIGHT);
  });

  test("a path that changes floor gets a column between the floors", () => {
    const path = build3d(
      [station],
      [
        [
          [24.93, 60.17, -2],
          [24.931, 60.17, -2],
          [24.931, 60.1705, 0],
        ],
      ],
      -2,
      false,
    ).features.filter((s) => s.properties.color === "#ff6319");
    // One strip on floor -2, then the floor change: its run and its column.
    expect(path).toHaveLength(3);
    expect(path[2]?.properties.top).toBeGreaterThan(path[0]?.properties.top as number);
  });
});

describe("cut-away", () => {
  test("floors above the current one are left out, so they do not hide it", () => {
    const below = build3d([station], [], -3, false).features;
    expect(below).toHaveLength(0);
  });
});

describe("strip", () => {
  test("is a closed rectangle about the given width", () => {
    const r = strip([24.93, 60.17], [24.931, 60.17], 4);
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual(r[4]);
    const widthDeg = Math.abs((r[0] as [number, number])[1] - (r[3] as [number, number])[1]);
    expect(widthDeg * 111_320).toBeCloseTo(4, 1);
  });
});

describe("floor heights", () => {
  test("include the path's floors, so a deep path never goes under the ground", () => {
    expect(lowestFloor([station], [[[24.93, 60.17, -5]]])).toBe(-5);
  });

  test("a floor change draws the run on the lower floor as well as the column", () => {
    const shapes = build3d(
      [],
      [
        [
          [24.93, 60.17, -2],
          [24.931, 60.17, 0],
        ],
      ],
      0,
      false,
      undefined,
      -2,
    );
    const path = shapes.features.filter((s) => s.properties.color === "#ff6319");
    expect(path).toHaveLength(2);
    expect(path[0]?.properties.base).toBeCloseTo(FLOOR_HEIGHT + 0.6);
  });
});
