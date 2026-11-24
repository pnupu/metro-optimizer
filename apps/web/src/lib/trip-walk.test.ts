import { describe, expect, test } from "bun:test";

import { guideItinerary } from "./guidance";
import type { StationData } from "./station-types";
import type { Itinerary, Leg } from "./transitous";
import { cut, tripWalkthrough } from "./trip-walk";

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
const geom = (pts: [number, number][]) => ({
  points: encode(pts),
  precision: 6,
  length: pts.length,
});

// One station: entrance A at street level, an escalator down to the platform (level -1).
const station = (id: string, lng: number): StationData => ({
  id,
  name: id,
  lng,
  lat: 60.17,
  levels: [0, -1],
  entrances: [{ id: `${id}-A`, ref: "A", lng, lat: 60.1705, level: 0, street: "Katu" }],
  platforms: [
    {
      code: `H${id}`,
      stopId: `${id}1`,
      axis: [
        [lng - 0.001, 60.17],
        [lng + 0.001, 60.17],
      ],
      meters: 110,
      level: -1,
      mapped: true,
    },
  ],
  paths: [
    {
      entrance: `${id}-A`,
      platform: `H${id}`,
      profile: "fastest",
      meters: 60,
      seconds: 60,
      position: 0.5,
      steps: [
        { mode: "walk", fromLevel: 0, toLevel: 0, meters: 20, seconds: 15, a: 0, b: 1 },
        { mode: "escalator", fromLevel: 0, toLevel: -1, meters: 40, seconds: 45, a: 1, b: 2 },
      ],
      line: [
        [lng, 60.1705, 0],
        [lng, 60.1703, 0],
        [lng, 60.17, -1],
      ],
    },
  ],
  indoor: { type: "FeatureCollection", features: [] },
  osmTimestamp: "",
});
const stations = new Map([
  ["s1", station("s1", 24.93)],
  ["s2", station("s2", 24.96)],
]);

const walk = (pts: [number, number][]): Leg =>
  ({
    mode: "WALK",
    from: { name: "a", lat: pts[0]?.[1], lon: pts[0]?.[0] },
    to: { name: "b", lat: pts.at(-1)?.[1], lon: pts.at(-1)?.[0] },
    duration: 120,
    startTime: "2026-11-24T20:00:00Z",
    endTime: "2026-11-24T20:02:00Z",
    scheduledStartTime: "2026-11-24T20:00:00Z",
    scheduledEndTime: "2026-11-24T20:02:00Z",
    realTime: false,
    legGeometry: geom(pts),
    steps: [
      {
        relativeDirection: "CONTINUE",
        streetName: "Katu",
        distance: 200,
        fromLevel: 0,
        toLevel: 0,
        polyline: geom(pts),
      },
    ],
  }) as Leg;

const ride = {
  mode: "SUBWAY",
  routeShortName: "M1",
  headsign: "Vuosaari",
  from: { name: "s1", lat: 60.17, lon: 24.93, stopId: "fi-hsl_s11", parentId: "fi-hsl_s1" },
  to: { name: "s2", lat: 60.17, lon: 24.96, stopId: "fi-hsl_s21", parentId: "fi-hsl_s2" },
  duration: 300,
  startTime: "2026-11-24T20:03:00Z",
  endTime: "2026-11-24T20:08:00Z",
  scheduledStartTime: "2026-11-24T20:03:00Z",
  scheduledEndTime: "2026-11-24T20:08:00Z",
  realTime: true,
  intermediateStops: [{}, {}],
  legGeometry: geom([
    [24.93, 60.17],
    [24.96, 60.17],
  ]),
} as unknown as Leg;

const itinerary: Itinerary = {
  duration: 900,
  startTime: "2026-11-24T20:00:00Z",
  endTime: "2026-11-24T20:15:00Z",
  transfers: 0,
  legs: [
    walk([
      [24.925, 60.172],
      [24.93, 60.1706],
      [24.93, 60.17],
    ]),
    ride,
    walk([
      [24.96, 60.17],
      [24.96, 60.1706],
      [24.965, 60.172],
    ]),
  ],
};

describe("tripWalkthrough", () => {
  const guides = guideItinerary(itinerary.legs, "fastest", (id) => stations.get(id));
  const trip = tripWalkthrough(itinerary, guides, (p) => p.name);

  test("covers the whole trip in order", () => {
    expect(trip.items.map((i) => i.kind)).toEqual([
      "street",
      "entrance",
      "walk",
      "escalator",
      "platform",
      "ride",
      "platform",
      "escalator",
      "walk",
      "entrance",
      "street",
      "arrive",
    ]);
  });

  test("the street walk ends at the chosen entrance and the next walk starts at the exit", () => {
    expect(trip.items[0]?.points.at(-1)).toEqual([24.93, 60.1705]);
    expect(trip.items[0]?.text).toContain("to entrance A");
    expect(trip.items[10]?.points[0]).toEqual([24.96, 60.1705]);
  });

  test("station cards open the walk at their own first item", () => {
    const g = guides[0];
    expect(g?.board && trip.starts.get(g.board)).toBe(1);
    expect(g?.alight && trip.starts.get(g.alight)).toBe(6);
  });
});

describe("cut", () => {
  const chunks = [
    {
      street: "A",
      level: 0,
      points: [
        [0, 0],
        [1, 0],
        [2, 0],
      ] as [number, number][],
    },
    {
      street: "B",
      level: 0,
      points: [
        [2, 0],
        [3, 0],
        [4, 0],
      ] as [number, number][],
    },
  ];

  test("keeps the walk between an exit and an entrance on the same line", () => {
    const out = cut(chunks, [1, 0.01], [3, 0.01]);
    expect(out.map((c) => c.street)).toEqual(["A", "B"]);
    expect(out[0]?.points[0]).toEqual([1, 0.01]);
    expect(out.at(-1)?.points.at(-1)).toEqual([3, 0.01]);
  });

  test("does not crash when the exit lies past the entrance", () => {
    const out = cut(chunks, [4, 0.01], [0, 0.01]);
    expect(out).toEqual([
      {
        street: "A",
        level: 0,
        points: [
          [4, 0.01],
          [0, 0.01],
        ],
      },
    ]);
  });
});
