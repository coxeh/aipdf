import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGeminiClient, } from "./gemini";
import { pdfToImages } from "./pdfToImages";
import { ocrPages } from "./ocrToHtml";
import { stitchHtml } from "./stitchHtml";
import { aggregateHints } from "./hints";
import { extractStructured } from "./extractData";
import { analyzeJoins } from "./joinData";
import { recommendProminent } from "./recommend";
import { discoverStructuredFromText, } from "./discoverPatterns";
import { mapFields, } from "./mapFields";
import { consolidateTables, } from "./consolidateTables";
import { detectAddresses } from "./detectAddresses";
import { buildFinalOutput } from "./finalize";
export async function processPdf(pdfPath, options = {}) {
    const outDir = resolve(options.outDir ?? "out");
    await mkdir(outDir, { recursive: true });
    const gemini = options.gemini ??
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
    const stitchedHtml = await stitchHtml(htmlPaths, join(outDir, "stitched.html"), join(outDir, "stitch-state.json"), {
        gemini,
        force,
        tailChars: options.tailChars,
        boilerplateMax: options.boilerplateMax,
        model: options.stitchModel,
        fallbackModel: options.stitchFallbackModel,
    });
    const aggregatedHints = await aggregateHints(join(outDir, "hints"), join(outDir, "hints.json"));
    const structured = await extractStructured(stitchedHtml, join(outDir, "structured.json"), join(outDir, "extractor.mjs"), { gemini, force, hints: aggregatedHints, sandbox: options.sandbox });
    let patternsProposal = null;
    let discoveredStructured = null;
    let combinedStructured = structured;
    if (options.discoverPatterns) {
        const discovery = await discoverStructuredFromText(stitchedHtml, {
            patternsPath: join(outDir, "patterns.json"),
            scriptPath: join(outDir, "pattern-extractor.mjs"),
            outJsonPath: join(outDir, "structured-from-patterns.json"),
            plainTextPath: join(outDir, "stitched.txt"),
        }, { gemini, force, sandbox: options.sandbox });
        patternsProposal = discovery.proposal;
        discoveredStructured = discovery.structured;
        if (discoveredStructured.groups.length > 0) {
            combinedStructured = {
                groups: [...structured.groups, ...discoveredStructured.groups],
            };
            await writeFile(join(outDir, "structured.json"), JSON.stringify(combinedStructured, null, 2));
            console.log(`[4b/5] Merged ${discoveredStructured.groups.length} discovered group(s) into structured.json (total ${combinedStructured.groups.length}).`);
        }
    }
    let fieldMapping = null;
    let harmonisedStructured = combinedStructured;
    if (options.preferredFields && options.preferredFields.length > 0) {
        const result = await mapFields(combinedStructured, join(outDir, "field-mapping.json"), join(outDir, "structured-harmonised.json"), { gemini, force, preferredFields: options.preferredFields });
        fieldMapping = result.mapping;
        harmonisedStructured = result.harmonised;
    }
    let consolidationAnalysis = null;
    let consolidatedStructured = harmonisedStructured;
    if (!options.noConsolidate) {
        const result = await consolidateTables(harmonisedStructured, join(outDir, "consolidation.json"), join(outDir, "structured-consolidated.json"), {
            gemini,
            force,
            stitchedHtml,
            adjacencyMaxGapChars: options.adjacencyMaxGapChars,
        });
        consolidationAnalysis = result.analysis;
        consolidatedStructured = result.consolidated;
    }
    const { analysis: joinAnalysis, merged } = await analyzeJoins(consolidatedStructured, join(outDir, "joins.json"), join(outDir, "structured-merged.json"), { gemini, force });
    let addressAnalysis = null;
    if (!options.noAddresses) {
        addressAnalysis = await detectAddresses(merged, join(outDir, "addresses.json"), { gemini, force });
    }
    const recommendation = await recommendProminent(merged, join(outDir, "recommendation.json"), { gemini, force, strategy: options.recommendStrategy });
    const finalOutput = await buildFinalOutput(merged, recommendation, addressAnalysis, join(outDir, "final.json"));
    if (finalOutput) {
        console.log(`[final] Wrote out/final.json: ${finalOutput.title} (${finalOutput.recordCount} records${finalOutput.address.fieldName ? `, address as "${finalOutput.address.fieldName}"` : ""})`);
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
export { scanForbiddenTokens, scanAst, runExtractor, runExtractorInSandbox, runScriptInSandbox, runTextPatternExtractor, runTextPatternExtractorInSandbox, } from "./sandbox";
export { discoverStructuredFromText, proposePatterns, extractWithPatterns, htmlToPlainText, samplePlainText, } from "./discoverPatterns";
export { mapFields, parseFieldsFlag, loadFieldsFile, } from "./mapFields";
export { consolidateTables } from "./consolidateTables";
export { detectAddresses } from "./detectAddresses";
export { buildFinalOutput } from "./finalize";
export { verifyAddressesAndNames, verifyAddressesFromFile } from "./verifyAddresses";
//# sourceMappingURL=lib.js.map