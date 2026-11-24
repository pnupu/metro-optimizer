import { Footprints, HelpCircle } from "lucide-react";

import type { Mode } from "@/lib/station-types";

const svg = "size-4 shrink-0";

/** Icons for the in-station path steps. Lucide has no stairs, escalator or elevator. */
export function StepIcon({ mode }: { mode: Mode }) {
  switch (mode) {
    case "walk":
      return <Footprints className={svg} aria-hidden />;
    case "stairs":
      return (
        <svg
          viewBox="0 0 24 24"
          className={svg}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M3 20h5v-5h5v-5h5V5h3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "escalator":
      return (
        <svg
          viewBox="0 0 24 24"
          className={svg}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M3 19h4l10-12h4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 15h2l9-11" strokeLinecap="round" opacity=".5" />
        </svg>
      );
    case "elevator":
      return (
        <svg
          viewBox="0 0 24 24"
          className={svg}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="m9 9 3-3 3 3M9 15l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "level":
      return <HelpCircle className={svg} aria-hidden />;
  }
}
