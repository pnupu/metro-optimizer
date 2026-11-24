/**
 * Reads the exit table ("Uloskäynnit / Utgångar / Exits") of a City of Helsinki metro station
 * guide PDF. The exit letters are drawn as graphics, so the table is read by layout: destinations
 * sit in two columns, one block per exit, blocks separated by the letter bars. Each destination is
 * written in Finnish, Swedish and (often) English, each language in its own font.
 */

export interface TextItem {
  str: string;
  x: number;
  /** Distance from the top of the page. */
  y: number;
  height: number;
  font: string;
}

export interface ExitSigns {
  letter: string;
  /** Destinations on the exit sign, English where the map has it, else Finnish. */
  signs: string[];
}

/** A vertical gap bigger than this between lines starts a new exit block. */
const BLOCK_GAP = 18;

/** Merge items on the same line (a word split across items) into one line. */
function lines(items: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (const it of items.toSorted((a, b) => a.y - b.y || a.x - b.x)) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - it.y) < 1 && last.font === it.font && it.x > last.x) {
      last.str = `${last.str}${it.str}`.replace(/\s+/g, " ");
    } else out.push({ ...it });
  }
  return out;
}

const isMarker = (it: TextItem) => /^\d{1,2}$/.test(it.str.trim());

export function parseExitTable(items: TextItem[]): ExitSigns[] | undefined {
  const header = items.find((i) => i.str.trim() === "Uloskäynnit");
  // The symbol legend at the foot of the page ends the table (the same words also appear above it).
  const legend = items
    .filter((i) => header && i.y > header.y && /^(Bussipysäkki|Kynnyksetön pääsy)/.test(i.str))
    .toSorted((a, b) => a.y - b.y)[0];
  const area = items.find((i) => i.str.trim() === "Lähialue");
  if (!header || !area) return undefined;
  const top = header.y + header.height;
  const bottom = legend ? legend.y - 2 : Number.POSITIVE_INFINITY;
  const right = area.x - 12;
  const body = items.filter(
    (i) => i.str.trim() !== "" && i.y > top && i.y < bottom && i.x >= header.x - 8 && i.x < right,
  );
  if (body.length === 0) return undefined;

  // Columns start where the left edges of the text lines jump by more than 30 points.
  const starts = [
    ...new Set(body.filter((i) => !isMarker(i)).map((i) => Math.round(i.x))),
  ].toSorted((a, b) => a - b);
  const candidates = starts.filter((x, k) => k === 0 || x - (starts[k - 1] as number) > 30);
  // A real column has several lines; a lone indented line (a wrapped word) is not one.
  const lineCount = (x: number, next: number | undefined) =>
    body.filter((i) => !isMarker(i) && i.x >= x - 1 && (next === undefined || i.x < next - 1))
      .length;
  const columnStarts = candidates.filter((x, k) => k === 0 || lineCount(x, candidates[k + 1]) >= 2);
  // A number marker sits just left of its text, so it belongs to the next column start.
  const columnOf = (i: TextItem) =>
    columnStarts.filter((x) => x <= Math.round(i.x) + 15).length - 1;
  const columns = columnStarts.map((_, c) => body.filter((i) => columnOf(i) === c));

  const blocks: TextItem[][] = [];
  for (const col of columns) {
    const ls = lines(col);
    let block: TextItem[] = [];
    for (const l of ls) {
      const prev = block.at(-1);
      if (prev && l.y - prev.y > BLOCK_GAP) {
        blocks.push(block);
        block = [];
      }
      block.push(l);
    }
    if (block.length > 0) blocks.push(block);
  }

  // Languages by font: Finnish is the font of the table header; Swedish is the font that most often
  // follows a Finnish line; English most often follows a Swedish line.
  const fi = header.font;
  const after = (font: string) => {
    const count = new Map<string, number>();
    for (const block of blocks) {
      for (let k = 1; k < block.length; k++) {
        const a = block[k - 1] as TextItem;
        const b = block[k] as TextItem;
        if (a.font === font && b.font !== font && !isMarker(a) && !isMarker(b)) {
          count.set(b.font, (count.get(b.font) ?? 0) + 1);
        }
      }
    }
    return [...count].toSorted((a, b) => b[1] - a[1])[0]?.[0];
  };
  const sv = after(fi);
  const en = sv ? after(sv) : undefined;

  return blocks.map((block, i) => ({
    letter: String.fromCharCode(65 + i),
    signs: destinations(block, fi, en === fi ? undefined : en),
  }));
}

/** Lines of one language, with words broken over lines ("kaupungin-" + "teatteri") joined. */
function joinLines(ls: TextItem[]): string[] {
  const out: string[] = [];
  for (const l of ls) {
    const t = l.str.trim();
    const last = out.at(-1);
    if (last !== undefined && last.endsWith("-")) out[out.length - 1] = `${last.slice(0, -1)}${t}`;
    else if (last !== undefined && /^[a-zåäö(]/.test(t)) out[out.length - 1] = `${last} ${t}`;
    else out.push(t);
  }
  return out.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * Split a block into destinations: a new one starts at each Finnish line that follows a line in
 * another language. Keep the English name; for "Kiasma / Nykytaiteen museo" keep both parts.
 */
function destinations(block: TextItem[], fi: string, en: string | undefined): string[] {
  const entries: TextItem[][] = [];
  let entry: TextItem[] = [];
  for (const l of block) {
    if (isMarker(l)) continue;
    if (entry.length > 0 && l.font === fi && entry.at(-1)?.font !== fi) {
      entries.push(entry);
      entry = [];
    }
    entry.push(l);
  }
  if (entry.length > 0) entries.push(entry);

  return entries
    .map((e) => {
      const finnish = joinLines(e.filter((l) => l.font === fi));
      const english = en ? joinLines(e.filter((l) => l.font === en)).join(" ") : "";
      if (english && finnish.length > 1 && !english.includes(finnish[0] as string)) {
        return `${finnish[0]} (${english})`;
      }
      return english || finnish.join(", ") || joinLines(e).join(" ");
    })
    .filter((s) => s.length > 1 && s !== "-");
}
