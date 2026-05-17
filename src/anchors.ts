/**
 * Shared parser for the <!-- structured-start --> / <!-- structured-end -->
 * anchor comments that the OCR stage emits around every structured region.
 *
 * Single source of truth: callers (sandbox.findRegionsHost,
 * extractData.buildExtractorSample, consolidateTables.detectAdjacentTables)
 * use these primitives so the regex and matching logic stay in lockstep.
 */

const START_RE = /<!--\s*structured-start:id="([^"]+)"\s+kind="([^"]+)"\s+title="([^"]+)"\s*-->/g;
const END_RE = /<!--\s*structured-end:id="([^"]+)"\s*-->/g;

export type AnchorStart = {
  id: string;
  kind: string;
  title: string;
  /** Offset of the opening `<` of the comment. */
  idx: number;
  /** Length of the full comment string including `-->`. */
  len: number;
};

export type AnchorEnd = {
  id: string;
  idx: number;
  len: number;
};

export type ParsedAnchors = {
  starts: AnchorStart[];
  ends: AnchorEnd[];
};

export function parseAnchors(html: string): ParsedAnchors {
  const starts: AnchorStart[] = [];
  const ends: AnchorEnd[] = [];

  START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = START_RE.exec(html))) {
    starts.push({ id: m[1]!, kind: m[2]!, title: m[3]!, idx: m.index, len: m[0].length });
  }
  END_RE.lastIndex = 0;
  while ((m = END_RE.exec(html))) {
    ends.push({ id: m[1]!, idx: m.index, len: m[0].length });
  }

  return { starts, ends };
}

/**
 * Resolve the end anchor that closes a given start anchor.
 *
 * Strategy (robust to LLM mistakes):
 *   1. Prefer an end with matching id occurring before the next start.
 *   2. Otherwise, take the FIRST end of any id occurring before the next start.
 *   3. Otherwise, return null (caller decides whether to treat region as
 *      running to next-start / EOF).
 */
export function findRegionEnd(
  start: AnchorStart,
  nextStartIdx: number,
  ends: readonly AnchorEnd[],
): AnchorEnd | null {
  const startAfter = start.idx + start.len;
  for (const e of ends) {
    if (e.idx <= startAfter) continue;
    if (e.idx >= nextStartIdx) break;
    if (e.id === start.id) return e;
  }
  for (const e of ends) {
    if (e.idx <= startAfter) continue;
    if (e.idx >= nextStartIdx) break;
    return e;
  }
  return null;
}
