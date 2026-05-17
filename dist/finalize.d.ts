import type { StructuredOutput } from "./extractData";
import type { Recommendation } from "./recommend";
import type { AddressAnalysis, AddressRecommendation } from "./detectAddresses";
export type FinalOutput = {
    groupName: string;
    title: string;
    recordCount: number;
    schema: Record<string, string>;
    address: {
        hasAddress: boolean;
        columns: string[];
        joinTemplate: string | null;
        confidence: AddressRecommendation["confidence"];
        fieldName: string | null;
    };
    recommendation: {
        summary: string;
        reasons: string[];
        keyMetrics: Array<{
            label: string;
            value: string;
        }>;
    };
    records: Array<Record<string, unknown>>;
};
export declare function buildFinalOutput(merged: StructuredOutput, recommendation: Recommendation, addresses: AddressAnalysis | null, outPath: string): Promise<FinalOutput | null>;
