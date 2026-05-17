/**
 * Shared parser for the <!-- structured-start --> / <!-- structured-end -->
 * anchor comments that the OCR stage emits around every structured region.
 *
 * Single source of truth: callers (sandbox.findRegionsHost,
 * extractData.buildExtractorSample, consolidateTables.detectAdjacentTables)
 * use these primitives so the regex and matching logic stay in lockstep.
 */
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
export declare function parseAnchors(html: string): ParsedAnchors;
/**
 * Resolve the end anchor that closes a given start anchor.
 *
 * Strategy (robust to LLM mistakes):
 *   1. Prefer an end with matching id occurring before the next start.
 *   2. Otherwise, take the FIRST end of any id occurring before the next start.
 *   3. Otherwise, return null (caller decides whether to treat region as
 *      running to next-start / EOF).
 */
export declare function findRegionEnd(start: AnchorStart, nextStartIdx: number, ends: readonly AnchorEnd[]): AnchorEnd | null;
