import { type GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";
export type Recommendation = {
    prominent: {
        groupName: string;
        title: string;
        summary: string;
        reasons: string[];
        keyMetrics: Array<{
            label: string;
            value: string;
        }>;
        runnerUp: string | null;
    };
};
export type RecommendStrategy = "data-volume" | "llm-judgement";
export type RecommendProminentOptions = {
    gemini: GeminiClient;
    force?: boolean;
    /**
     * "data-volume" (default): deterministically pick the group with the highest
     *   recordCount × fieldCount. LLM only writes the narrative for that group.
     * "llm-judgement": let the LLM weight narrative importance alongside size.
     *   Useful when the document's "headliner" table matters more than its appendix.
     */
    strategy?: RecommendStrategy;
};
export declare function recommendProminent(structured: StructuredOutput, outPath: string, opts: RecommendProminentOptions): Promise<Recommendation>;
