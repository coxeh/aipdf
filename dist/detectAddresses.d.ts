import { type GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";
export type AddressRecommendation = {
    groupName: string;
    hasAddress: boolean;
    confidence: "high" | "medium" | "low" | "none";
    columns: string[];
    joinTemplate: string | null;
    exampleJoined: string | null;
    reasoning: string;
};
export type AddressAnalysis = {
    addressRecommendations: AddressRecommendation[];
};
export type DetectAddressesOptions = {
    gemini: GeminiClient;
    force?: boolean;
    /** Max groups per LLM call. Default 10. */
    chunkSize?: number;
    /** Sample records per group sent to the LLM. Default 6. */
    samplesPerGroup?: number;
    /** Max chars per string field in samples (trims very long values). Default 240. */
    maxFieldChars?: number;
};
export declare function detectAddresses(structured: StructuredOutput, outPath: string, opts: DetectAddressesOptions): Promise<AddressAnalysis>;
