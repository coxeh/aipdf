import { type GeminiClient } from "./gemini";
import type { AggregatedHints } from "./hints";
import { type SandboxOptions } from "./sandbox";
export type StructuredOutput = {
    groups: Array<{
        name: string;
        title: string;
        description: string;
        schema: Record<string, string>;
        records: Array<Record<string, unknown>>;
    }>;
};
export type ExtractStructuredOptions = {
    gemini: GeminiClient;
    force?: boolean;
    hints?: AggregatedHints;
    sample?: ExtractorSampleOptions;
    /** Max attempts to generate-and-run the extractor (default 3). */
    maxAttempts?: number;
    /** Sandbox limits (timeout, memory cap, output cap). */
    sandbox?: SandboxOptions;
};
export type ExtractorSampleOptions = {
    /** Small head slice included for any unanchored metadata at the top of the doc. Default 5_000. */
    headChars?: number;
    /** Tail slice (off by default - tail content rarely helps script generation). Default 0. */
    tailChars?: number;
    /** Per-region truncation budget. Default 2_500. */
    perRegionMaxChars?: number;
    /** Hard cap on total sample size. Default 50_000. */
    totalMaxChars?: number;
};
/**
 * Build a representative HTML sample for SCRIPT GENERATION (stage 4).
 *
 * The script needs to see the MARKUP PATTERN of each unique structured region,
 * not the records themselves (those are processed at runtime). So we send:
 *   - A small head slice (for unanchored metadata at the top of the doc).
 *   - For each unique (title|kind) anchored region, the first occurrence
 *     truncated to ~perRegionMaxChars.
 *   - No tail by default.
 *
 * If there are NO anchors at all (degenerate case), we fall back to head + tail
 * of the raw HTML so the LLM still has something to reason about.
 */
export declare function buildExtractorSample(html: string, opts?: ExtractorSampleOptions): {
    sample: string;
    sampledChars: number;
    totalChars: number;
    regionsIncluded: number;
};
export declare function extractStructured(stitchedHtml: string, outJsonPath: string, scriptPath: string, opts: ExtractStructuredOptions): Promise<StructuredOutput>;
