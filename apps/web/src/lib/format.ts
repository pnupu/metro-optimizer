const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  hour: "2-digit",
  minute: "2-digit",
});

export const time = (iso: string) => clock.format(new Date(iso));

export function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Minutes late (positive) or early (negative) against the timetable. */
export const delay = (actual: string, scheduled: string) =>
  Math.round((Date.parse(actual) - Date.parse(scheduled)) / 60_000);

export const MODE_COLOR: Record<string, string> = {
  SUBWAY: "#ff6319",
  BUS: "#007ac9",
  REGIONAL_BUS: "#007ac9",
  COACH: "#007ac9",
  TRAM: "#00985f",
  RAIL: "#8c4799",
  REGIONAL_RAIL: "#8c4799",
  SUBURBAN: "#8c4799",
  FERRY: "#00b9e4",
  WALK: "#6b7280",
};

export const modeColor = (mode: string) => MODE_COLOR[mode] ?? "#4b5563";

export const MODE_NAME: Record<string, string> = {
  SUBWAY: "Metro",
  BUS: "Bus",
  REGIONAL_BUS: "Bus",
  COACH: "Coach",
  TRAM: "Tram",
  RAIL: "Train",
  REGIONAL_RAIL: "Train",
  SUBURBAN: "Train",
  FERRY: "Ferry",
  WALK: "Walk",
};
