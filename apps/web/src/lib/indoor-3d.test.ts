import { describe, expect, test } from "bun:test";

import { build3d, build3dLabels, FLOOR_HEIGHT, floorHeight, lowestFloor, strip } from "./indoor-3d";
import type { StationData } from "./station-types";

const station = {
  entrances: [],
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

test("cut-away hides upper route strips and caps a rising connector", () => {
  const shapes = build3d(
    [],
    [
      [
        [24.93, 60.17, -4],
        [24.931, 60.17, 0],
        [24.9315, 60.17, 0],
      ],
    ],
    -4,
    false,
  ).features;
  expect(shapes).toHaveLength(2);
  expect(shapes[1]?.properties.top).toBeLessThan(floorHeight(-2, -4));
});

describe("street links and raised labels", () => {
  const stationWithDoors = {
    ...station,
    indoor: {
      ...station.indoor,
      features: [
        ...station.indoor.features,
        {
          type: "Feature" as const,
          properties: { kind: "poi", name: "Shop", lmin: 0, lmax: 0 },
          geometry: { type: "Point" as const, coordinates: [24.93, 60.17] as [number, number] },
        },
      ],
    },
    entrances: [
      { id: "street", ref: "A", lng: 24.93, lat: 60.17, level: 0 },
      { id: "lift", ref: "B", lng: 24.931, lat: 60.17, level: -2, liftTo: 0 },
      { id: "upper", ref: "C", lng: 24.932, lat: 60.17, level: 1 },
    ],
  };

  test("grounds street entrances and preserves the visible landing of a street lift", () => {
    const onStreet = build3d([stationWithDoors], [], 1, false).features;
    const columns = onStreet.filter(({ properties: p }) => p.base === 0 && p.top > 1);
    expect(columns).toHaveLength(2);
    expect(columns[0]?.properties.top).toBeCloseTo(floorHeight(0, -2) + 0.6);

    const below = build3d([stationWithDoors], [], -2, false).features;
    const shaft = below.find(({ properties: p }) => p.base === 0 && p.top > 1);
    expect(shaft?.properties.top).toBeCloseTo(floorHeight(-2, -2) + 0.6);
  });

  test("puts the destination and named floor at slab height, with upper labels cut away", () => {
    const point: [number, number] = [24.93, 60.17];
    const labels = build3dLabels(
      stationWithDoors,
      [],
      0,
      -2,
      [
        { kind: "destination", text: "Shop", point, level: 0 },
        { kind: "route", text: "Upstairs stop", point, level: 1 },
      ],
      new Set(),
      new Map([[0, "M"]]),
    );
    expect(labels.find((label) => label.kind === "current-floor")?.text).toBe("M");
    expect(labels.filter((label) => label.text === "Shop")).toHaveLength(1);
    expect(labels.find((label) => label.kind === "destination")?.height).toBeCloseTo(
      floorHeight(0, -2) + 0.6,
    );
    expect(labels.some((label) => label.text === "Upstairs stop" || label.text === "Exit C")).toBe(
      false,
    );
    expect(labels.find((label) => label.text === "−2")?.height).toBeCloseTo(
      floorHeight(-2, -2) + 0.6,
    );
  });

  test("a pin with no known floor stays on the current floor", () => {
    const point: [number, number] = [24.93, 60.17];
    const labels = build3dLabels(
      station,
      [],
      -2,
      -2,
      [{ kind: "route", text: "Board", point, level: null }],
      new Set(),
      new Map(),
    );
    expect(labels.find((label) => label.text === "Board")?.height).toBeCloseTo(
      floorHeight(-2, -2) + 0.6,
    );
  });
});

test("highlights a walkthrough lift as a raised connection", () => {
  const point: [number, number] = [24.93, 60.17];
  const shapes = build3d(
    [],
    [],
    -2,
    false,
    {
      points: [point, point],
      level: -2,
      line: [
        [...point, -2],
        [...point, 0],
      ],
    },
    -2,
  ).features;
  const highlight = shapes.find(({ properties }) => properties.color === "#facc15");
  expect(highlight?.properties.base).toBe(floorHeight(-2, -2));
  expect(highlight?.properties.top).toBeGreaterThan(floorHeight(-1, -2));
});
