import { GoogleGenAI } from "@google/genai";
type GenerateParams = Parameters<GoogleGenAI["models"]["generateContent"]>[0];
type GenerateResponse = Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
export type ModelPricing = {
    /** USD per 1,000,000 input (prompt) tokens. */
    inputPerMillion: number;
    /** USD per 1,000,000 output (candidates + reasoning) tokens. */
    outputPerMillion: number;
};
/**
 * Built-in Gemini pricing as of late 2025.
 * Verify against https://ai.google.dev/pricing for your tier; override via `pricing`.
 */
export declare const DEFAULT_MODEL_PRICING: Record<string, ModelPricing>;
export type UsageRecord = {
    ts: string;
    stage: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens: number;
    costUsd: number;
    pricingKnown: boolean;
};
export type StageSummary = {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
};
export type CostsSummary = {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    byStage: Record<string, StageSummary>;
    byModel: Record<string, StageSummary>;
    unknownPricingModels: string[];
};
export type GeminiClient = {
    ai: GoogleGenAI;
    model: string;
    generate(stage: string, params: GenerateParams): Promise<GenerateResponse>;
    getUsageLog(): UsageRecord[];
    summary(): CostsSummary;
};
export type CreateGeminiOptions = {
    apiKey?: string;
    model?: string;
    /** Override or extend the default pricing table. */
    pricing?: Record<string, ModelPricing>;
    /** If set, every call appends a JSONL line to this file. */
    costsLogPath?: string;
    /** Print "[stage] N+M tokens, $X" per call. Default true. */
    logCalls?: boolean;
};
export declare function createGeminiClient(opts?: CreateGeminiOptions): GeminiClient;
export type GenerateJsonRetryOptions = {
    /** Max JSON-parse attempts before giving up. Default 3. */
    maxAttempts?: number;
    /** Optional shape validator. Throw inside to reject. */
    validate?: (parsed: unknown) => void;
    /** Max transient-error attempts per call. Default 5. */
    transientMaxAttempts?: number;
    /** Initial backoff (ms) on transient error. Doubles each attempt. Default 1000. */
    transientBaseMs?: number;
    /** Cap on individual backoff sleep (ms). Default 30000. */
    transientMaxMs?: number;
};
/**
 * Call gemini.generate(stage, ...) and JSON.parse the response. If parsing
 * (or validation) fails, retry up to `maxAttempts` times with a follow-up
 * message describing the failure so the model can self-correct.
 *
 * Common LLM JSON failure modes this addresses:
 *   - raw newlines/control chars inside string values (should be \\n)
 *   - unescaped quotes
 *   - truncated responses
 *   - markdown fences wrapping the JSON
 */
export declare function generateJsonWithRetry<T = unknown>(client: GeminiClient, stage: string, params: Parameters<GeminiClient["generate"]>[1], opts?: GenerateJsonRetryOptions): Promise<T>;
export declare function stripFences(text: string): string;
export {};
