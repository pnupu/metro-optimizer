/**
 * Downloads the HSL GTFS feed and OpenStreetMap data, and writes the station data the app uses:
 *   public/data/stations.json        index of the 30 metro stations
 *   public/data/stations/<id>.json   entrances, platforms, in-station paths, indoor map features
 *   public/data/metro-lines.json     M1 and M2 line geometry
 *
 * Run: bun run data            (uses .cache/ when it is less than a day old)
 *      bun run data --refresh  (downloads everything again)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getDocumentProxy } from "unpdf";

import { type ExitSigns, parseExitTable, type TextItem } from "../src/lib/exit-table";
import { buildStation, type GtfsStation, type OsmElement } from "../src/lib/station-graph";
import type { StationData, StationIndex } from "../src/lib/station-types";
import type { WalkGraph } from "../src/lib/walk-graph";

const ROOT = join(import.meta.dir, "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(ROOT, "public", "data");
const GTFS_URL = "https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip";
const OSM_API = "https://api.openstreetmap.org/api/0.6/map.json";
const USER_AGENT = "metro-optimizer-data-builder/0.1 (+https://github.com/pnupu/metro-optimizer)";
const REFRESH = process.argv.includes("--refresh");
/** City of Helsinki station guide maps (Helsinki stations only; Espoo stations have none). */
const GUIDE_MAPS = "https://www.hel.fi/static/hkl/metroasema_opaskartat";
/**
 * Exit tables compared by eye with the PDF image, where OSM lacks the last letters so the
 * automatic check cannot pass. Not trusted on layout alone: a list can run on into the next
 * column (Helsingin yliopisto exit D does), which shifts every later letter.
 */
const CHECKED_TABLES = new Set(["Sörnäinen"]); // 2026-11-24: A–G match the drawing
const DAY = 86_400_000;
/** Half size of the OSM box around a station (about 300 m each way). */
const BOX = { lat: 0.0028, lon: 0.0055 };

async function cached(path: string, url: string): Promise<string> {
  const file = Bun.file(path);
  if (!REFRESH && (await file.exists()) && Date.now() - file.lastModified < DAY) return path;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      await Bun.write(path, res);
      return path;
    }
    console.warn(`  ${res.status} from ${url}, attempt ${attempt}`);
    await Bun.sleep(attempt * 5000);
  }
  throw new Error(`Download failed: ${url}`);
}

async function unzipText(zip: string, name: string): Promise<string> {
  const proc = Bun.spawn(["unzip", "-p", zip, name], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error(`unzip ${name}: ${await new Response(proc.stderr).text()}`);
  return text;
}

/** Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, no newlines inside fields. */
function* csvRows(text: string): Generator<Record<string, string>> {
  const lines = text.split(/\r?\n/);
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split((lines[0] ?? "").replace(/^﻿/, ""));
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
    yield row;
  }
}

/** The station guide PDF and its exit table, if the city publishes one for this station. */
async function guideMap(name: string): Promise<{ url: string; exits?: ExitSigns[] } | undefined> {
  const base = name.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/å/g, "a");
  for (const slug of new Set([base.replace(/[^a-z0-9]+/g, "_"), base.replace(/[^a-z0-9]+/g, "")])) {
    const url = `${GUIDE_MAPS}/${slug}.pdf`;
    const path = join(CACHE, "guide-maps", `${slug}.pdf`);
    const cachedFile = Bun.file(path);
    const have = await cachedFile.exists();
    if (REFRESH || !have || Date.now() - cachedFile.lastModified >= DAY) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        if (res.ok && (res.headers.get("content-type") ?? "").includes("pdf"))
          await Bun.write(path, res);
        else if (!have) continue;
      } catch (error) {
        // Keep a stale copy rather than lose the station's signs; with no copy, skip it.
        console.warn(`  guide map ${url}: ${String(error)}`);
        if (!have) continue;
      }
    }
    try {
      return { url, ...(await readExitTable(path)) };
    } catch (error) {
      console.warn(`  guide map ${path} unreadable: ${String(error)}`);
      return { url };
    }
  }
  return undefined;
}

async function readExitTable(path: string): Promise<{ exits?: ExitSigns[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(path).arrayBuffer()));
  try {
    const page = await pdf.getPage(1);
    const height = page.getViewport({ scale: 1 }).height;
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str) continue;
      items.push({
        str: it.str,
        x: it.transform[4],
        y: height - it.transform[5],
        height: it.height,
        font: it.fontName,
      });
    }
    const exits = parseExitTable(items);
    return exits ? { exits } : {};
  } finally {
    // The bundled pdf.js types omit destroy(), but the runtime has it.
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

async function main() {
  await mkdir(join(CACHE, "osm"), { recursive: true });
  await mkdir(join(CACHE, "guide-maps"), { recursive: true });
  await mkdir(join(OUT, "stations"), { recursive: true });

  console.log("HSL GTFS");
  const zip = await cached(join(CACHE, "hsl.zip"), GTFS_URL);
  const stops = [...csvRows(await unzipText(zip, "stops.txt"))];
  const stations: GtfsStation[] = stops
    .filter((s) => s.location_type === "1" && s.vehicle_type === "1")
    .map((s) => {
      const children = stops.filter(
        (c) => c.parent_station === s.stop_id && c.location_type === "0" && c.vehicle_type === "1",
      );
      return {
        id: s.stop_id as string,
        // Child stops carry the plain name ("Kamppi"); the station row says "Kampin metroasema".
        name: children[0]?.stop_name ?? (s.stop_name as string),
        lat: Number(s.stop_lat),
        lon: Number(s.stop_lon),
        platforms: children.map((c) => ({
          stopId: c.stop_id as string,
          code: c.stop_code as string,
          ...(c.stop_desc ? { description: c.stop_desc } : {}),
          lat: Number(c.stop_lat),
          lon: Number(c.stop_lon),
        })),
      };
    });
  console.log(`  ${stations.length} metro stations`);

  // Metro line geometry: the longest shape of M1 and M2.
  const trips = [...csvRows(await unzipText(zip, "trips.txt"))].filter(
    (t) => t.route_id === "31M1" || t.route_id === "31M2",
  );
  const shapeRoute = new Map<string, string>();
  for (const t of trips)
    if (t.direction_id === "0") shapeRoute.set(t.shape_id as string, t.route_id as string);
  const shapePoints = new Map<string, [number, number, number][]>();
  for (const row of csvRows(await unzipText(zip, "shapes.txt"))) {
    if (!shapeRoute.has(row.shape_id as string)) continue;
    let list = shapePoints.get(row.shape_id as string);
    if (!list) shapePoints.set(row.shape_id as string, (list = []));
    list.push([Number(row.shape_pt_sequence), Number(row.shape_pt_lon), Number(row.shape_pt_lat)]);
  }
  const best = new Map<string, [number, number][]>();
  for (const [shape, pts] of shapePoints) {
    const route = shapeRoute.get(shape) as string;
    const line = pts
      .toSorted((a, b) => a[0] - b[0])
      .map(([, lon, lat]) => [lon, lat] as [number, number]);
    if (line.length > (best.get(route)?.length ?? 0)) best.set(route, line);
  }
  await writeFile(
    join(OUT, "metro-lines.json"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [...best].map(([route, coordinates]) => ({
        type: "Feature",
        properties: { route: route.replace("31", "") },
        geometry: { type: "LineString", coordinates },
      })),
    }),
  );

  const index: StationIndex = { generated: new Date().toISOString(), stations: [] };
  const built: (StationData & { graph: WalkGraph })[] = [];
  for (const station of stations) {
    const bbox = [
      station.lon - BOX.lon,
      station.lat - BOX.lat,
      station.lon + BOX.lon,
      station.lat + BOX.lat,
    ].map((n) => n.toFixed(5));
    const path = join(CACHE, "osm", `${station.id}.json`);
    const fresh =
      REFRESH ||
      !(await Bun.file(path).exists()) ||
      Date.now() - Bun.file(path).lastModified >= DAY;
    await cached(path, `${OSM_API}?bbox=${bbox.join(",")}`);
    if (fresh) await Bun.sleep(1500); // Be gentle with the OSM API.
    const osm = (await Bun.file(path).json()) as { elements: OsmElement[]; timestamp?: string };
    built.push(buildStation(station, osm.elements, osm.timestamp ?? new Date().toISOString()));
  }

  // The OSM boxes overlap in the city centre: give each entrance only to its nearest station.
  const nearest = new Map<string, { station: string; seconds: number }>();
  for (const s of built) {
    for (const p of s.paths) {
      if (p.profile !== "fastest") continue;
      const cur = nearest.get(p.entrance);
      if (!cur || p.seconds < cur.seconds)
        nearest.set(p.entrance, { station: s.id, seconds: p.seconds });
    }
  }
  for (const data of built) {
    data.paths = data.paths.filter((p) => nearest.get(p.entrance)?.station === data.id);
    data.entrances = data.entrances.filter((e) => nearest.get(e.id)?.station === data.id);
    // Exit sign destinations from the city's station guide map. The exit letters there are
    // graphics, so the table blocks are lettered in reading order; use them only when the block
    // count matches the station's lettered exits in OSM.
    const guide = await guideMap(data.name);
    let signNote = "no guide map";
    if (guide) {
      data.guideMap = guide.url;
      const letters = new Set(data.entrances.map((e) => e.ref).filter(Boolean));
      // OSM can miss a letter, so the table may have more blocks than OSM has letters; but an
      // empty block or an OSM letter beyond the table means the layout was not read right.
      const exits = guide.exits ?? [];
      const last = String.fromCharCode(64 + exits.length);
      // With more blocks than OSM letters, the last block must still be the station's highest
      // letter; that catches most tables with a skipped letter.
      const highest = [...letters].toSorted().at(-1);
      const trusted =
        exits.length >= letters.size &&
        exits.every((x) => x.signs.length > 0) &&
        [...letters].every((l) => (l as string) <= last) &&
        (exits.length === letters.size || highest === last || CHECKED_TABLES.has(data.name));
      if (trusted) {
        for (const e of data.entrances) {
          const signs = exits.find((x) => x.letter === e.ref)?.signs;
          if (signs && signs.length > 0) e.signs = signs;
        }
        signNote = `signs for ${exits.length} exits`;
      } else {
        signNote = `guide map, ${exits.length} table blocks vs ${letters.size} OSM letters: not used`;
      }
    }
    const { graph, ...station } = data;
    await writeFile(join(OUT, "stations", `${data.id}.json`), JSON.stringify(station));
    await writeFile(join(OUT, "stations", `${data.id}.graph.json`), JSON.stringify(graph));
    const withRef = data.entrances.filter((e) => e.ref).length;
    const byProfile = (p: string) => data.paths.filter((x) => x.profile === p).length;
    console.log(
      `  ${data.name.padEnd(18)} entrances ${data.entrances.length} (${withRef} lettered)` +
        `  platforms ${data.platforms.filter((p) => p.mapped).length}/${data.platforms.length}` +
        `  paths fastest ${byProfile("fastest")} noStairs ${byProfile("noStairs")} stepFree ${byProfile("stepFree")}` +
        `  indoor ${data.indoor.features.length}  ${signNote}`,
    );
    index.stations.push({
      id: data.id,
      name: data.name,
      lng: data.lng,
      lat: data.lat,
      platforms: data.platforms.map((p) => p.code),
      entrances: data.entrances.length,
      pathCount: data.paths.length,
    });
  }
  await writeFile(join(OUT, "stations.json"), JSON.stringify(index));
  console.log(`Wrote ${OUT}`);
}

await main();
