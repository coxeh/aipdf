import { readFile } from "node:fs/promises";
import { buildExtractorSample } from "../src/extractData";

const html = await readFile("out/stitched.html", "utf8");

console.log(`Source: ${html.length.toLocaleString()} chars`);

const r = buildExtractorSample(html);
console.log(
  `Default sampler: ${r.sampledChars.toLocaleString()} chars; ${r.regionsIncluded} region(s).`,
);

console.log("\nFirst 600 chars of sample:");
console.log(r.sample.slice(0, 600));
console.log("\n...");
console.log("\nLast 400 chars of sample:");
console.log(r.sample.slice(-400));
