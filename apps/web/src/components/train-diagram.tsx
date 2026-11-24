import type { TrainEnd } from "@/lib/guidance";

const CARS: Record<TrainEnd, number[]> = { back: [0], middle: [1, 2], front: [3] };

/** A 4-car metro train, moving right, with the cars to board marked. */
export function TrainDiagram({ end, toward }: { end: TrainEnd; toward?: string }) {
  const marked = new Set(CARS[end]);
  return (
    <figure className="m-0">
      <svg
        viewBox="0 0 220 44"
        className="w-full max-w-[260px]"
        role="img"
        aria-label={`Board the ${end} of the train`}
      >
        {[0, 1, 2, 3].map((i) => {
          const x = 2 + i * 50;
          const on = marked.has(i);
          return (
            <g key={i}>
              <path
                d={i === 3 ? `M${x} 8h36q10 0 12 14v6h-48z` : `M${x} 8h48v20h-48z`}
                fill={on ? "#ff6319" : "none"}
                stroke={on ? "#ff6319" : "currentColor"}
                strokeOpacity={on ? 1 : 0.45}
                strokeWidth="2"
              />
              {[10, 22, 34].map((dx) => (
                <rect
                  key={dx}
                  x={x + dx - 3}
                  y={13}
                  width={6}
                  height={6}
                  rx={1}
                  fill={on ? "#fff" : "currentColor"}
                  opacity={on ? 0.9 : 0.3}
                />
              ))}
            </g>
          );
        })}
        <path
          d="M180 38h34m-6-4 6 4-6 4"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        {toward ? `Train moves toward ${toward} →` : "Direction of travel →"}
      </figcaption>
    </figure>
  );
}
