import type { LngLat } from "./station-types";

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function distance(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees, 0 = north, clockwise. */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x =
    Math.cos(rad(a[1])) * Math.sin(rad(b[1])) -
    Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings, 0..180. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Position of p projected on the segment a→b: 0 at a, 1 at b, clamped. */
export function projectFraction(p: LngLat, a: LngLat, b: LngLat): number {
  // Local equirectangular frame is exact enough at station scale.
  const k = Math.cos(rad(a[1]));
  const bx = (b[0] - a[0]) * k;
  const by = b[1] - a[1];
  const px = (p[0] - a[0]) * k;
  const py = p[1] - a[1];
  const len2 = bx * bx + by * by;
  if (len2 === 0) return 0.5;
  return Math.min(1, Math.max(0, (px * bx + py * by) / len2));
}

/** Decode a Google encoded polyline. MOTIS uses precision 6 or 7. */
export function decodePolyline(encoded: string, precision = 6): LngLat[] {
  const factor = 10 ** precision;
  const out: LngLat[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && i <= encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

/** Cumulative distance along a line, one value for each vertex. */
export function cumulative(line: LngLat[]): number[] {
  const acc = [0];
  for (let i = 1; i < line.length; i++) {
    acc.push((acc[i - 1] ?? 0) + distance(line[i - 1] as LngLat, line[i] as LngLat));
  }
  return acc;
}
