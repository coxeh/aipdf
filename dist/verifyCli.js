#!/usr/bin/env node
import "dotenv/config";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createGeminiClient } from "./gemini";
import { verifyAddressesFromFile } from "./verifyAddresses";
function printHelp() {
    console.log(`Usage: tsx src/verifyCli.ts [final.json] [output.json] [options]

Defaults:
  input    out/final.json
  output   out/final-verified.json

Options:
  -b, --batch-size <n>          Records per LLM call (default 5)
  -j, --concurrency <n>         Concurrent in-flight batch requests (default 4)
  -n, --name-field <f>          Override which schema field holds the entity name
      --no-grounding            Disable Google Search grounding
      --grounding-price <usd>   Per-call grounding cost for the cost report (default 0.035)
  -f, --force                   Ignore cached output
  -h, --help                    Show this help

Environment:
  GEMINI_API_KEY         Required
  GEMINI_MODEL           Optional (default gemini-2.5-flash)
`);
}
function parseArgs(argv) {
    const args = {
        input: "out/final.json",
        output: "out/final-verified.json",
        force: false,
        noGrounding: false,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") {
            printHelp();
            process.exit(0);
        }
        else if (a === "-f" || a === "--force") {
            args.force = true;
        }
        else if (a === "--no-grounding") {
            args.noGrounding = true;
        }
        else if (a === "-b" || a === "--batch-size") {
            args.batchSize = Number(argv[++i]);
        }
        else if (a === "-j" || a === "--concurrency") {
            args.concurrency = Number(argv[++i]);
        }
        else if (a === "-n" || a === "--name-field") {
            args.nameField = argv[++i];
        }
        else if (a === "--grounding-price") {
            args.groundingPrice = Number(argv[++i]);
        }
        else {
            positional.push(a);
        }
    }
    if (positional[0])
        args.input = positional[0];
    if (positional[1])
        args.output = positional[1];
    return args;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const input = resolve(args.input);
    const output = resolve(args.output);
    await mkdir(dirname(output), { recursive: true });
    const gemini = createGeminiClient({
        costsLogPath: output.replace(/\.json$/, ".costs.jsonl"),
    });
    const result = await verifyAddressesFromFile(input, output, {
        gemini,
        force: args.force,
        useGrounding: !args.noGrounding,
        batchSize: args.batchSize,
        concurrency: args.concurrency,
        nameField: args.nameField,
        pricePerGroundingCall: args.groundingPrice,
    });
    // Companion full cost summary (across all stages on this client - currently
    // just verify, but kept for parity with the main pipeline).
    const costsPath = output.replace(/\.json$/, ".costs.json");
    const fullCosts = gemini.summary();
    await writeFile(costsPath, JSON.stringify({ verify: result.meta.costs, llm: fullCosts }, null, 2));
    console.log(`\nWrote ${output}`);
    console.log(`Cost summary: ${costsPath}`);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=verifyCli.js.map