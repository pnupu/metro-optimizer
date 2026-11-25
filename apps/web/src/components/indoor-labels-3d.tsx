import { MercatorCoordinate, type Map as MlMap } from "maplibre-gl";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { IndoorLabel3d } from "@/lib/indoor-3d";

const LAYER = "indoor-3d-labels";
const badges = {
  destination: "border-red-200 bg-red-700 text-white",
  origin: "border-green-200 bg-green-700 text-white",
  "current-floor":
    "border-white bg-slate-900 text-white dark:border-slate-900 dark:bg-white dark:text-slate-900",
  route: "border-orange-300 bg-orange-950 text-white",
  floor:
    "border-slate-400 bg-slate-100 text-slate-800 dark:border-slate-500 dark:bg-slate-800 dark:text-white",
  street: "border-cyan-300 bg-cyan-950 text-white",
  entrance: "border-cyan-500 bg-cyan-950 text-white",
  detail: "border-border bg-background text-foreground",
} satisfies Record<IndoorLabel3d["kind"], string>;

const zoomFor = {
  destination: 15,
  origin: 15,
  "current-floor": 15,
  route: 15.7,
  floor: 15,
  street: 16.7,
  entrance: 16.7,
  detail: 18.2,
};

export function IndoorLabels3d({
  mapRef,
  ready,
  labels,
}: {
  mapRef: RefObject<MlMap | null>;
  ready: number;
  labels: IndoorLabel3d[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const entries = useMemo(
    () =>
      (Object.keys(badges) as IndoorLabel3d["kind"][]).flatMap((kind) =>
        labels
          .filter((label) => label.kind === kind)
          .map((label) => ({
            ...label,
            points: label.anchors.map((p) => MercatorCoordinate.fromLngLat(p, label.height)),
          })),
      ),
    [labels],
  );
  const latest = useRef(entries);
  useLayoutEffect(() => {
    latest.current = entries;
    mapRef.current?.triggerRepaint();
  }, [entries, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    const el = container.current;
    if (!map || !ready || !el) return;

    // MapLibre 6.19 symbols and markers have no per-feature height. Use the
    // Mercator custom-layer projection to position DOM badges on the extrusions.
    map.addLayer({
      id: LAYER,
      type: "custom",
      renderingMode: "3d",
      render(_gl, { defaultProjectionData: { mainMatrix: m } }) {
        const zoom = map.getZoom();
        const width = el.clientWidth;
        const height = el.clientHeight;
        const placed: { left: number; right: number; top: number; bottom: number }[] = [];
        const children = el.children as HTMLCollectionOf<HTMLElement>;
        // Read badge sizes before writing transforms to avoid forcing layout for each badge.
        const candidates = latest.current.flatMap((label, i) => {
          const node = children[i];
          if (!node) return [];
          if (zoom < zoomFor[label.kind]) {
            node.style.visibility = "hidden";
            return [];
          }
          const badge = node.firstElementChild as HTMLElement;
          return [{ label, node, w: badge.offsetWidth, h: badge.offsetHeight }];
        });
        for (const { label, node, w, h } of candidates) {
          let visible = false;
          for (const { x, y, z } of label.points) {
            const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (clipW <= 0) continue;
            const px = ((1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / clipW) * width) / 2;
            const py = ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / clipW) * height) / 2;
            if (px < 4 || px > width - 4 || py < 4 || py > height - 4) continue;
            for (const dx of [-w - 6, 6]) {
              const left = px + dx;
              const top = py - h / 2;
              const right = left + w;
              const bottom = top + h;
              if (left < 6 || right > width - 54 || top < 10 || bottom > height - 18) continue;
              if (
                placed.some(
                  (r) =>
                    left < r.right + 4 &&
                    right > r.left - 4 &&
                    top < r.bottom + 3 &&
                    bottom > r.top - 3,
                )
              )
                continue;
              placed.push({ left, right, top, bottom });
              node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
              node.style.setProperty("--label-x", `${dx}px`);
              visible = true;
              break;
            }
            if (visible) break;
          }
          node.style.visibility = visible ? "visible" : "hidden";
        }
      },
    });
    return () => {
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    };
  }, [mapRef, ready]);

  return (
    <div
      ref={container}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      {entries.map(({ kind, text }, i) => (
        <div
          key={i}
          className="invisible absolute top-0 left-0 size-[5px] -ml-[2px] -mt-[2px] rounded-full bg-slate-800 ring-1 ring-white"
          data-label-kind={kind}
        >
          <span
            className={`absolute top-0.5 left-[var(--label-x)] w-max max-w-32 -translate-y-1/2 rounded-md border px-1.5 py-0.5 text-center text-[11px] font-semibold leading-tight shadow-sm ${badges[kind]}`}
          >
            {text}
          </span>
        </div>
      ))}
    </div>
  );
}
