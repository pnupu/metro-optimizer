import { describe, expect, test } from "bun:test";

import {
  chooseEntrance,
  describeStep,
  endOf,
  guideItinerary,
  reverseSteps,
  trainPosition,
} from "./guidance";
import type { Platform, StationData, StationPath } from "./station-types";

const platform: Platform = {
  code: "H1",
  stopId: "1",
  axis: [
    [24.93, 60.17],
    [24.932, 60.17],
  ], // west → east
  meters: 110,
  level: -1,
  mapped: true,
};

const path = (entrance: string, position: number, seconds: number): StationPath => ({
  entrance,
  platform: "H1",
  profile: "fastest",
  meters: seconds,
  seconds,
  position,
  steps: [],
  line: [],
});

const station: StationData = {
  id: "s",
  name: "Test",
  lng: 24.931,
  lat: 60.17,
  levels: [0, -1],
  entrances: [
    { id: "west", ref: "A", lng: 24.929, lat: 60.1702, level: 0 },
    { id: "east", ref: "B", lng: 24.933, lat: 60.1702, level: 0 },
  ],
  platforms: [platform],
  paths: [path("west", 0.05, 60), path("east", 0.95, 60)],
  indoor: { type: "FeatureCollection", features: [] },
  osmTimestamp: "",
};

describe("trainPosition", () => {
  test("keeps the axis position when the train runs along the axis", () => {
    expect(trainPosition(platform, 90, 0.9)).toBe(0.9);
  });
  test("flips it when the train runs against the axis", () => {
    expect(trainPosition(platform, 270, 0.9)).toBeCloseTo(0.1);
  });
});

describe("endOf", () => {
  test("splits the train in three", () => {
    expect(endOf(0.8)).toBe("front");
    expect(endOf(0.5)).toBe("middle");
    expect(endOf(0.2)).toBe("back");
  });
});

describe("chooseEntrance", () => {
  test("picks the entrance nearest the street route", () => {
    const fromEast: [number, number][] = [
      [24.95, 60.171],
      [24.934, 60.1703],
    ];
    expect(chooseEntrance(station, "H1", "fastest", fromEast, "in")?.path.entrance).toBe("east");
  });
  test("for an exit, measures toward the destination", () => {
    const toWest: [number, number][] = [
      [24.928, 60.1703],
      [24.91, 60.171],
    ];
    expect(chooseEntrance(station, "H1", "fastest", toWest, "out")?.path.entrance).toBe("west");
  });
  test("falls back to the fastest path when the profile has none", () => {
    expect(chooseEntrance(station, "H1", "stepFree", [], "in")?.fallback).toBe(true);
  });
});

describe("steps", () => {
  test("an exit walks the path backwards", () => {
    const steps = reverseSteps([
      { mode: "walk", fromLevel: 0, toLevel: 0, meters: 40, seconds: 30 },
      { mode: "escalator", fromLevel: 0, toLevel: -2, meters: 30, seconds: 33 },
    ]);
    expect(steps.map(describeStep)).toEqual(["Take the escalator up to street level", "Walk 40 m"]);
  });
});

describe("guideItinerary", () => {
  const encode = (pts: [number, number][]) => {
    let out = "";
    let plat = 0;
    let plng = 0;
    const enc = (v: number) => {
      let n = v < 0 ? ~(v << 1) : v << 1;
      while (n >= 0x20) {
        out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
        n >>= 5;
      }
      out += String.fromCharCode(n + 63);
    };
    for (const [lng, lat] of pts) {
      const la = Math.round(lat * 1e6);
      const ln = Math.round(lng * 1e6);
      enc(la - plat);
      enc(ln - plng);
      plat = la;
      plng = ln;
    }
    return out;
  };
  const place = (stopId: string) => ({
    name: "x",
    lat: 60.17,
    lon: 24.931,
    stopId: `fi-hsl_${stopId}`,
    parentId: "fi-hsl_s",
  });
  const leg = (stopId: string) =>
    ({
      mode: "SUBWAY",
      from: { name: "far", lat: 60.17, lon: 24.9, stopId: "fi-hsl_other", parentId: "fi-hsl_far" },
      to: place(stopId),
      legGeometry: {
        points: encode([
          [24.9, 60.17],
          [24.931, 60.17],
        ]),
        precision: 6,
        length: 2,
      },
    }) as unknown as Parameters<typeof guideItinerary>[0][number];
  const lookup = (id: string) => (id === "s" ? station : undefined);

  test("matches the platform by stop id and gives the train end", () => {
    const [g] = guideItinerary([leg("1")], "fastest", lookup);
    expect(g?.alight?.platform.code).toBe("H1");
    expect(g?.trainEnd).toBeDefined();
  });

  test("gives no guide for an unknown platform instead of guessing", () => {
    const [g] = guideItinerary([leg("999")], "fastest", lookup);
    expect(g?.alight).toBeUndefined();
    expect(g?.trainEnd).toBeUndefined();
  });
});
