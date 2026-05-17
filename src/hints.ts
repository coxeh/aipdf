import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StructuredHint = {
  id: string;
  kind: string;
  title: string;
  description?: string;
  schemaGuess: Record<string, string>;
  recordCountApprox: number;
  /** True if this region appears to continue a table from the previous page (no visible header row). */
  isContinuation?: boolean;
  /** Title of the prior table this likely continues from, if visible. */
  continuesPrevious?: string;
};

export type PageHints = {
  page: number;
  structuredHints: StructuredHint[];
};

export type AggregatedHint = {
  title: string;
  kind: string;
  schemaGuess: Record<string, string>;
  pages: number[];
  totalRecordCountApprox: number;
  sampleIds: string[];
  descriptions: string[];
};

export type AggregatedHints = {
  hints: AggregatedHint[];
};

function schemaKey(schema: Record<string, string>): string {
  return Object.keys(schema)
    .sort()
    .map((k) => `${k}:${schema[k]}`)
    .join("|");
}

/**
 * Normalise a title for dedup. Strips punctuation, collapses whitespace,
 * lowercases. "Cocoa Farmer Groups.", "cocoa  farmer-groups", and
 * "Cocoa Farmer Groups" all map to the same key.
 */
function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pageNumberFromFilename(name: string): number {
  const m = name.match(/(\d+)/);
  return m && m[1] ? Number(m[1]) : 0;
}

export async function aggregateHints(
  hintsDir: string,
  outPath: string,
): Promise<AggregatedHints> {
  let entries: string[] = [];
  try {
    entries = (await readdir(hintsDir))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    await mkdir(dirname(outPath), { recursive: true });
    const empty: AggregatedHints = { hints: [] };
    await writeFile(outPath, JSON.stringify(empty, null, 2));
    return empty;
  }

  // First pass: collect every hint in page order, preserving original IDs and continuation flags.
  type RawHint = StructuredHint & { page: number };
  const raw: RawHint[] = [];

  for (const file of entries) {
    let parsed: PageHints;
    try {
      parsed = JSON.parse(await readFile(join(hintsDir, file), "utf8")) as PageHints;
    } catch {
      continue;
    }
    const page = parsed.page ?? pageNumberFromFilename(file);
    for (const hint of parsed.structuredHints ?? []) {
      raw.push({ ...hint, page });
    }
  }

  // Aggregation key resolution: continuation hints redirect to the prior hint they continue.
  // Strategy:
  //   1. Default key = title|schema (same as before).
  //   2. If hint.isContinuation is true, look back for the most recent non-continuation
  //      hint with the same kind whose title matches hint.continuesPrevious (if set) or
  //      whose column count matches — and reuse THAT hint's key.
  function continuationParent(h: RawHint, prior: RawHint[]): RawHint | null {
    const targetTitle = (h.continuesPrevious || "").trim().toLowerCase();
    const targetCols = Object.keys(h.schemaGuess ?? {}).length;
    for (let i = prior.length - 1; i >= 0; i--) {
      const p = prior[i]!;
      if (p.kind !== h.kind) continue;
      if (p.isContinuation) continue;
      if (targetTitle && normaliseTitle(p.title) === normaliseTitle(targetTitle)) return p;
      const pCols = Object.keys(p.schemaGuess ?? {}).length;
      if (!targetTitle && targetCols && pCols === targetCols) return p;
    }
    return null;
  }

  const map = new Map<string, AggregatedHint>();
  const processed: RawHint[] = [];

  for (const hint of raw) {
    const parent = hint.isContinuation ? continuationParent(hint, processed) : null;
    const effective = parent ?? hint;
    const key = `${normaliseTitle(effective.title)}::${schemaKey(effective.schemaGuess ?? {})}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.pages.includes(hint.page)) existing.pages.push(hint.page);
      existing.totalRecordCountApprox += Number(hint.recordCountApprox) || 0;
      if (hint.id && !existing.sampleIds.includes(hint.id)) existing.sampleIds.push(hint.id);
      const desc = hint.description ?? "";
      if (desc && !existing.descriptions.includes(desc)) existing.descriptions.push(desc);
    } else {
      map.set(key, {
        title: effective.title,
        kind: effective.kind,
        schemaGuess: effective.schemaGuess ?? {},
        pages: [hint.page],
        totalRecordCountApprox: Number(hint.recordCountApprox) || 0,
        sampleIds: hint.id ? [hint.id] : [],
        descriptions: hint.description ? [hint.description] : [],
      });
    }
    processed.push(hint);
  }

  const aggregated: AggregatedHints = {
    hints: Array.from(map.values()).sort((a, b) => b.totalRecordCountApprox - a.totalRecordCountApprox),
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(aggregated, null, 2));
  console.log(`[3.5/5] Aggregated ${aggregated.hints.length} structured-data hint group(s) -> ${outPath}`);
  return aggregated;
}
