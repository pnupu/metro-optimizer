import {
  Bus,
  ChevronLeft,
  Footprints,
  Map as MapIcon,
  Ship,
  TrainFront,
  TramFront,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";

import { delay, minutes, modeColor, MODE_NAME, time } from "@/lib/format";
import type { MetroGuide, StationGuide, TrainEnd } from "@/lib/guidance";
import { describeStep, entranceLabel, entranceShort, levelName } from "@/lib/guidance";
import type { Alert, Itinerary, Leg, Place } from "@/lib/transitous";
import { gtfsId } from "@/lib/transitous";

import type { MapFocus } from "./map-view";
import { StepIcon } from "./step-icon";
import { TrainDiagram } from "./train-diagram";

export type NameOf = (place: Place) => string;

function ModeIcon({ mode, className = "size-4" }: { mode: string; className?: string }) {
  if (mode === "SUBWAY" || mode.includes("RAIL") || mode === "SUBURBAN")
    return <TrainFront className={className} aria-hidden />;
  if (mode === "TRAM") return <TramFront className={className} aria-hidden />;
  if (mode === "FERRY") return <Ship className={className} aria-hidden />;
  if (mode === "WALK") return <Footprints className={className} aria-hidden />;
  return <Bus className={className} aria-hidden />;
}

const END_TEXT: Record<TrainEnd, string> = { front: "front", middle: "middle", back: "back" };

export function LegChip({ leg }: { leg: Leg }) {
  if (leg.mode === "WALK") {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground text-xs">
        <Footprints className="size-3.5" aria-hidden />
        {Math.round(leg.duration / 60)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold text-white text-xs"
      style={{ background: modeColor(leg.mode) }}
    >
      <ModeIcon mode={leg.mode} className="size-3.5" />
      {leg.routeShortName ?? leg.displayName ?? MODE_NAME[leg.mode]}
    </span>
  );
}

export function ItinerarySummary({
  itinerary,
  guides,
  nameOf,
  onSelect,
}: {
  itinerary: Itinerary;
  guides: MetroGuide[];
  nameOf: NameOf;
  onSelect: () => void;
}) {
  const first = itinerary.legs.find((l) => l.mode !== "WALK");
  const late = first ? delay(first.startTime, first.scheduledStartTime) : 0;
  const metro = guides[0];
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-lg border p-3 text-left transition hover:bg-muted/60"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold tabular-nums">
          {time(itinerary.startTime)} – {time(itinerary.endTime)}
        </span>
        <span className="text-muted-foreground text-sm">{minutes(itinerary.duration)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {itinerary.legs
          .filter((l) => l.mode !== "WALK" || l.duration >= 60)
          .map((l, i) => (
            <LegChip key={i} leg={l} />
          ))}
      </div>
      {first && (
        <div className="mt-1.5 text-muted-foreground text-xs">
          {first.realTime && late !== 0
            ? `${late > 0 ? `${late} min late` : `${-late} min early`} · `
            : ""}
          Leaves {time(first.startTime)} from {nameOf(first.from)}
        </div>
      )}
      {metro?.trainEnd && metro.alight && (
        <div className="mt-1.5 text-xs">
          <span className="font-medium text-[#c2410c] dark:text-[#ff8a50]">
            Board the {END_TEXT[metro.trainEnd]}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · for {entranceShort(metro.alight.entrance)} at {metro.alight.station.name}
          </span>
        </div>
      )}
    </button>
  );
}

function Alerts({ alerts }: { alerts?: Alert[] }) {
  if (!alerts?.length) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {alerts.map((a, i) => {
        const text = `${a.headerText ?? ""} ${a.descriptionText ?? ""}`;
        const lift = /lift|elevator|escalator|hissi|liukuport/i.test(text);
        return (
          <li
            key={i}
            className={`flex gap-2 rounded-md p-2 text-xs ${lift ? "bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100" : "bg-muted"}`}
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">{a.headerText}</span>
              {a.descriptionText && a.descriptionText !== a.headerText
                ? ` ${a.descriptionText}`
                : ""}
              {a.url && (
                <>
                  {" "}
                  <a href={a.url} target="_blank" rel="noreferrer" className="underline">
                    More
                  </a>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StationCard({
  guide,
  direction,
  trainEnd,
  onShow,
}: {
  guide: StationGuide;
  direction: "in" | "out";
  trainEnd?: TrainEnd;
  onShow: (f: Omit<MapFocus, "nonce">) => void;
}) {
  const { station, entrance, platform, steps } = guide;
  const platformEnd =
    guide.trainPosition >= 0.6 ? "front" : guide.trainPosition <= 0.4 ? "back" : "middle";
  return (
    <section className="mt-2 rounded-lg border border-[#ff6319]/40 bg-[#ff6319]/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            {direction === "in" ? "Into the station" : "Out of the station"} · {station.name}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-semibold">
            <span className="grid size-6 place-items-center rounded-full bg-[#ff6319] text-white text-xs">
              {entrance.ref ?? "M"}
            </span>
            {entranceLabel(entrance, station.name)}
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            onShow({
              lng: entrance.lng,
              lat: entrance.lat,
              level: platform.level ?? -1,
              zoom: 17.5,
            })
          }
          className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted pointer-coarse:py-2"
        >
          <MapIcon className="size-3.5" aria-hidden /> Map
        </button>
      </div>
      <ol className="mt-2 space-y-1.5 text-sm">
        {direction === "out" && (
          <li className="flex items-center gap-2 text-muted-foreground">
            <TrainFront className="size-4 shrink-0" aria-hidden /> Leave the train at the{" "}
            {platformEnd}
          </li>
        )}
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <StepIcon mode={s.mode} />
            <span>{describeStep(s)}</span>
          </li>
        ))}
        {direction === "in" && (
          <li className="flex items-center gap-2 text-muted-foreground">
            <TrainFront className="size-4 shrink-0" aria-hidden />
            You reach the platform ({levelName(platform.level)}) near the {platformEnd} of the train
            {trainEnd && trainEnd !== platformEnd ? `; walk to the ${trainEnd}` : ""}
          </li>
        )}
      </ol>
      {(guide.uncertain || guide.fallback || !platform.mapped) && (
        <p className="mt-2 text-muted-foreground text-xs">
          {guide.fallback
            ? `No ${guide.profile === "stepFree" ? "step-free" : "stair-free"} path is mapped here; this is the fastest path. `
            : ""}
          {guide.uncertain ? "One level change is not mapped in OpenStreetMap. " : ""}
          {!platform.mapped ? "The platform is not mapped, so the train end is a guess." : ""}
        </p>
      )}
    </section>
  );
}

export function ItineraryDetail({
  itinerary,
  guides,
  nameOf,
  onBack,
  onShow,
}: {
  itinerary: Itinerary;
  guides: MetroGuide[];
  nameOf: NameOf;
  onBack: () => void;
  onShow: (f: Omit<MapFocus, "nonce">) => void;
}) {
  const byLeg = new Map(guides.map((g) => [g.legIndex, g]));
  const rows: ReactNode[] = [];
  itinerary.legs.forEach((leg, i) => {
    const metro = byLeg.get(i);
    const nextMetro = byLeg.get(i + 1);
    const late = delay(leg.startTime, leg.scheduledStartTime);
    rows.push(
      <li key={i} className="relative pb-4 pl-8">
        <span
          className="absolute top-1 left-0 grid size-6 place-items-center rounded-full text-white"
          style={{ background: modeColor(leg.mode) }}
        >
          <ModeIcon mode={leg.mode} className="size-3.5" />
        </span>
        <span
          className="absolute top-8 bottom-0 left-[11px] w-0.5"
          style={{ background: modeColor(leg.mode), opacity: 0.35 }}
        />
        {leg.mode === "WALK" ? (
          <div>
            <div className="font-medium">
              Walk {minutes(leg.duration)}
              {leg.distance ? ` · ${Math.round(leg.distance / 10) * 10} m` : ""}
            </div>
            <div className="text-muted-foreground text-sm">
              {time(leg.startTime)} to{" "}
              {i === itinerary.legs.length - 1 ? "destination" : nameOf(leg.to)}
            </div>
            {nextMetro?.board && (
              <StationCard
                guide={nextMetro.board}
                direction="in"
                trainEnd={nextMetro.trainEnd}
                onShow={onShow}
              />
            )}
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <LegChip leg={leg} />
              <span className="font-medium">toward {leg.headsign ?? nameOf(leg.to)}</span>
            </div>
            <div className="mt-1 text-sm tabular-nums">
              {time(leg.startTime)} {nameOf(leg.from)}
              {leg.realTime && late !== 0 && (
                <span
                  className={
                    late > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-green-700 dark:text-green-400"
                  }
                >
                  {" "}
                  ({late > 0 ? `+${late}` : late} min)
                </span>
              )}
              {leg.from.track ? ` · track ${leg.from.track}` : ""}
            </div>
            <div className="text-muted-foreground text-sm">
              {minutes(leg.duration)} · {(leg.intermediateStops?.length ?? 0) + 1} stops
            </div>
            <div className="text-sm tabular-nums">
              {time(leg.endTime)} {nameOf(leg.to)}
            </div>
            {metro?.board && itinerary.legs[i - 1]?.mode !== "WALK" && (
              <StationCard
                guide={metro.board}
                direction="in"
                trainEnd={metro.trainEnd}
                onShow={onShow}
              />
            )}
            {metro && (metro.trainEnd || itinerary.legs[i + 1]?.mode === "SUBWAY") && (
              <div className="mt-2 rounded-lg bg-muted/60 p-3">
                {metro.trainEnd ? (
                  <>
                    <div className="font-semibold">
                      Board the{" "}
                      <span className="text-[#c2410c] dark:text-[#ff8a50]">
                        {END_TEXT[metro.trainEnd]}
                      </span>{" "}
                      of the train
                    </div>
                    <div className="text-muted-foreground text-xs">
                      That end stops nearest{" "}
                      {metro.alight ? entranceShort(metro.alight.entrance) : "your exit"} at{" "}
                      {nameOf(leg.to)}.
                    </div>
                    <div className="mt-2">
                      <TrainDiagram end={metro.trainEnd} toward={leg.headsign} />
                    </div>
                  </>
                ) : (
                  <div className="text-sm">Change trains on the platform at {nameOf(leg.to)}.</div>
                )}
              </div>
            )}
            {metro?.alight && <StationCard guide={metro.alight} direction="out" onShow={onShow} />}
            <Alerts alerts={leg.alerts} />
          </div>
        )}
      </li>,
    );
  });
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1 rounded-md px-1 py-1 text-sm hover:bg-muted pointer-coarse:py-2"
      >
        <ChevronLeft className="size-4" aria-hidden /> All routes
      </button>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-semibold text-lg tabular-nums">
          {time(itinerary.startTime)} – {time(itinerary.endTime)}
        </span>
        <span className="text-muted-foreground">{minutes(itinerary.duration)}</span>
      </div>
      <ol>{rows}</ol>
      <div className="relative pl-8 text-sm">
        <span className="absolute top-0.5 left-1.5 size-3 rounded-full bg-red-600" />
        Arrive {time(itinerary.endTime)}
      </div>
    </div>
  );
}

export const stationIdOf = (p: Place) => gtfsId(p.parentId);
