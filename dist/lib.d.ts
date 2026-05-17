import { type CostsSummary, type GeminiClient, type ModelPricing } from "./gemini";
import { type AggregatedHints } from "./hints";
import { type StructuredOutput } from "./extractData";
import { type JoinAnalysis } from "./joinData";
import { type Recommendation } from "./recommend";
import type { SandboxOptions } from "./sandbox";
import { type PatternsProposal } from "./discoverPatterns";
import { type PreferredField, type FieldMappingResult } from "./mapFields";
import { type ConsolidationAnalysis } from "./consolidateTables";
import { type AddressAnalysis } from "./detectAddresses";
import { type FinalOutput } from "./finalize";
export type ProcessPdfOptions = {
    outDir?: string;
    force?: boolean;
    apiKey?: string;
    model?: string;
    gemini?: GeminiClient;
    tailChars?: number;
    /** Max concurrent OCR (stage 2) calls. Default 4. */
    ocrConcurrency?: number;
    /** Override / extend the default model pricing table (USD per 1M tokens). */
    pricing?: Record<string, ModelPricing>;
    /** Sandbox limits for the generated extractor script. */
    sandbox?: SandboxOptions;
    /** Run plain-text pattern discovery in addition to anchor-based extraction. */
    discoverPatterns?: boolean;
    /** Preferred target fields. When set, run the field-mapping stage to harmonise field names. */
    preferredFields?: PreferredField[];
    /** Skip the table consolidation stage (row-merge + column-pivot). Default false (consolidation runs). */
    noConsolidate?: boolean;
    /** Skip the per-group address detection stage. Default false (detection runs). */
    noAddresses?: boolean;
    /** PDF render scale (passed to pdf-to-img). Default 2. Bump for low-resolution scans. */
    pdfScale?: number;
    /** Max number of header/footer boilerplate examples the stitcher remembers. Default 12. */
    boilerplateMax?: number;
    /** Max chars of prose between adjacent table anchors to flag as a continuation gap. Default 800. */
    adjacencyMaxGapChars?: number;
    /**
     * How to choose the prominent group.
     *   "data-volume" (default): deterministic - largest by recordCount × fieldCount.
     *   "llm-judgement": let the LLM weight narrative importance (old behaviour).
     */
    recommendStrategy?: "data-volume" | "llm-judgement";
};
export type ProcessPdfResult = {
    outDir: string;
    imagePaths: string[];
    htmlPagePaths: string[];
    hintsPaths: string[];
    stitchedHtml: string;
    aggregatedHints: AggregatedHints;
    structured: StructuredOutput;
    patternsProposal: PatternsProposal | null;
    discoveredStructured: StructuredOutput | null;
    fieldMapping: FieldMappingResult | null;
    consolidationAnalysis: ConsolidationAnalysis | null;
    joinAnalysis: JoinAnalysis;
    addressAnalysis: AddressAnalysis | null;
    merged: StructuredOutput;
    recommendation: Recommendation;
    finalOutput: FinalOutput | null;
    costs: CostsSummary;
};
export declare function processPdf(pdfPath: string, options?: ProcessPdfOptions): Promise<ProcessPdfResult>;
export { pdfToImages } from "./pdfToImages";
export { ocrPages } from "./ocrToHtml";
export { stitchHtml } from "./stitchHtml";
export { aggregateHints } from "./hints";
export { extractStructured, buildExtractorSample } from "./extractData";
export { analyzeJoins } from "./joinData";
export { recommendProminent } from "./recommend";
export { createGeminiClient, DEFAULT_MODEL_PRICING } from "./gemini";
export { scanForbiddenTokens, scanAst, runExtractor, runExtractorInSandbox, runScriptInSandbox, runTextPatternExtractor, runTextPatternExtractorInSandbox, } from "./sandbox";
export { discoverStructuredFromText, proposePatterns, extractWithPatterns, htmlToPlainText, samplePlainText, } from "./discoverPatterns";
export { mapFields, parseFieldsFlag, loadFieldsFile, } from "./mapFields";
export { consolidateTables } from "./consolidateTables";
export { detectAddresses } from "./detectAddresses";
export { buildFinalOutput } from "./finalize";
export { verifyAddressesAndNames, verifyAddressesFromFile } from "./verifyAddresses";
export type { GeminiClient, CreateGeminiOptions, ModelPricing, UsageRecord, StageSummary, CostsSummary, } from "./gemini";
export type { PdfToImagesOptions } from "./pdfToImages";
export type { OcrPagesOptions, OcrPagesResult } from "./ocrToHtml";
export type { StitchHtmlOptions } from "./stitchHtml";
export type { StructuredHint, PageHints, AggregatedHint, AggregatedHints, } from "./hints";
export type { StructuredOutput, ExtractStructuredOptions, ExtractorSampleOptions, } from "./extractData";
export type { JoinAnalysis, Merge, Join, AnalyzeJoinsOptions, AnalyzeJoinsResult, } from "./joinData";
export type { Recommendation, RecommendProminentOptions, } from "./recommend";
export type { SandboxOptions, HelperImpl } from "./sandbox";
export type { DiscoveredPattern, PatternsProposal, DiscoverPatternsOptions, DiscoverPaths, } from "./discoverPatterns";
export type { PreferredField, FieldMappingForGroup, FieldMappingResult, MapFieldsOptions, MapFieldsResult, } from "./mapFields";
export type { TableConsolidation, RowMergeConsolidation, ColumnPivotConsolidation, ConsolidationAnalysis, ConsolidateTablesOptions, ConsolidateTablesResult, } from "./consolidateTables";
export type { AddressRecommendation, AddressAnalysis, DetectAddressesOptions, } from "./detectAddresses";
export type { FinalOutput } from "./finalize";
export type { RecordVerification, VerifyAddressesResult, VerifyAddressesOptions, } from "./verifyAddresses";
export type { RecordGeocode, GeocodeStatus, GeocodeOptions, GeocodeResult, GeoJSONFeature, GeoJSONFeatureCollection, } from "./geocode";
