import { type GeminiClient } from "./gemini";
import { type SandboxOptions } from "./sandbox";
import type { StructuredOutput } from "./extractData";
export type DiscoveredPattern = {
    name: string;
    title: string;
    description: string;
    schemaGuess: Record<string, string>;
    evidence: string;
    approxCount: number;
    extractionHints: string;
};
export type PatternsProposal = {
    patterns: DiscoveredPattern[];
};
export type DiscoverPatternsOptions = {
    gemini: GeminiClient;
    force?: boolean;
    maxAttempts?: number;
    sandbox?: SandboxOptions;
    sampleHeadChars?: number;
    sampleTailChars?: number;
    sampleMaxChars?: number;
};
export declare function htmlToPlainText(html: string): string;
export declare function samplePlainText(text: string, opts?: {
    headChars?: number;
    tailChars?: number;
    maxChars?: number;
}): {
    sample: string;
    sampledChars: number;
    totalChars: number;
};
export declare function proposePatterns(sample: string, outPath: string, opts: DiscoverPatternsOptions): Promise<PatternsProposal>;
export declare function extractWithPatterns(fullText: string, sample: string, patterns: PatternsProposal, outJsonPath: string, scriptPath: string, opts: DiscoverPatternsOptions): Promise<StructuredOutput>;
export type DiscoverPaths = {
    patternsPath: string;
    scriptPath: string;
    outJsonPath: string;
    plainTextPath?: string;
};
export declare function discoverStructuredFromText(stitchedHtml: string, paths: DiscoverPaths, opts: DiscoverPatternsOptions): Promise<{
    proposal: PatternsProposal;
    structured: StructuredOutput;
    plainText: string;
}>;
