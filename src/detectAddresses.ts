import { writeFile, readFile, stat } from "node:fs/promises";
import { generateJsonWithRetry, type GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";

export type AddressRecommendation = {
  groupName: string;
  hasAddress: boolean;
  confidence: "high" | "medium" | "low" | "none";
  columns: string[];
  joinTemplate: string | null;
  exampleJoined: string | null;
  reasoning: string;
};

export type AddressAnalysis = {
  addressRecommendations: AddressRecommendation[];
};

const PROMPT = `You are given a list of EXTRACTED GROUPS from a single PDF, each with a name, title, schema (column names + types), and SAMPLE records. Decide which groups contain physical address data, and which columns form the address.

An address can be:
- ONE column (a full address-like string), OR
- SPLIT ACROSS COLUMNS (street + city + state + postcode + country, etc.).

For each input group, return EXACTLY one recommendation entry. Return JSON of EXACTLY this shape (no prose, no markdown):
{
  "addressRecommendations": [
    {
      "groupName": "<exact group name from input>",
      "hasAddress": true,
      "confidence": "high" | "medium" | "low",
      "columns": ["<col1>", "<col2>", "..."],
      "joinTemplate": "{col1}, {col2}, {col3}",
      "exampleJoined": "<real joined example built from one sample record>",
      "reasoning": "<short evidence-based explanation citing sample values>"
    },
    {
      "groupName": "<another group name>",
      "hasAddress": false,
      "confidence": "none",
      "columns": [],
      "joinTemplate": null,
      "exampleJoined": null,
      "reasoning": "<why no address>"
    }
  ]
}

Rules:
- TRUST THE DATA, not the column name. A column called "location" with values like "row 4" is NOT an address; a column called "site" with values like "12 High St, London, UK" IS.
- A multi-column address must have columns that genuinely combine into one address. Don't list unrelated columns just because they look location-ish.
- "joinTemplate" must use {columnName} placeholders that EXACTLY match schema field names. Separators (commas, spaces, newlines via \\n) should be what a person would write.
- "exampleJoined" must be a real value obtained by substituting placeholder values from one of the sample records into the template.
- Set "hasAddress": false when there is no address. In that case use confidence "none" and leave columns empty.
- One entry per input group. Do NOT invent groups.
- Output VALID JSON only.`;

export type DetectAddressesOptions = {
  gemini: GeminiClient;
  force?: boolean;
  /** Max groups per LLM call. Default 10. */
  chunkSize?: number;
  /** Sample records per group sent to the LLM. Default 6. */
  samplesPerGroup?: number;
  /** Max chars per string field in samples (trims very long values). Default 240. */
  maxFieldChars?: number;
};

function truncateRecord(
  rec: Record<string, unknown>,
  maxFieldChars: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string" && v.length > maxFieldChars) {
      out[k] = v.slice(0, maxFieldChars) + "...";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildSummary(
  groups: StructuredOutput["groups"],
  samplesPerGroup: number,
  maxFieldChars: number,
) {
  return {
    groups: groups.map((g) => ({
      name: g.name,
      title: g.title,
      schema: g.schema,
      recordCount: g.records.length,
      sampleRecords: g.records
        .slice(0, samplesPerGroup)
        .map((r) => truncateRecord(r, maxFieldChars)),
    })),
  };
}

export async function detectAddresses(
  structured: StructuredOutput,
  outPath: string,
  opts: DetectAddressesOptions,
): Promise<AddressAnalysis> {
  const {
    gemini,
    force = false,
    chunkSize = 10,
    samplesPerGroup = 6,
    maxFieldChars = 240,
  } = opts;

  if (!force) {
    try {
      const s = await stat(outPath);
      if (s.size > 0) {
        console.log(`[5b/5] Using cached address analysis at ${outPath}`);
        return JSON.parse(await readFile(outPath, "utf8")) as AddressAnalysis;
      }
    } catch {}
  }

  if (structured.groups.length === 0) {
    const empty: AddressAnalysis = { addressRecommendations: [] };
    await writeFile(outPath, JSON.stringify(empty, null, 2));
    return empty;
  }

  const total = structured.groups.length;
  const all: AddressRecommendation[] = [];
  const byName = new Map<string, AddressRecommendation>();

  console.log(
    `[5b/5] Detecting addresses across ${total} group(s) in chunks of ${chunkSize}...`,
  );

  for (let i = 0; i < total; i += chunkSize) {
    const chunk = structured.groups.slice(i, i + chunkSize);
    const chunkNum = Math.floor(i / chunkSize) + 1;
    const totalChunks = Math.ceil(total / chunkSize);

    console.log(
      `[5b/5]   chunk ${chunkNum}/${totalChunks}: groups ${i + 1}..${i + chunk.length}`,
    );

    const summary = buildSummary(chunk, samplesPerGroup, maxFieldChars);

    const result = await generateJsonWithRetry<AddressAnalysis>(
      gemini,
      `detect-addresses:c${chunkNum}`,
      {
        model: gemini.model,
        config: { responseMimeType: "application/json" },
        contents: [
          {
            role: "user",
            parts: [
              { text: PROMPT },
              { text: "\n\nGroups:\n\n" + JSON.stringify(summary, null, 2) },
            ],
          },
        ],
      },
      {
        maxAttempts: 3,
        validate: (v) => {
          if (
            !v ||
            typeof v !== "object" ||
            !Array.isArray((v as AddressAnalysis).addressRecommendations)
          ) {
            throw new Error('response missing "addressRecommendations" array');
          }
        },
      },
    );

    for (const rec of result.addressRecommendations) {
      // Defensive: normalise confidence casing so downstream branches on
      // `=== "high"` etc. work regardless of the model's capitalisation.
      const c = String(rec.confidence ?? "").toLowerCase();
      rec.confidence = (
        c === "high" || c === "medium" || c === "low" ? c : "none"
      ) as typeof rec.confidence;
      if (!byName.has(rec.groupName)) {
        byName.set(rec.groupName, rec);
        all.push(rec);
      }
    }
  }

  // Ensure every input group has an entry (defensive: if the LLM omitted one,
  // record an explicit "no recommendation").
  for (const g of structured.groups) {
    if (!byName.has(g.name)) {
      all.push({
        groupName: g.name,
        hasAddress: false,
        confidence: "none",
        columns: [],
        joinTemplate: null,
        exampleJoined: null,
        reasoning: "No recommendation returned by the model for this group.",
      });
    }
  }

  const analysis: AddressAnalysis = { addressRecommendations: all };
  await writeFile(outPath, JSON.stringify(analysis, null, 2));

  const withAddr = all.filter((r) => r.hasAddress).length;
  console.log(
    `[5b/5] ${withAddr}/${all.length} group(s) flagged as containing address data.`,
  );
  return analysis;
}
