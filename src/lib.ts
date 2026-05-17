import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createGeminiClient,
  type CostsSummary,
  type GeminiClient,
  type ModelPricing,
} from "./gemini";
import { pdfToImages } from "./pdfToImages";
import { ocrPages } from "./ocrToHtml";
import { stitchHtml } from "./stitchHtml";
import { aggregateHints, type AggregatedHints } from "./hints";
import { extractStructured, type StructuredOutput } from "./extractData";
import { analyzeJoins, type JoinAnalysis } from "./joinData";
import { recommendProminent, type Recommendation } from "./recommend";
import type { SandboxOptions } from "./sandbox";
import {
  discoverStructuredFromText,
  type PatternsProposal,
} from "./discoverPatterns";
import {
  mapFields,
  type PreferredField,
  type FieldMappingResult,
} from "./mapFields";
import {
  consolidateTables,
  type ConsolidationAnalysis,
} from "./consolidateTables";
import { detectAddresses, type AddressAnalysis } from "./detectAddresses";
import { buildFinalOutput, type FinalOutput } from "./finalize";

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

export async function processPdf(
  pdfPath: string,
  options: ProcessPdfOptions = {},
): Promise<ProcessPdfResult> {
  const outDir = resolve(options.outDir ?? "out");
  await mkdir(outDir, { recursive: true });

  const gemini =
    options.gemini ??
    createGeminiClient({
      apiKey: options.apiKey,
      model: options.model,
      pricing: options.pricing,
      costsLogPath: join(outDir, "costs.jsonl"),
    });
  const force = options.force ?? false;

  const imagePaths = await pdfToImages(resolve(pdfPath), join(outDir, "pages"), {
    force,
    scale: options.pdfScale,
  });

  const { htmlPaths, hintsPaths } = await ocrPages(imagePaths, join(outDir, "html"), {
    gemini,
    force,
    hintsDir: join(outDir, "hints"),
    concurrency: options.ocrConcurrency,
  });

  const stitchedHtml = await stitchHtml(
    htmlPaths,
    join(outDir, "stitched.html"),
    join(outDir, "stitch-state.json"),
    {
      gemini,
      force,
      tailChars: options.tailChars,
      boilerplateMax: options.boilerplateMax,
    },
  );

  const aggregatedHints = await aggregateHints(
    join(outDir, "hints"),
    join(outDir, "hints.json"),
  );

  const structured = await extractStructured(
    stitchedHtml,
    join(outDir, "structured.json"),
    join(outDir, "extractor.mjs"),
    { gemini, force, hints: aggregatedHints, sandbox: options.sandbox },
  );

  let patternsProposal: PatternsProposal | null = null;
  let discoveredStructured: StructuredOutput | null = null;
  let combinedStructured: StructuredOutput = structured;

  if (options.discoverPatterns) {
    const discovery = await discoverStructuredFromText(
      stitchedHtml,
      {
        patternsPath: join(outDir, "patterns.json"),
        scriptPath: join(outDir, "pattern-extractor.mjs"),
        outJsonPath: join(outDir, "structured-from-patterns.json"),
        plainTextPath: join(outDir, "stitched.txt"),
      },
      { gemini, force, sandbox: options.sandbox },
    );
    patternsProposal = discovery.proposal;
    discoveredStructured = discovery.structured;

    if (discoveredStructured.groups.length > 0) {
      combinedStructured = {
        groups: [...structured.groups, ...discoveredStructured.groups],
      };
      await writeFile(
        join(outDir, "structured.json"),
        JSON.stringify(combinedStructured, null, 2),
      );
      console.log(
        `[4b/5] Merged ${discoveredStructured.groups.length} discovered group(s) into structured.json (total ${combinedStructured.groups.length}).`,
      );
    }
  }

  let fieldMapping: FieldMappingResult | null = null;
  let harmonisedStructured: StructuredOutput = combinedStructured;
  if (options.preferredFields && options.preferredFields.length > 0) {
    const result = await mapFields(
      combinedStructured,
      join(outDir, "field-mapping.json"),
      join(outDir, "structured-harmonised.json"),
      { gemini, force, preferredFields: options.preferredFields },
    );
    fieldMapping = result.mapping;
    harmonisedStructured = result.harmonised;
  }

  let consolidationAnalysis: ConsolidationAnalysis | null = null;
  let consolidatedStructured: StructuredOutput = harmonisedStructured;
  if (!options.noConsolidate) {
    const result = await consolidateTables(
      harmonisedStructured,
      join(outDir, "consolidation.json"),
      join(outDir, "structured-consolidated.json"),
      {
        gemini,
        force,
        stitchedHtml,
        adjacencyMaxGapChars: options.adjacencyMaxGapChars,
      },
    );
    consolidationAnalysis = result.analysis;
    consolidatedStructured = result.consolidated;
  }

  const { analysis: joinAnalysis, merged } = await analyzeJoins(
    consolidatedStructured,
    join(outDir, "joins.json"),
    join(outDir, "structured-merged.json"),
    { gemini, force },
  );

  let addressAnalysis: AddressAnalysis | null = null;
  if (!options.noAddresses) {
    addressAnalysis = await detectAddresses(
      merged,
      join(outDir, "addresses.json"),
      { gemini, force },
    );
  }

  const recommendation = await recommendProminent(
    merged,
    join(outDir, "recommendation.json"),
    { gemini, force, strategy: options.recommendStrategy },
  );

  const finalOutput = await buildFinalOutput(
    merged,
    recommendation,
    addressAnalysis,
    join(outDir, "final.json"),
  );
  if (finalOutput) {
    console.log(
      `[final] Wrote out/final.json: ${finalOutput.title} (${finalOutput.recordCount} records${finalOutput.address.fieldName ? `, address as "${finalOutput.address.fieldName}"` : ""})`,
    );
  }

  const costs = gemini.summary();
  await writeFile(join(outDir, "costs.json"), JSON.stringify(costs, null, 2));

  return {
    outDir,
    imagePaths,
    htmlPagePaths: htmlPaths,
    hintsPaths,
    stitchedHtml,
    aggregatedHints,
    structured: consolidatedStructured,
    patternsProposal,
    discoveredStructured,
    fieldMapping,
    consolidationAnalysis,
    joinAnalysis,
    addressAnalysis,
    merged,
    recommendation,
    finalOutput,
    costs,
  };
}

export { pdfToImages } from "./pdfToImages";
export { ocrPages } from "./ocrToHtml";
export { stitchHtml } from "./stitchHtml";
export { aggregateHints } from "./hints";
export { extractStructured, buildExtractorSample } from "./extractData";
export { analyzeJoins } from "./joinData";
export { recommendProminent } from "./recommend";
export { createGeminiClient, DEFAULT_MODEL_PRICING } from "./gemini";
export {
  scanForbiddenTokens,
  scanAst,
  runExtractor,
  runExtractorInSandbox,
  runScriptInSandbox,
  runTextPatternExtractor,
  runTextPatternExtractorInSandbox,
} from "./sandbox";
export {
  discoverStructuredFromText,
  proposePatterns,
  extractWithPatterns,
  htmlToPlainText,
  samplePlainText,
} from "./discoverPatterns";
export {
  mapFields,
  parseFieldsFlag,
  loadFieldsFile,
} from "./mapFields";
export { consolidateTables } from "./consolidateTables";
export { detectAddresses } from "./detectAddresses";
export { buildFinalOutput } from "./finalize";
export { verifyAddressesAndNames, verifyAddressesFromFile } from "./verifyAddresses";

export type {
  GeminiClient,
  CreateGeminiOptions,
  ModelPricing,
  UsageRecord,
  StageSummary,
  CostsSummary,
} from "./gemini";
export type { PdfToImagesOptions } from "./pdfToImages";
export type { OcrPagesOptions, OcrPagesResult } from "./ocrToHtml";
export type { StitchHtmlOptions } from "./stitchHtml";
export type {
  StructuredHint,
  PageHints,
  AggregatedHint,
  AggregatedHints,
} from "./hints";
export type {
  StructuredOutput,
  ExtractStructuredOptions,
  ExtractorSampleOptions,
} from "./extractData";
export type {
  JoinAnalysis,
  Merge,
  Join,
  AnalyzeJoinsOptions,
  AnalyzeJoinsResult,
} from "./joinData";
export type {
  Recommendation,
  RecommendProminentOptions,
} from "./recommend";
export type { SandboxOptions, HelperImpl } from "./sandbox";
export type {
  DiscoveredPattern,
  PatternsProposal,
  DiscoverPatternsOptions,
  DiscoverPaths,
} from "./discoverPatterns";
export type {
  PreferredField,
  FieldMappingForGroup,
  FieldMappingResult,
  MapFieldsOptions,
  MapFieldsResult,
} from "./mapFields";
export type {
  TableConsolidation,
  RowMergeConsolidation,
  ColumnPivotConsolidation,
  ConsolidationAnalysis,
  ConsolidateTablesOptions,
  ConsolidateTablesResult,
} from "./consolidateTables";
export type {
  AddressRecommendation,
  AddressAnalysis,
  DetectAddressesOptions,
} from "./detectAddresses";
export type { FinalOutput } from "./finalize";
export type {
  RecordVerification,
  VerifyAddressesResult,
  VerifyAddressesOptions,
} from "./verifyAddresses";
export type {
  RecordGeocode,
  GeocodeStatus,
  GeocodeOptions,
  GeocodeResult,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
} from "./geocode";
