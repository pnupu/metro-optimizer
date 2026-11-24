import { LocateFixed, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { geocode, type GeocodeMatch } from "@/lib/transitous";

export interface PlaceValue {
  label: string;
  lat: number;
  lon: number;
}

interface Props {
  label: string;
  value?: PlaceValue;
  onChange: (value: PlaceValue | undefined) => void;
  allowLocate?: boolean;
}

function area(m: GeocodeMatch): string {
  const a = m.areas?.find((x) => x.default)?.name;
  const street = m.street ? `${m.street}${m.houseNumber ? ` ${m.houseNumber}` : ""}` : "";
  return [street !== m.name ? street : "", a].filter(Boolean).join(", ");
}

export function PlaceInput({ label, value, onChange, allowLocate }: Props) {
  const id = useId();
  const [text, setText] = useState(value?.label ?? "");
  const [matches, setMatches] = useState<GeocodeMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [locating, setLocating] = useState(false);
  const typed = useRef(false);

  useEffect(() => {
    setText(value?.label ?? "");
  }, [value?.label]);

  useEffect(() => {
    if (!typed.current || text.trim().length < 2) {
      setMatches([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      geocode(text.trim(), ctrl.signal)
        .then((list) => {
          setMatches(
            list
              .filter((m) => m.lat > 59.8 && m.lat < 60.7 && m.lon > 24 && m.lon < 25.8)
              .slice(0, 7),
          );
          setActive(0);
        })
        .catch(() => undefined);
    }, 220);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text]);

  const pick = (m: GeocodeMatch) => {
    typed.current = false;
    onChange({ label: m.name, lat: m.lat, lon: m.lon });
    setOpen(false);
  };

  const locate = () => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        typed.current = false;
        onChange({ label: "My location", lat: p.coords.latitude, lon: p.coords.longitude });
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const listId = `${id}-list`;
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex items-center gap-1 rounded-md border bg-background focus-within:ring-2 focus-within:ring-[#ff6319]/40">
        <span className="w-12 shrink-0 pl-3 text-muted-foreground text-xs">{label}</span>
        <input
          id={id}
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none pointer-coarse:h-11"
          placeholder="Address, place or stop"
          value={text}
          autoComplete="off"
          onChange={(e) => {
            typed.current = true;
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter" && matches[active]) {
              e.preventDefault();
              pick(matches[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
        {text && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            className="grid size-9 place-items-center text-muted-foreground hover:text-foreground pointer-coarse:size-11"
            onClick={() => {
              setText("");
              onChange(undefined);
            }}
          >
            <X className="size-4" />
          </button>
        )}
        {allowLocate && (
          <button
            type="button"
            aria-label="Use my location"
            className="grid size-9 place-items-center text-muted-foreground hover:text-foreground pointer-coarse:size-11"
            onClick={locate}
            disabled={locating}
          >
            <LocateFixed className={`size-4 ${locating ? "animate-pulse" : ""}`} />
          </button>
        )}
      </div>
      {open && matches.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border bg-popover py-1 shadow-lg"
        >
          {matches.map((m, i) => (
            <li
              key={`${m.id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-muted" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              <div className="truncate font-medium">{m.name}</div>
              <div className="truncate text-muted-foreground text-xs">
                {m.type === "STOP" ? "Stop" : m.type === "ADDRESS" ? "Address" : "Place"}
                {area(m) ? ` · ${area(m)}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
