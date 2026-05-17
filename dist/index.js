import "dotenv/config";
import { loadFieldsFile, parseFieldsFlag, processPdf } from "./lib";
function printHelp() {
    console.log(`Usage: tsx src/index.ts <pdf-path> [options]

Options:
  -o, --out <dir>           Output directory (default: ./out)
  -f, --force               Ignore caches and re-run every stage
  -c, --ocr-concurrency <n> Max concurrent OCR calls in stage 2 (default: 4)
  -d, --discover-patterns   Also run plain-text pattern discovery (stage 4b);
                            useful when the PDF has data encoded only in prose
                            or whitespace layout that Gemini didn't anchor.
      --fields <list>       Comma-separated preferred field names to map onto,
                            e.g. "productName,sku,supplierName,producerName".
      --fields-file <path>  JSON file with richer preferred-field definitions
                            (array of strings, or array of
                             { name, description?, aliases?, type? }).
      --no-consolidate      Skip the table consolidation stage (row-merge +
                            column-pivot). On by default.
      --no-addresses        Skip per-group address detection stage. On by default.
  -h, --help                Show this help

Environment:
  GEMINI_API_KEY     Required. Your Gemini API key.
  GEMINI_MODEL       Optional. Defaults to gemini-2.5-flash.

Artifacts written to <outDir>:
  pages/             Page PNGs
  html/              Per-page semantic HTML (with structured-data anchors)
  hints/             Per-page structured-data hint JSON
  stitched.html      Stitched single-document HTML
  stitch-state.json  Resume state for the incremental stitcher
  hints.json         Aggregated structured-data hints
  extractor.mjs      Gemini-authored extractor script
  structured.json    Extracted structured data (one entry per group)
  joins.json         Detected merges + joins between groups
  structured-merged.json  Structured data after applying merges
  recommendation.json     Most prominent group + reasoning
`);
}
function parseArgs(argv) {
    const args = {
        pdf: "",
        outDir: "out",
        force: false,
        discoverPatterns: false,
        fields: null,
        fieldsFile: null,
        noConsolidate: false,
        noAddresses: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            printHelp();
            process.exit(0);
        }
        else if (a === "--out" || a === "-o") {
            const next = argv[++i];
            if (!next) {
                console.error("--out requires a directory argument");
                process.exit(1);
            }
            args.outDir = next;
        }
        else if (a === "--force" || a === "-f") {
            args.force = true;
        }
        else if (a === "--discover-patterns" || a === "-d") {
            args.discoverPatterns = true;
        }
        else if (a === "--fields") {
            const next = argv[++i];
            if (!next) {
                console.error("--fields requires a comma-separated list");
                process.exit(1);
            }
            args.fields = next;
        }
        else if (a === "--fields-file") {
            const next = argv[++i];
            if (!next) {
                console.error("--fields-file requires a path");
                process.exit(1);
            }
            args.fieldsFile = next;
        }
        else if (a === "--no-consolidate") {
            args.noConsolidate = true;
        }
        else if (a === "--no-addresses") {
            args.noAddresses = true;
        }
        else if (a === "--ocr-concurrency" || a === "-c") {
            const next = argv[++i];
            const n = Number(next);
            if (!Number.isFinite(n) || n < 1) {
                console.error("--ocr-concurrency requires a positive integer");
                process.exit(1);
            }
            args.ocrConcurrency = Math.floor(n);
        }
        else if (!args.pdf) {
            args.pdf = a;
        }
        else {
            console.error(`Unexpected argument: ${a}`);
            printHelp();
            process.exit(1);
        }
    }
    if (!args.pdf) {
        printHelp();
        process.exit(1);
    }
    return args;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    let preferredFields;
    if (args.fieldsFile) {
        preferredFields = await loadFieldsFile(args.fieldsFile);
    }
    else if (args.fields) {
        preferredFields = parseFieldsFlag(args.fields);
    }
    if (preferredFields?.length) {
        console.log(`Using ${preferredFields.length} preferred field(s): ${preferredFields.map((f) => f.name).join(", ")}`);
    }
    const result = await processPdf(args.pdf, {
        outDir: args.outDir,
        force: args.force,
        ocrConcurrency: args.ocrConcurrency,
        discoverPatterns: args.discoverPatterns,
        noConsolidate: args.noConsolidate,
        noAddresses: args.noAddresses,
        preferredFields,
    });
    console.log("\nDone.");
    console.log(`  pages:               ${result.imagePaths.length}`);
    console.log(`  anchor groups:       ${result.structured.groups.length - (result.discoveredStructured?.groups.length ?? 0)}`);
    if (result.discoveredStructured) {
        console.log(`  discovered groups:   ${result.discoveredStructured.groups.length} (text pattern discovery)`);
    }
    if (result.fieldMapping) {
        const matched = result.fieldMapping.mappings.reduce((n, m) => n + m.matchedPreferredFields.length, 0);
        console.log(`  field-map matches:   ${matched} across ${result.fieldMapping.mappings.length} group(s)`);
    }
    if (result.consolidationAnalysis) {
        const rowMerges = result.consolidationAnalysis.consolidations.filter((c) => c.kind === "row-merge").length;
        const pivots = result.consolidationAnalysis.consolidations.filter((c) => c.kind === "column-pivot").length;
        console.log(`  table consolidation: ${rowMerges} row-merge(s), ${pivots} column-pivot(s)`);
    }
    if (result.addressAnalysis) {
        console.log(`\nAddress recommendations (out/addresses.json):`);
        for (const rec of result.addressAnalysis.addressRecommendations) {
            if (!rec.hasAddress) {
                console.log(`  - ${rec.groupName}: no address (${rec.confidence})`);
                continue;
            }
            console.log(`  - ${rec.groupName}: [${rec.columns.join(", ")}]  template: ${rec.joinTemplate}  (${rec.confidence})`);
            if (rec.exampleJoined)
                console.log(`      example: ${rec.exampleJoined}`);
        }
    }
    console.log(`  merges applied:      ${result.joinAnalysis.merges.length}`);
    console.log(`  joins detected:      ${result.joinAnalysis.joins.length}`);
    console.log(`  final groups:        ${result.merged.groups.length}`);
    console.log(`  total records:       ${result.merged.groups.reduce((n, g) => n + g.records.length, 0)}`);
    console.log(`  prominent:           ${result.recommendation.prominent?.title ?? "(unknown)"}`);
    const c = result.costs;
    console.log(`\nLLM usage (this run):`);
    console.log(`  total calls:         ${c.totalCalls}`);
    console.log(`  input tokens:        ${c.totalInputTokens.toLocaleString()}`);
    console.log(`  output tokens:       ${c.totalOutputTokens.toLocaleString()}`);
    console.log(`  total cost:          $${c.totalCostUsd.toFixed(4)}`);
    if (Object.keys(c.byStage).length) {
        console.log(`  by stage:`);
        for (const [stage, s] of Object.entries(c.byStage)) {
            console.log(`    ${stage.padEnd(20)} ${String(s.calls).padStart(4)} call(s)  $${s.costUsd.toFixed(4)}`);
        }
    }
    if (c.unknownPricingModels.length) {
        console.log(`  WARNING: no pricing for model(s) ${c.unknownPricingModels.join(", ")} - cost shown as $0 for those calls.`);
    }
    console.log(`\nArtifacts in: ${result.outDir}`);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map