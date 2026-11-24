import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpDown, ChevronDown, ChevronUp, Info, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { ItineraryDetail, ItinerarySummary, stationIdOf } from "@/components/itinerary";
import { MapView } from "@/components/map-view";
import { PlaceInput, type PlaceValue } from "@/components/place-input";
import { guideItinerary, type MetroGuide, type WalkItem } from "@/lib/guidance";
import type { Profile } from "@/lib/station-types";
import { useStationIndex, useStations } from "@/lib/stations";
import { gtfsId, type Itinerary, type Place, plan } from "@/lib/transitous";

const search = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  p: z.enum(["fastest", "noStairs", "stepFree"]).optional(),
  at: z.string().optional(),
  arrive: z.boolean().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: search,
  component: Planner,
});

const encode = (p?: PlaceValue) =>
  p ? `${p.lat.toFixed(6)},${p.lon.toFixed(6)},${p.label}` : undefined;
function decode(s?: string): PlaceValue | undefined {
  if (!s) return undefined;
  const [lat, lon, ...rest] = s.split(",");
  const v = { lat: Number(lat), lon: Number(lon), label: rest.join(",") || "Pinned place" };
  return Number.isFinite(v.lat) && Number.isFinite(v.lon) ? v : undefined;
}

const PROFILE_LABEL: Record<Profile, string> = {
  fastest: "Fastest",
  noStairs: "No stairs",
  stepFree: "Step-free",
};

type Sheet = "min" | "half" | "full";

function Planner() {
  const params = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const from = useMemo(() => decode(params.from), [params.from]);
  const to = useMemo(() => decode(params.to), [params.to]);
  const profile: Profile = params.p ?? "fastest";
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<number | null>(null);
  const [walk, setWalk] = useState<{ items: WalkItem[]; index: number }>();
  const [sheet, setSheet] = useState<Sheet>("half");
  const [about, setAbout] = useState(false);

  const set = useCallback(
    (patch: Partial<z.infer<typeof search>>) =>
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );

  useEffect(() => {
    if (!from || !to) {
      setItineraries([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(undefined);
    setSelected(null);
    plan(
      {
        from,
        to,
        profile,
        ...(params.at && !Number.isNaN(Date.parse(params.at))
          ? { time: new Date(params.at).toISOString() }
          : {}),
        ...(params.arrive ? { arriveBy: true } : {}),
      },
      ctrl.signal,
    )
      .then((r) => {
        setItineraries(r.itineraries);
        if (r.itineraries.length === 0) setError("No routes found for this trip.");
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : "Route search failed.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [from, to, profile, params.at, params.arrive]);

  const index = useStationIndex();
  const names = useMemo(() => new Map(index?.stations.map((s) => [s.id, s.name])), [index]);
  const metroIds = useMemo(
    () =>
      itineraries
        .flatMap((it) =>
          it.legs
            .filter((l) => l.mode === "SUBWAY")
            .flatMap((l) => [stationIdOf(l.from), stationIdOf(l.to)]),
        )
        .filter((id): id is string => !!id),
    [itineraries],
  );
  const stations = useStations(metroIds);
  const guides = useMemo<MetroGuide[][]>(
    () => itineraries.map((it) => guideItinerary(it.legs, profile, (id) => stations.get(id))),
    [itineraries, profile, stations],
  );
  const nameOf = useCallback(
    (p: Place) => {
      if (p.name === "START") return from?.label ?? "Start";
      if (p.name === "END") return to?.label ?? "Destination";
      return names.get(gtfsId(p.parentId) ?? "") ?? p.name;
    },
    [names, from, to],
  );

  const current = selected === null ? undefined : itineraries[selected];
  useEffect(() => setWalk(undefined), [selected, itineraries]);

  return (
    <div className="relative h-svh w-full overflow-hidden md:grid md:grid-cols-[420px_1fr]">
      <div className="absolute inset-0 md:relative md:order-2">
        <MapView
          itinerary={current ?? itineraries[0]}
          guides={guides[selected ?? 0] ?? []}
          {...(from ? { from } : {})}
          {...(to ? { to } : {})}
          {...(walk ? { walk } : {})}
          onWalk={(index) =>
            setWalk((w) => (w && index !== undefined ? { ...w, index } : undefined))
          }
        />
      </div>

      <aside
        className={`absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl border-t bg-background shadow-[0_-8px_30px_rgba(0,0,0,0.18)] transition-[max-height] duration-300 md:static md:order-1 md:h-svh md:max-h-none md:rounded-none md:border-t-0 md:border-r md:shadow-none ${
          sheet === "full" ? "max-h-[88svh]" : sheet === "half" ? "max-h-[58svh]" : "max-h-[132px]"
        }`}
      >
        <button
          type="button"
          className="mx-auto flex h-6 w-full items-center justify-center md:hidden"
          aria-label={sheet === "full" ? "Make the panel smaller" : "Make the panel larger"}
          onClick={() => setSheet((s) => (s === "min" ? "half" : s === "half" ? "full" : "min"))}
        >
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
        </button>
        <div className="shrink-0 px-3 pb-2 md:pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h1 className="font-semibold text-base">
              <span className="mr-1.5 inline-grid size-6 place-items-center rounded bg-[#ff6319] font-bold text-sm text-white">
                M
              </span>
              Metro Optimizer
            </h1>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="grid size-8 place-items-center rounded hover:bg-muted md:hidden pointer-coarse:size-11"
                aria-label={sheet === "min" ? "Show routes" : "Show map"}
                onClick={() => setSheet((s) => (s === "min" ? "half" : "min"))}
              >
                {sheet === "min" ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
              </button>
              <button
                type="button"
                className="grid size-8 place-items-center rounded hover:bg-muted pointer-coarse:size-11"
                aria-label="About and data sources"
                onClick={() => setAbout(true)}
              >
                <Info className="size-4" />
              </button>
            </div>
          </div>
          <div className="relative space-y-1.5">
            <PlaceInput
              label="From"
              value={from}
              onChange={(v) => set({ from: encode(v) })}
              allowLocate
            />
            <PlaceInput label="To" value={to} onChange={(v) => set({ to: encode(v) })} />
            <button
              type="button"
              aria-label="Swap start and destination"
              className="absolute top-1/2 right-[-2px] grid size-7 -translate-y-1/2 translate-x-1/2 place-items-center rounded-full border bg-background shadow hover:bg-muted max-md:hidden"
              onClick={() => set({ from: params.to, to: params.from })}
            >
              <ArrowUpDown className="size-3.5" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label="Route type">
              {(Object.keys(PROFILE_LABEL) as Profile[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={profile === p}
                  onClick={() => set({ p: p === "fastest" ? undefined : p })}
                  className={`rounded px-2 py-1 text-xs pointer-coarse:py-2 ${profile === p ? "bg-[#ff6319] font-medium text-white" : "hover:bg-muted"}`}
                >
                  {PROFILE_LABEL[p]}
                </button>
              ))}
            </div>
            <select
              aria-label="When"
              className="h-8 rounded-md border bg-background px-1.5 text-xs pointer-coarse:h-10"
              value={params.at ? (params.arrive ? "arrive" : "depart") : "now"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "now") set({ at: undefined, arrive: undefined });
                else {
                  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
                    .toISOString()
                    .slice(0, 16);
                  set({ at: params.at ?? local, arrive: v === "arrive" ? true : undefined });
                }
              }}
            >
              <option value="now">Leave now</option>
              <option value="depart">Depart at</option>
              <option value="arrive">Arrive by</option>
            </select>
            {params.at && (
              <input
                type="datetime-local"
                aria-label="Time"
                className="h-8 rounded-md border bg-background px-1.5 text-xs pointer-coarse:h-10"
                value={params.at}
                onChange={(e) => set({ at: e.target.value || undefined })}
              />
            )}
            <button
              type="button"
              aria-label="Swap start and destination"
              className="grid size-8 place-items-center rounded-md border hover:bg-muted md:hidden pointer-coarse:size-10"
              onClick={() => set({ from: params.to, to: params.from })}
            >
              <ArrowUpDown className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6">
          {loading && (
            <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" /> Finding routes…
            </div>
          )}
          {error && !loading && <p className="py-4 text-sm">{error}</p>}
          {!from && !to && !loading && (
            <div className="space-y-2 py-3 text-muted-foreground text-sm">
              <p>
                Plan a trip in the Helsinki region. For each metro trip you get the entrance to use,
                the stairs, escalators or elevators on the way, and the end of the train to board.
              </p>
              <p>
                Zoom in on a metro station to see its indoor and underground map, floor by floor.
              </p>
            </div>
          )}
          {!loading && current && (
            <ItineraryDetail
              itinerary={current}
              guides={guides[selected ?? 0] ?? []}
              nameOf={nameOf}
              onBack={() => setSelected(null)}
              onWalk={(items, index) => {
                setWalk({ items, index });
                setSheet("min");
              }}
            />
          )}
          {!loading && !current && itineraries.length > 0 && (
            <ul className="space-y-2">
              {itineraries.map((it, i) => (
                <li key={`${it.startTime}-${i}`}>
                  <ItinerarySummary
                    itinerary={it}
                    guides={guides[i] ?? []}
                    nameOf={nameOf}
                    onSelect={() => {
                      setSelected(i);
                      setSheet("full");
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {about && <About onClose={() => setAbout(false)} />}
    </div>
  );
}

function About({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      onClick={onClose}
    >
      <div
        className="max-h-[85svh] w-full max-w-md overflow-y-auto rounded-xl bg-background p-5 text-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="about-title" className="font-semibold text-base">
            About Metro Optimizer
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="grid size-8 place-items-center rounded hover:bg-muted"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 text-muted-foreground">
          <p>
            A free, open-source, non-commercial trip planner for the Helsinki region that also
            routes you inside metro stations.
          </p>
          <p>
            <strong className="text-foreground">Station routing</strong> comes from OpenStreetMap:
            entrances, corridors, stairs, escalators and elevators. The train end is worked out from
            where the path meets the platform. Station maps can be incomplete; where a level change
            is not mapped, the app says so.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Routes and live times:{" "}
              <a
                className="underline"
                href="https://transitous.org/"
                target="_blank"
                rel="noreferrer"
              >
                Transitous
              </a>{" "}
              (
              <a
                className="underline"
                href="https://transitous.org/sources/"
                target="_blank"
                rel="noreferrer"
              >
                sources
              </a>
              ,{" "}
              <a
                className="underline"
                href="https://transitous.org/donate/"
                target="_blank"
                rel="noreferrer"
              >
                donate
              </a>
              )
            </li>
            <li>Timetables and stops: HSL open data (CC BY 4.0)</li>
            <li>
              Exit sign destinations: City of Helsinki metro station guide maps (Helsinki stations;
              the app links each map)
            </li>
            <li>
              Maps and station layouts: ©{" "}
              <a
                className="underline"
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                OpenStreetMap contributors
              </a>{" "}
              (ODbL), tiles by{" "}
              <a
                className="underline"
                href="https://openfreemap.org/"
                target="_blank"
                rel="noreferrer"
              >
                OpenFreeMap
              </a>
            </li>
          </ul>
          <p>
            Contact and source code:{" "}
            <a
              className="underline"
              href="https://github.com/pnupu/metro-optimizer"
              target="_blank"
              rel="noreferrer"
            >
              github.com/pnupu/metro-optimizer
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
