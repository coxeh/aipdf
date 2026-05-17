import type { GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";
export type Merge = {
    groups: string[];
    mergedName: string;
    mergedTitle: string;
    reason: string;
    fieldMap: Record<string, Record<string, string>>;
};
export type Join = {
    left: string;
    right: string;
    on: Array<{
        left: string;
        right: string;
    }>;
    type: "one-to-one" | "one-to-many" | "many-to-many" | string;
    reason: string;
};
export type JoinAnalysis = {
    merges: Merge[];
    joins: Join[];
};
export type AnalyzeJoinsOptions = {
    gemini: GeminiClient;
    force?: boolean;
};
export type AnalyzeJoinsResult = {
    analysis: JoinAnalysis;
    merged: StructuredOutput;
};
export declare function analyzeJoins(structured: StructuredOutput, analysisPath: string, mergedPath: string, opts: AnalyzeJoinsOptions): Promise<AnalyzeJoinsResult>;
