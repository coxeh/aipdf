import { type GeminiClient } from "./gemini";
import type { FinalOutput } from "./finalize";
export type RecordVerification = {
    confidence: "high" | "medium" | "low" | "unknown";
    matchedName: string | null;
    matchedAddress: string | null;
    evidence: string;
    sources: string[];
};
export type VerifyCosts = {
    inputTokens: number;
    outputTokens: number;
    tokensCostUsd: number;
    groundedCalls: number;
    groundingPricePerCall: number;
    groundingCostUsd: number;
    totalCostUsd: number;
};
export type VerifyAddressesResult = {
    meta: {
        model: string;
        batchSize: number;
        grounded: boolean;
        verifiedAt: string;
        summary: {
            high: number;
            medium: number;
            low: number;
            unknown: number;
        };
        costs: VerifyCosts;
    };
    records: Array<Record<string, unknown> & {
        verification: RecordVerification;
    }>;
};
export type VerifyAddressesOptions = {
    gemini: GeminiClient;
    force?: boolean;
    /** Records per LLM call. Default 5. */
    batchSize?: number;
    /** Concurrent in-flight batch requests. Default 4. */
    concurrency?: number;
    /** Use Google Search grounding via Gemini's googleSearch tool. Default true. */
    useGrounding?: boolean;
    /** Override which field on each record is treated as the entity name. */
    nameField?: string;
    /**
     * USD per grounded request (Google Search tool surcharge). Default 0.035.
     * Verify against current Gemini grounding pricing for your tier.
     */
    pricePerGroundingCall?: number;
    /** Document title (helps the model interpret what these records describe). */
    documentTitle?: string;
    /** Short summary describing what the document / dataset is about. */
    documentSummary?: string;
};
export declare function verifyAddressesAndNames(final: FinalOutput, outPath: string, opts: VerifyAddressesOptions): Promise<VerifyAddressesResult>;
/** Convenience: read a `final.json` and verify in one call. */
export declare function verifyAddressesFromFile(finalJsonPath: string, outPath: string, opts: VerifyAddressesOptions): Promise<VerifyAddressesResult>;
