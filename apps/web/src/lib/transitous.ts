/**
 * Client for the Transitous public routing API (MOTIS 2). No key; CORS is open.
 * Usage policy: https://transitous.org/api/ (open source, non-commercial, light use, attribution).
 */
import type { Profile } from "./station-types";

const API = "https://api.transitous.org/api";
/** Helsinki city centre, used to bias address search. */
const BIAS = "60.1699,24.9384";

export interface Place {
  name: string;
  lat: number;
  lon: number;
  level?: number;
  stopId?: string;
  parentId?: string;
  stopCode?: string;
  track?: string;
  departure?: string;
  arrival?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
}

export interface WalkStep {
  relativeDirection: string;
  distance: number;
  streetName: string;
  fromLevel: number;
  toLevel: number;
  polyline?: { points: string; precision: number };
}

export interface Alert {
  headerText?: string;
  descriptionText?: string;
  url?: string;
  effect?: string;
}

export interface Leg {
  mode: string;
  from: Place;
  to: Place;
  duration: number;
  startTime: string;
  endTime: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  realTime: boolean;
  distance?: number;
  routeShortName?: string;
  displayName?: string;
  headsign?: string;
  routeColor?: string;
  legGeometry: { points: string; precision: number; length: number };
  steps?: WalkStep[];
  intermediateStops?: Place[];
  alerts?: Alert[];
  cancelled?: boolean;
}

export interface Itinerary {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: Leg[];
}

export interface PlanResult {
  itineraries: Itinerary[];
  direct: Itinerary[];
}

export interface GeocodeMatch {
  type: string;
  name: string;
  id: string;
  lat: number;
  lon: number;
  street?: string;
  houseNumber?: string;
  areas?: { name: string; default?: boolean; adminLevel: number }[];
}

export async function geocode(text: string, signal?: AbortSignal): Promise<GeocodeMatch[]> {
  const url = new URL(`${API}/v1/geocode`);
  url.searchParams.set("text", text);
  url.searchParams.set("language", "en");
  url.searchParams.set("place", BIAS);
  url.searchParams.set("placeBias", "5");
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  return (await res.json()) as GeocodeMatch[];
}

export interface PlanRequest {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  profile: Profile;
  /** ISO time; omit for now. */
  time?: string;
  arriveBy?: boolean;
}

export async function plan(req: PlanRequest, signal?: AbortSignal): Promise<PlanResult> {
  const url = new URL(`${API}/v6/plan`);
  url.searchParams.set("fromPlace", `${req.from.lat},${req.from.lon}`);
  url.searchParams.set("toPlace", `${req.to.lat},${req.to.lon}`);
  url.searchParams.set("pedestrianProfile", req.profile === "stepFree" ? "WHEELCHAIR" : "FOOT");
  url.searchParams.set("numItineraries", "5");
  url.searchParams.set("language", "en");
  if (req.time) url.searchParams.set("time", req.time);
  if (req.arriveBy) url.searchParams.set("arriveBy", "true");
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Route search failed (${res.status})`);
  const data = (await res.json()) as Partial<PlanResult>;
  return { itineraries: data.itineraries ?? [], direct: data.direct ?? [] };
}

/** MOTIS ids are `fi-hsl_<GTFS id>`. */
export const gtfsId = (id: string | undefined) => id?.replace(/^fi-hsl_/, "");
