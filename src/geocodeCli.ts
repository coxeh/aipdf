#!/usr/bin/env node
import "dotenv/config";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { geocodeFromFile } from "./geocode";

type Args = {
  input: string;
  output: string;
  concurrency?: number;
  qps?: number;
  maxRetries?: number;
  force: boolean;
  apiKey?: string;
  geoJsonPath?: string | null;
};

function printHelp() {
  console.log(`Usage: tsx src/geocodeCli.ts [input.json] [output.json] [options]

Defaults:
  input    out/final-verified.json (falls back to out/final.json if missing)
  output   out/final-geocoded.json

Options:
  -c, --concurrency <n>   Concurrent API requests (default 5)
      --qps <n>           Cap queries per second (0 = unlimited; default 0)
      --max-retries <n>   Max attempts per address on transient errors (default 5)
      --api-key <key>     Override Google Geocoding API key
      --geojson <path>    GeoJSON output path (default: <output>.geojson)
      --no-geojson        Skip GeoJSON output entirely
  -f, --force             Ignore cached output
  -h, --help              Show this help

Environment:
  GOOGLE_GEOCODING_API_KEY (preferred) or GOOGLE_MAPS_API_KEY

Input shape: either an array of records, or an object with a "records" array
(final.json / final-verified.json). Address per record is taken from
verification.matchedAddress when present, else address, else fullAddress.
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: "",
    output: "out/final-geocoded.json",
    force: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a === "-f" || a === "--force") {
      args.force = true;
    } else if (a === "-c" || a === "--concurrency") {
      args.concurrency = Number(argv[++i]);
    } else if (a === "--qps") {
      args.qps = Number(argv[++i]);
    } else if (a === "--max-retries") {
      args.maxRetries = Number(argv[++i]);
    } else if (a === "--api-key") {
      args.apiKey = argv[++i];
    } else if (a === "--geojson") {
      args.geoJsonPath = argv[++i];
    } else if (a === "--no-geojson") {
      args.geoJsonPath = null;
    } else {
      positional.push(a);
    }
  }
  if (positional[0]) args.input = positional[0];
  if (positional[1]) args.output = positional[1];
  if (!args.input) args.input = "out/final-verified.json";
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let input = resolve(args.input);
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });

  // Fallback to out/final.json if final-verified.json doesn't exist.
  try {
    await import("node:fs/promises").then((m) => m.stat(input));
  } catch {
    const fallback = resolve("out/final.json");
    try {
      await import("node:fs/promises").then((m) => m.stat(fallback));
      console.log(`[geocode] ${args.input} not found; using ${fallback}`);
      input = fallback;
    } catch {
      console.error(`Input not found: ${args.input}\nRun the pipeline first to produce final.json or final-verified.json.`);
      process.exit(1);
    }
  }

  await geocodeFromFile(input, output, {
    apiKey: args.apiKey,
    concurrency: args.concurrency,
    qps: args.qps,
    maxRetries: args.maxRetries,
    force: args.force,
    geoJsonPath: args.geoJsonPath,
  });

  console.log(`\nWrote ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
