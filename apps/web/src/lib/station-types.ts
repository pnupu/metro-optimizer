/** Shared types for the station data that `scripts/build-data.ts` writes and the app reads. */

export type Profile = "fastest" | "noStairs" | "stepFree";
export const PROFILES: readonly Profile[] = ["fastest", "noStairs", "stepFree"];

/** Fixed cost of one lift ride (wait and ride), seconds. */
export const ELEVATOR_SECONDS = 45;

/** `level` is a level change that OSM does not describe (no stairs, escalator or elevator mapped). */
export type Mode = "walk" | "stairs" | "escalator" | "elevator" | "level";

export type LngLat = [lng: number, lat: number];
/** A path vertex: longitude, latitude, OSM level (null when OSM gives no level). */
export type PathVertex = [lng: number, lat: number, level: number | null];

export interface PathStep {
  mode: Mode;
  fromLevel: number | null;
  toLevel: number | null;
  meters: number;
  seconds: number;
  /** The part of the path line this step covers: vertex indices, first and last. */
  a: number;
  b: number;
}

/** The best path between one entrance and one platform for one profile. */
export interface StationPath {
  entrance: string;
  platform: string;
  profile: Profile;
  meters: number;
  seconds: number;
  /** Where the path reaches the platform: 0 = first axis end, 1 = second axis end. */
  position: number;
  steps: PathStep[];
  line: PathVertex[];
  /** Named buildings or shopping centres the path goes through. */
  via?: string[];
}

export interface Entrance {
  id: string;
  ref?: string;
  name?: string;
  lng: number;
  lat: number;
  level: number | null;
  wheelchair?: string;
  /** Street the exit opens onto (OSM address, else the nearest named street). */
  street?: string;
  /** Named building, shopping centre or square the exit leads into. */
  place?: string;
  /** For an entrance that is a lift: the floor the lift goes up to (usually the street). */
  liftTo?: number;
  /** Destinations on the station's exit signs (from the city's station guide map). */
  signs?: string[];
}

export interface Platform {
  /** HSL stop code, for example `H0016`. */
  code: string;
  stopId: string;
  description?: string;
  /** The two ends of the platform, as found in OSM. */
  axis: [LngLat, LngLat];
  meters: number;
  level: number | null;
  /** False when no OSM platform was found and the axis is a guess. */
  mapped: boolean;
}

export interface IndoorProps {
  kind: string;
  name?: string;
  ref?: string;
  lmin: number;
  lmax: number;
}

export interface IndoorFeature {
  type: "Feature";
  properties: IndoorProps;
  geometry:
    | { type: "Point"; coordinates: LngLat }
    | { type: "LineString"; coordinates: LngLat[] }
    | { type: "Polygon"; coordinates: LngLat[][] };
}

export interface StationData {
  id: string;
  name: string;
  lng: number;
  lat: number;
  levels: number[];
  entrances: Entrance[];
  platforms: Platform[];
  paths: StationPath[];
  indoor: { type: "FeatureCollection"; features: IndoorFeature[] };
  osmTimestamp: string;
  /** The City of Helsinki station guide map (PDF), when one exists. */
  guideMap?: string;
}

export interface StationIndexEntry {
  id: string;
  name: string;
  lng: number;
  lat: number;
  platforms: string[];
  entrances: number;
  pathCount: number;
}

export interface StationIndex {
  generated: string;
  stations: StationIndexEntry[];
}
