import { runExtractor, scanAst, scanForbiddenTokens } from "../src/sandbox";

const goodHtml = `
<h1>Suppliers</h1>
<!-- structured-start:id="p1-g1" kind="table" title="Suppliers" -->
<table>
  <thead>
    <tr><th>Name</th><th>Country</th></tr>
  </thead>
  <tbody>
    <tr><td>Acme</td><td>UK</td></tr>
    <tr><td>Brokeco</td><td>FR</td></tr>
  </tbody>
</table>
<!-- structured-end:id="p1-g1" -->
`;

const goodExtractor = `
export function extract(html, helpers) {
  const regions = helpers.findRegions(html);
  const groups = [];
  for (const r of regions) {
    if (r.kind === "table") {
      const t = helpers.parseTable(r.html);
      const fields = t.headers.map(h => h.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, m => m.toLowerCase()));
      const records = t.rows.map(row => {
        const o = {};
        for (let i = 0; i < fields.length; i++) o[fields[i]] = row[i];
        return o;
      });
      const schema = {};
      for (const f of fields) schema[f] = "string";
      groups.push({
        name: r.title.toLowerCase().replace(/\\s+/g, "-"),
        title: r.title,
        description: "Suppliers table from region " + r.id,
        schema,
        records,
      });
    }
  }
  return { groups };
}
`;

const badEvalCode = `
export function extract(html, helpers) {
  eval("1");
  return { groups: [] };
}
`;

const badConstructorCode = `
export function extract(html, helpers) {
  return ({}).constructor.constructor("return 42")();
}
`;

const badRequireCode = `
export function extract(html, helpers) {
  const fs = require("fs");
  return { groups: [] };
}
`;

async function main() {
  console.log("--- token scan rejects eval ---");
  console.log(scanForbiddenTokens(badEvalCode));

  console.log("\n--- token scan rejects .constructor ---");
  console.log(scanForbiddenTokens(badConstructorCode));

  console.log("\n--- token scan rejects require ---");
  console.log(scanForbiddenTokens(badRequireCode));

  console.log("\n--- AST scan rejects eval ---");
  console.log(scanAst(badEvalCode));

  console.log("\n--- AST scan rejects .constructor ---");
  console.log(scanAst(badConstructorCode));

  console.log("\n--- token + AST + sandbox: legitimate extractor ---");
  const result = await runExtractor(goodExtractor, goodHtml);
  console.log(JSON.stringify(result, null, 2));

  console.log("\n--- runExtractor rejects eval through layers ---");
  try {
    await runExtractor(badEvalCode, goodHtml);
    console.log("FAIL: should have thrown");
  } catch (err) {
    console.log("OK rejected:", (err as Error).message);
  }

  console.log("\n--- runExtractor rejects .constructor through layers ---");
  try {
    await runExtractor(badConstructorCode, goodHtml);
    console.log("FAIL: should have thrown");
  } catch (err) {
    console.log("OK rejected:", (err as Error).message);
  }

  console.log("\n--- runExtractor rejects infinite loop via timeout ---");
  const looper = `export function extract(html, helpers) { while (true) {} return { groups: [] }; }`;
  const start = Date.now();
  try {
    await runExtractor(looper, goodHtml, { timeoutMs: 500 });
    console.log("FAIL: should have thrown");
  } catch (err) {
    console.log(`OK rejected after ${Date.now() - start}ms:`, (err as Error).message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
