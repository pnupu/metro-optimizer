import { describe, expect, test } from "bun:test";

import { reverseSteps } from "./guidance";
import {
  buildIndoorScene3d,
  floorHeight,
  floorLabel3d,
  floorNames3d,
  lowestFloor,
  plateOutline,
  ROUTE_LIFT,
  type Route3d,
  routeSections3d,
} from "./indoor-3d";
import type { LngLat, PathStep, PathVertex, StationData } from "./station-types";

const a: LngLat = [24.93, 60.17];
const b: LngLat = [24.9305, 60.17];
const c: LngLat = [24.931, 60.17];
const d: LngLat = [24.931, 60.1702];
const step = (
  mode: PathStep["mode"],
  fromLevel: number,
  toLevel: number,
  a: number,
  b: number,
): PathStep => ({ mode, fromLevel, toLevel, a, b, meters: 25, seconds: 20 });

const station: StationData = {
  id: "station",
  name: "Station",
  lng: a[0],
  lat: a[1],
  levels: [1, 0, -2, -4],
  entrances: [],
  platforms: [],
  paths: [],
  osmTimestamp: "",
  indoor: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "footway", lmin: -4, lmax: -4 },
        geometry: { type: "LineString", coordinates: [a, b] },
      },
      {
        type: "Feature",
        properties: { kind: "escalator", lmin: -4, lmax: 0 },
        geometry: { type: "LineString", coordinates: [b, c, d] },
      },
      {
        type: "Feature",
        properties: { kind: "elevator", lmin: -4, lmax: 0 },
        geometry: { type: "Point", coordinates: b },
      },
      {
        type: "Feature",
        properties: { kind: "footway", lmin: -2, lmax: -2 },
        geometry: { type: "LineString", coordinates: [b, c] },
      },
      {
        type: "Feature",
        properties: { kind: "room", name: "Off-route shop", lmin: 0, lmax: 0 },
        geometry: { type: "Polygon", coordinates: [[a, b, d, a]] },
      },
    ],
  },
};

describe("raised route", () => {
  test("spreads the rise along an escalator using distance between surveyed points", () => {
    const escalator = step("escalator", -4, 0, 1, 3);
    const route: Route3d = {
      line: [
        [...a, -4],
        [...b, -4],
        [...c, -4],
        [...d, 0],
      ],
      steps: [step("walk", -4, -4, 0, 1), escalator],
      fallbackLevel: -4,
    };
    const sections = routeSections3d(route);
    const ramp = sections.find((s) => s.step === escalator)!;
    const walk = sections.find((s) => s.step?.mode === "walk")!;
    expect(walk.points.at(-1)).toEqual(ramp.points[0]!);
    expect(ramp.points.map((p) => p.slice(0, 2))).toEqual([b, c, d]);
    expect(ramp.points.map((p) => p[2])).toEqual([-4, expect.closeTo(-1.78, 1), 0]);
    expect(ramp.shaft).toBeUndefined();
    const reverse = routeSections3d({
      ...route,
      line: route.line.toReversed(),
      steps: reverseSteps(route.steps, route.line.length),
    }).find((s) => s.step?.mode === "escalator");
    expect(reverse?.points[1]?.[2]).toBeCloseTo(ramp.points[1]![2], 8);
    expect(reverse?.points[0]).toEqual([...d, 0]);
  });

  test("uses a vertical lift shaft with walks to and from it in both directions", () => {
    const lift = step("elevator", -4, 0, 1, 1);
    const line: PathVertex[] = [
      [...a, -4],
      [...b, -4],
      [...c, 0],
      [...d, 0],
    ];
    const steps = [step("walk", -4, -4, 0, 1), lift, step("walk", 0, 0, 2, 3)];
    const up = routeSections3d({ line, steps, fallbackLevel: -4 }, [b]);
    const down = routeSections3d(
      {
        line: line.toReversed(),
        steps: reverseSteps(steps, line.length),
        fallbackLevel: 0,
      },
      [b],
    );
    expect(up.find((s) => s.shaft)?.shaft).toEqual([
      [...b, -4],
      [...b, 0],
    ]);
    expect(down.find((s) => s.shaft)?.shaft).toEqual([
      [...b, 0],
      [...b, -4],
    ]);
    expect(up.find((s) => s.shaft)?.points.at(-1)).toEqual([...c, 0]);
    expect(down.find((s) => s.shaft)?.points[0]).toEqual([...c, 0]);
    expect(up.filter((s) => s.step?.mode === "walk")).toHaveLength(2);
    expect(down.filter((s) => s.step?.mode === "walk")).toHaveLength(2);
  });

  test("renders an entrance lift even if the route lacks its upper landing vertex", () => {
    const lift = step("elevator", -4, 0, 1, 1);
    const sections = routeSections3d({
      line: [
        [...a, -4],
        [...b, -4],
      ],
      steps: [step("walk", -4, -4, 0, 1), lift],
      fallbackLevel: -4,
    });
    expect(sections[0]?.shaft).toEqual([
      [...b, -4],
      [...b, 0],
    ]);
  });

  test("puts an unlevelled path and platform on the fallback floor", () => {
    const route: Route3d = {
      line: [
        [...a, null],
        [...b, null],
      ],
      steps: [],
      fallbackLevel: -4,
    };
    const scene = buildIndoorScene3d(
      station,
      [route],
      -4,
      [{ text: "Board", point: a, level: null, kind: "route" }],
      new Map(),
    );
    expect(scene.plates.map(({ level }) => level)).toEqual([-4]);
    expect(scene.labels.find((label) => label.text === "Board")?.anchors[0]?.[2]).toBeCloseTo(
      floorHeight(-4, -4) + ROUTE_LIFT,
    );
    expect(scene.route[0]?.points[0]?.[2]).toBeCloseTo(floorHeight(-4, -4) + ROUTE_LIFT);
  });
});

describe("schematic plates and labels", () => {
  test("makes a bounded plate even if a floor is mapped as one point", () => {
    const outline = plateOutline([a, a], a[1]);
    expect(outline).toHaveLength(4);
    expect(Math.min(...outline.map((p) => p[0]))).toBeLessThan(a[0]);
    expect(Math.max(...outline.map((p) => p[1]))).toBeGreaterThan(a[1]);
  });

  test("keeps both route floors visible, with text on their edges, during a lower step", () => {
    const escalator = step("escalator", -4, 0, 1, 2);
    const scene = buildIndoorScene3d(
      station,
      [
        {
          line: [
            [...a, -4],
            [...b, -4],
            [...d, 0],
          ],
          steps: [escalator],
          fallbackLevel: -4,
        },
      ],
      -4,
      [{ text: "Shop", point: d, level: 0, kind: "destination" }],
      new Map([[0, "M"]]),
      { step: escalator, points: [b, d], level: -4 },
    );
    expect(scene.plates.map(({ level, active }) => [level, active])).toEqual([
      [-4, true],
      [0, false],
    ]);
    const floor = scene.labels.find((label) => label.kind === "floor")!;
    expect(floor.text).toBe("M");
    const [first, second] = scene.plates[1]!.ring;
    expect(floor.anchors[0]).toEqual([
      first![0] + (second![0] - first![0]) / 2,
      first![1] + (second![1] - first![1]) / 2,
      first![2],
    ]);
    expect(
      scene.labels.filter((label) => !label.kind.includes("floor")).map(({ text }) => text),
    ).toEqual(["Shop", "Escalator ↑ M"]);
    expect(scene.labels.find(({ kind }) => kind === "active")?.anchors[0]?.[2]).toBeCloseTo(
      (floorHeight(-4, -4) + floorHeight(0, -4)) / 2 + ROUTE_LIFT,
    );
    expect(scene.route.find(({ active }) => active)?.ramp).toBe(true);
  });

  test("joins the route to the boarding point on the platform", () => {
    const route: Route3d = {
      line: [
        [...b, -4],
        [...c, -4],
      ],
      steps: [],
      fallbackLevel: -4,
    };
    const scene = buildIndoorScene3d(
      station,
      [route],
      -4,
      [{ text: "Board at the back", point: a, pathPoint: b, level: -4, kind: "route" }],
      new Map(),
    );
    const height = floorHeight(-4, -4) + ROUTE_LIFT;
    expect(scene.route.map(({ points }) => points)).toEqual([
      [
        [...b, height],
        [...c, height],
      ],
      [
        [...a, height],
        [...b, height],
      ],
    ]);
  });

  test("honors a named mezzanine and replaces literal OSM fractional numbering", () => {
    const names = floorNames3d([
      { level: 0.5, floor: " M " },
      { level: 0.5, floor: "M" },
      { level: -0.5, floor: "G" },
      { level: -0.5, floor: "K" },
      { level: 1.5, floor: "1.5" },
    ]);
    expect(floorLabel3d(0.5, names)).toBe("M");
    expect(floorLabel3d(-0.5, names)).toBe("0 mezz.");
    expect(floorLabel3d(1.5, names)).toBe("1 mezz.");
    expect(floorLabel3d(-4, names)).toBe("−4");
  });

  test("sets a stable height even for a lower level that appears only in the guide", () => {
    expect(
      lowestFloor(station, [
        {
          line: [[...a, -4]],
          steps: [step("elevator", -6, -4, 0, 0)],
          fallbackLevel: -4,
        },
      ]),
    ).toBe(-6);
  });
});

test("an escalator step with an out-of-range floor is not drawn as a ramp", () => {
  const escalator = step("escalator", -4, 0, 0, 1);
  const scene = buildIndoorScene3d(
    station,
    [
      {
        line: [
          [...a, -4],
          [...b, -4],
        ],
        steps: [{ ...escalator, fromLevel: -99 }],
        fallbackLevel: -4,
      },
    ],
    -4,
    [],
    new Map(),
  );
  expect(scene.route.some((section) => section.ramp)).toBe(false);
});
