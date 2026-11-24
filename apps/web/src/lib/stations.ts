import { useEffect, useState } from "react";

import type { StationData, StationIndex } from "./station-types";
import type { WalkGraph } from "./walk-graph";

const base = `${import.meta.env.BASE_URL}data`;
/**
 * Bump when the station data format changes. The service worker serves cached data first, so
 * without a new URL a returning phone would read the old format once.
 */
export const DATA_VERSION = 3;
let indexPromise: Promise<StationIndex> | undefined;
const stationPromises = new Map<string, Promise<StationData>>();

export function loadIndex(): Promise<StationIndex> {
  indexPromise ??= fetch(`${base}/stations.json?v=${DATA_VERSION}`).then((r) => {
    if (!r.ok) throw new Error(`Station index ${r.status}`);
    return r.json() as Promise<StationIndex>;
  });
  return indexPromise;
}

export function loadStation(id: string): Promise<StationData> {
  let p = stationPromises.get(id);
  if (!p) {
    p = fetch(`${base}/stations/${id}.json?v=${DATA_VERSION}`).then((r) => {
      if (!r.ok) throw new Error(`Station ${id} ${r.status}`);
      return r.json() as Promise<StationData>;
    });
    stationPromises.set(id, p);
  }
  return p;
}

/** Loads the given stations; the map grows as files arrive. */
export function useStations(ids: string[]): Map<string, StationData> {
  const [loaded, setLoaded] = useState(() => new Map<string, StationData>());
  const key = [...new Set(ids)].toSorted().join(",");
  useEffect(() => {
    let live = true;
    const wanted = key ? key.split(",") : [];
    void Promise.all(wanted.map((id) => loadStation(id).catch(() => undefined))).then((list) => {
      if (!live) return;
      const next = new Map<string, StationData>();
      for (const s of list) if (s) next.set(s.id, s);
      setLoaded(next);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return loaded;
}

export function useStationIndex(): StationIndex | undefined {
  const [index, setIndex] = useState<StationIndex>();
  useEffect(() => {
    void loadIndex().then(setIndex, () => undefined);
  }, []);
  return index;
}

const graphPromises = new Map<string, Promise<WalkGraph | undefined>>();

/** A station's walking network, for routing to shops inside joined buildings. */
export function loadGraph(id: string): Promise<WalkGraph | undefined> {
  let p = graphPromises.get(id);
  if (!p) {
    p = fetch(`${base}/stations/${id}.graph.json?v=${DATA_VERSION}`)
      .then((r) => (r.ok ? (r.json() as Promise<WalkGraph>) : undefined))
      .catch(() => undefined);
    graphPromises.set(id, p);
  }
  return p;
}

export function useGraphs(ids: string[]): Map<string, WalkGraph> {
  const [loaded, setLoaded] = useState(() => new Map<string, WalkGraph>());
  const key = [...new Set(ids)].toSorted().join(",");
  useEffect(() => {
    let live = true;
    const wanted = key ? key.split(",") : [];
    void Promise.all(wanted.map(async (id) => [id, await loadGraph(id)] as const)).then((list) => {
      if (!live) return;
      setLoaded(new Map(list.filter((x): x is readonly [string, WalkGraph] => !!x[1])));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return loaded;
}
