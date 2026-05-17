import { writeFile, readFile, stat } from "node:fs/promises";
import type { GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";

export type Merge = {
  groups: string[];
  mergedName: string;
  mergedTitle: string;
  reason: string;
  fieldMap: Record<string, Record<string, string>>;
};

export type Join = {
  left: string;
  right: string;
  on: Array<{ left: string; right: string }>;
  type: "one-to-one" | "one-to-many" | "many-to-many" | string;
  reason: string;
};

export type JoinAnalysis = {
  merges: Merge[];
  joins: Join[];
};

const PROMPT = `You are given a summary of structured-data groups extracted from a PDF (name, title, description, schema, sample records, total record count). Analyse whether any of these groups can be combined.

Return JSON of EXACTLY this shape:
{
  "merges": [
    {
      "groups": ["sourceGroupName1", "sourceGroupName2", "..."],
      "mergedName": "kebab-case identifier for the unified group",
      "mergedTitle": "human-readable title",
      "reason": "why these are the same conceptual entity",
      "fieldMap": {
        "sourceGroupName1": { "srcFieldA": "targetFieldA", "srcFieldB": "targetFieldB" },
        "sourceGroupName2": { "...": "..." }
      }
    }
  ],
  "joins": [
    {
      "left": "leftGroupName",
      "right": "rightGroupName",
      "on": [{ "left": "leftFieldName", "right": "rightFieldName" }],
      "type": "one-to-one" | "one-to-many" | "many-to-many",
      "reason": "evidence the relationship exists (e.g. shared key, sample values overlap)"
    }
  ]
}

Rules:
- A MERGE is for groups that represent the SAME ENTITY (e.g. two tables that are halves of one logical list, two contact blocks with the same schema). The result is a single concatenated group. Field names that differ across sources must be unified via the fieldMap (mapping each source field name to the target field name in the merged group). Fields not in fieldMap are copied through unchanged.
- A JOIN is for groups that are RELATED but DIFFERENT entities, where one group's records reference another's via a shared key (e.g. supplier_id appears in both a "suppliers" group and a "products" group). Do NOT propose a join just because two groups share generic field names like "name" or "id" without evidence in the sample data.
- Be conservative. Only propose merges/joins you are confident about based on schema + sample records. If unsure, omit.
- Use the EXACT group names from the input.
- Output VALID JSON only. No prose.`;

function applyMerges(structured: StructuredOutput, analysis: JoinAnalysis): StructuredOutput {
  const groupsByName = new Map(structured.groups.map((g) => [g.name, g]));
  const consumed = new Set<string>();
  const newGroups: StructuredOutput["groups"] = [];

  for (const merge of analysis.merges ?? []) {
    const srcGroups = merge.groups
      .map((n) => groupsByName.get(n))
      .filter((g): g is NonNullable<typeof g> => !!g);
    if (srcGroups.length < 2) continue;

    const schema: Record<string, string> = {};
    for (const src of srcGroups) {
      const map = merge.fieldMap[src.name] ?? {};
      for (const [srcField, dstField] of Object.entries(map)) {
        if (!schema[dstField]) schema[dstField] = src.schema[srcField] ?? "string";
      }
      for (const [field, type] of Object.entries(src.schema)) {
        if (!(field in map) && !(field in schema)) schema[field] = type;
      }
    }

    const records: Record<string, unknown>[] = [];
    for (const src of srcGroups) {
      const map = merge.fieldMap[src.name] ?? {};
      for (const rec of src.records) {
        const mapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec)) {
          const dst = map[k] ?? k;
          mapped[dst] = v;
        }
        records.push(mapped);
      }
    }

    newGroups.push({
      name: merge.mergedName,
      title: merge.mergedTitle,
      description: `Merged from: ${srcGroups.map((g) => g.name).join(", ")}. ${merge.reason ?? ""}`.trim(),
      schema,
      records,
    });

    for (const src of srcGroups) consumed.add(src.name);
  }

  for (const g of structured.groups) {
    if (!consumed.has(g.name)) newGroups.push(g);
  }

  return { groups: newGroups };
}

export type AnalyzeJoinsOptions = {
  gemini: GeminiClient;
  force?: boolean;
};

export type AnalyzeJoinsResult = {
  analysis: JoinAnalysis;
  merged: StructuredOutput;
};

export async function analyzeJoins(
  structured: StructuredOutput,
  analysisPath: string,
  mergedPath: string,
  opts: AnalyzeJoinsOptions,
): Promise<AnalyzeJoinsResult> {
  const { gemini, force = false } = opts;

  if (!force) {
    try {
      const a = await stat(analysisPath);
      const m = await stat(mergedPath);
      if (a.size > 0 && m.size > 0) {
        console.log(`[4.5/5] Using cached join analysis at ${analysisPath}`);
        return {
          analysis: JSON.parse(await readFile(analysisPath, "utf8")),
          merged: JSON.parse(await readFile(mergedPath, "utf8")),
        };
      }
    } catch {}
  }

  if (structured.groups.length < 2) {
    console.log(`[4.5/5] Only ${structured.groups.length} group(s) found - skipping join analysis.`);
    const empty: JoinAnalysis = { merges: [], joins: [] };
    await writeFile(analysisPath, JSON.stringify(empty, null, 2));
    await writeFile(mergedPath, JSON.stringify(structured, null, 2));
    return { analysis: empty, merged: structured };
  }

  console.log(`[4.5/5] Analysing ${structured.groups.length} groups for possible merges/joins...`);
  const summary = {
    groups: structured.groups.map((g) => ({
      name: g.name,
      title: g.title,
      description: g.description,
      schema: g.schema,
      recordCount: g.records.length,
      sampleRecords: g.records.slice(0, 3),
    })),
  };
  const res = await gemini.generate("joins-analyse", {
    model: gemini.model,
    config: { responseMimeType: "application/json" },
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT },
          { text: "\n\nGroups summary:\n\n" + JSON.stringify(summary, null, 2) },
        ],
      },
    ],
  });
  const analysis = JSON.parse(res.text ?? "{}") as JoinAnalysis;
  analysis.merges = Array.isArray(analysis.merges) ? analysis.merges : [];
  analysis.joins = Array.isArray(analysis.joins) ? analysis.joins : [];

  const merged = applyMerges(structured, analysis);

  await writeFile(analysisPath, JSON.stringify(analysis, null, 2));
  await writeFile(mergedPath, JSON.stringify(merged, null, 2));
  console.log(
    `[4.5/5] Found ${analysis.merges.length} merge(s) and ${analysis.joins.length} join(s); merged output has ${merged.groups.length} group(s).`,
  );
  return { analysis, merged };
}
