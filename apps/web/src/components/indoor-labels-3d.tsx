import { MercatorCoordinate, type Map as MlMap } from "maplibre-gl";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { IndoorLabel3d } from "@/lib/indoor-3d";

const LAYER = "indoor-3d-labels";
const badges = {
  destination: "border-red-200 bg-red-700 text-white",
  origin: "border-green-200 bg-green-700 text-white",
  "current-floor":
    "border-white bg-slate-900 text-white dark:border-slate-900 dark:bg-white dark:text-slate-900",
  active: "border-amber-200 bg-amber-300 text-amber-950",
  route: "border-orange-300/80 bg-orange-950 text-white",
  floor:
    "border-slate-400 bg-slate-100 text-slate-800 dark:border-slate-500 dark:bg-slate-800 dark:text-white",
  entrance: "border-cyan-500 bg-cyan-950 text-white",
} satisfies Record<IndoorLabel3d["kind"], string>;

const order: IndoorLabel3d["kind"][] = [
  "active",
  "destination",
  "origin",
  "entrance",
  "current-floor",
  "floor",
  "route",
];

export function IndoorLabels3d({
  mapRef,
  ready,
  labels,
  walking,
}: {
  mapRef: RefObject<MlMap | null>;
  ready: number;
  labels: IndoorLabel3d[];
  walking: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const entries = useMemo(
    () =>
      order.flatMap((kind) =>
        labels
          .filter((label) => label.kind === kind)
          .map((label) => ({
            ...label,
            points: label.anchors.map(([lng, lat, z]) =>
              MercatorCoordinate.fromLngLat([lng, lat], z),
            ),
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

    // Project DOM badges with the same camera as the raised geometry.
    map.addLayer({
      id: LAYER,
      type: "custom",
      renderingMode: "2d",
      render(_gl, { defaultProjectionData: { mainMatrix: m } }) {
        const zoom = map.getZoom();
        const width = el.clientWidth;
        const height = el.clientHeight;
        const phone = window.innerWidth < 768;
        const topInset = phone ? 128 : 16;
        const bottomInset = phone ? (walking ? 244 : 138) : walking ? 116 : 16;
        const placed: { left: number; right: number; top: number; bottom: number }[] = [];
        const children = el.children as HTMLCollectionOf<HTMLElement>;
        // Read badge sizes before writing transforms to avoid forcing layout for each badge.
        const candidates = latest.current.flatMap((label, i) => {
          const node = children[i];
          if (!node) return [];
          if (zoom < 14.5 || (label.kind === "route" && zoom < 15.7)) {
            node.style.visibility = "hidden";
            return [];
          }
          const badge = node.firstElementChild as HTMLElement;
          return [{ label, node, w: badge.offsetWidth, h: badge.offsetHeight }];
        });
        for (const { label, node, w, h } of candidates) {
          let visible = false;
          const floor = label.kind === "floor" || label.kind === "current-floor";
          const projected = label.points.flatMap(({ x, y, z }) => {
            const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (clipW <= 0) return [];
            const px = ((1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / clipW) * width) / 2;
            const py = ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / clipW) * height) / 2;
            return px >= 5 && px <= width - 5 && py >= topInset && py <= height - bottomInset
              ? [{ px, py }]
              : [];
          });
          if (floor) projected.sort((a, b) => b.py - a.py);
          for (const { px, py } of projected) {
            const beside = [
              [-w - 7, 0],
              [7, 0],
            ];
            const below = [-w / 2, h / 2 + (floor ? 0 : 5)];
            const above = [-w / 2, -h / 2 - 5];
            for (const [dx = 0, dy = 0] of floor ? [below, ...beside] : [...beside, above, below]) {
              const left = px + dx;
              const top = py + dy - h / 2;
              const right = left + w;
              const bottom = top + h;
              if (left < 6 || right > width - 54 || top < topInset || bottom > height - bottomInset)
                continue;
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
              node.style.setProperty("--label-y", `${dy}px`);
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
  }, [mapRef, ready, walking]);

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
            className={`absolute top-[calc(var(--label-y)+2px)] left-[var(--label-x)] w-max max-w-32 -translate-y-1/2 rounded-md border px-1.5 py-0.5 text-center text-[11px] font-semibold leading-tight shadow-sm ${badges[kind]}`}
          >
            {text}
          </span>
        </div>
      ))}
    </div>
  );
}
