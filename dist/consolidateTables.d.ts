import type { GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";
export type RowMergeConsolidation = {
    kind: "row-merge";
    groups: string[];
    consolidatedName: string;
    consolidatedTitle: string;
    unifiedSchema: Record<string, string>;
    fieldMap: Record<string, Record<string, string>>;
    reason: string;
};
export type ColumnPivotConsolidation = {
    kind: "column-pivot";
    groups: string[];
    consolidatedName: string;
    consolidatedTitle: string;
    unifiedSchema: Record<string, string>;
    pivotFields: string[];
    targetField: string;
    keepFields?: string[];
    reason: string;
};
export type TableConsolidation = RowMergeConsolidation | ColumnPivotConsolidation;
export type ConsolidationAnalysis = {
    consolidations: TableConsolidation[];
};
export type ConsolidateTablesOptions = {
    gemini: GeminiClient;
    force?: boolean;
    /** Optional stitched HTML used to detect adjacent table anchors separated by short prose. */
    stitchedHtml?: string;
    /** Max chars of prose between adjacent anchors to flag as a potential continuation gap. Default 800. */
    adjacencyMaxGapChars?: number;
};
export type ConsolidateTablesResult = {
    analysis: ConsolidationAnalysis;
    consolidated: StructuredOutput;
};
export declare function consolidateTables(structured: StructuredOutput, analysisPath: string, consolidatedPath: string, opts: ConsolidateTablesOptions): Promise<ConsolidateTablesResult>;
