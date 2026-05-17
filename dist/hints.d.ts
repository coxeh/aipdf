export type StructuredHint = {
    id: string;
    kind: string;
    title: string;
    description?: string;
    schemaGuess: Record<string, string>;
    recordCountApprox: number;
    /** True if this region appears to continue a table from the previous page (no visible header row). */
    isContinuation?: boolean;
    /** Title of the prior table this likely continues from, if visible. */
    continuesPrevious?: string;
};
export type PageHints = {
    page: number;
    structuredHints: StructuredHint[];
};
export type AggregatedHint = {
    title: string;
    kind: string;
    schemaGuess: Record<string, string>;
    pages: number[];
    totalRecordCountApprox: number;
    sampleIds: string[];
    descriptions: string[];
};
export type AggregatedHints = {
    hints: AggregatedHint[];
};
export declare function aggregateHints(hintsDir: string, outPath: string): Promise<AggregatedHints>;
