import { writeFile, readFile, stat } from "node:fs/promises";
import type { GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";
import { parseAnchors, findRegionEnd } from "./anchors";
import { camelCase } from "./strings";

export type RowMergeConsolidation = {
  kind: "row-merge";
  groups: string[];
  consolidatedName: string;
  consolidatedTitle: string;
  unifiedSchema: Record<string, string>;
  fieldMap: Record<string, Record<string, string>>;
  reason: string;
};

export type ColumnPivotConsolidation = {
  kind: "column-pivot";
  groups: string[];
  consolidatedName: string;
  consolidatedTitle: string;
  unifiedSchema: Record<string, string>;
  pivotFields: string[];
  targetField: string;
  keepFields?: string[];
  reason: string;
};

export type TableConsolidation = RowMergeConsolidation | ColumnPivotConsolidation;

export type ConsolidationAnalysis = {
  consolidations: TableConsolidation[];
};

const PROMPT = `You are given a list of EXTRACTED GROUPS from a single PDF. Each group has a name, title, schema (field names + types), sample records, and total record count.

Some of these groups are not really distinct tables — they are the SAME LOGICAL TABLE that got broken into separate groups because of pagination, visual sub-column layouts, re-rendered headers, headerLESS continuations on later pages, or imperfect anchoring during stitching. Your job is to identify those cases and propose how to consolidate them.

There are TWO consolidation kinds:

(1) "row-merge" — two or more groups have THE SAME or SEMANTICALLY-EQUIVALENT columns. They are records of the same table that got broken across a page boundary or rendered as separate tables. Consolidate by concatenating records, aligning columns via fieldMap.

(2) "column-pivot" — ONE group has fields that look like visual sub-columns of a single logical column (e.g. \`column1Supplier\`, \`column2Supplier\`, \`column3Supplier\`; or \`group1\`, \`group2\`, \`group3\`). The source page laid the data out in N parallel columns for visual density but it's logically a single list. Pivot: each record's N sub-column values become N separate records, each with one field. (If there are also "keep" fields that should stay alongside every pivoted record, list them.)

ADJACENT-TABLE HINTS
You will ALSO be given a "tableAdjacency" array. Each entry describes two table regions that appeared one right after the other in the stitched HTML, separated only by a short stretch of prose. For each entry you must JUDGE the gap text yourself:

- gapText is a "continuation gap" (the two tables ARE one logical table, split visually) when it reads like an aside, footnote, source citation, transient note, disclaimer, or any sentence that LEAVES the table topic without introducing a new one. Examples (in any language):
    "¹ Note: ...", "* Source: ...", "Continued on next page.", "Data updated September 2023.",
    "Anmerkung: ...", "Nota: ...", a single short paragraph explaining a footnote marker that
    appeared inside the first table, etc.
- gapText is a "section break" (the two tables are DIFFERENT) when it introduces a new topic, contains a new heading or section title, transitions to unrelated subject matter, or describes a NEW table that follows.
- Use the surrounding context: if the two tables share a column count or schema shape, the continuation interpretation is more likely. If their schemas are obviously different, the break interpretation is more likely.

When you decide the gap is a continuation, treat the second region as a continuation of the first and map its columns onto the first group's schema by COLUMN POSITION. Do this even when the second region appears to have its OWN <thead> — the OCR sometimes promotes data rows into a <thead>, so judge by the sample values not the column labels.

CRITICAL: HEADERLESS CONTINUATION TABLES
When a table spans multiple pages and the later pages DO NOT re-render the header row, the extraction pipeline can mistakenly promote the FIRST DATA ROW into fake field names. You MUST detect this and merge those groups with their header-bearing counterpart.

Signs that a group is a headerless continuation (NOT a distinct table):
- It has the SAME column count as another group whose schema field names look like real labels.
- Its field names look like DATA VALUES, not labels. Examples of "looks like data":
  * ALL-UPPERCASE country codes / region names (GHANA, NIGERIA, IVORY_COAST).
  * Specific organisation codes (NKAWIE, KOKOOPA, ASOAGRICOLA).
  * Person names, city names, ISO codes used as field keys.
- Its sample records contain a column whose value is CONSTANT and REPEATED across most/all rows (e.g. \`sourcingDistrict: "sourcing district"\` on every row). That repeated literal is the ORIGINAL column header from the source PDF — the extractor saw it as a cell value because there was no <th>.
- recordCount is suspiciously low (0 or 1 fewer than expected) compared to a sibling group.

When you detect this:
- Propose a row-merge with the OTHER group (the one with real headers) as the canonical schema.
- In fieldMap for the headerless group, map its "looks like data" field names onto the canonical group's real field names by COLUMN POSITION (preserving column order). For example: if the canonical group has [origin, farmerGroup, fullName, locationMainCity] and the headerless group has [gHANA, nKAWIE, sourcingDistrict, nkawie], map by position: gHANA → origin, nKAWIE → farmerGroup, sourcingDistrict → fullName, nkawie → locationMainCity.
- The constant value in the headerless group's "fullName-position" field (e.g. "sourcing district") IS legitimate row content for those rows — keep it as the value, don't drop it.

Return JSON of EXACTLY this shape (no prose, no markdown):
{
  "consolidations": [
    {
      "kind": "row-merge",
      "groups": [ "<source group names>" ],
      "consolidatedName": "<kebab-case>",
      "consolidatedTitle": "<human-readable>",
      "unifiedSchema": { "<unifiedFieldName>": "<type>" },
      "fieldMap": {
        "<sourceGroupName>": { "<rawField>": "<unifiedField>" }
      },
      "reason": "<short evidence>"
    },
    {
      "kind": "column-pivot",
      "groups": [ "<single source group name>" ],
      "consolidatedName": "<kebab-case>",
      "consolidatedTitle": "<human-readable>",
      "unifiedSchema": { "<targetField>": "<type>" },
      "pivotFields": [ "<rawField1>", "<rawField2>", "<rawField3>" ],
      "targetField": "<unifiedField>",
      "keepFields": [],
      "reason": "<short evidence>"
    }
  ]
}

Rules:
- Be CONSERVATIVE for normal cases. Only propose a consolidation when you have strong evidence: matching kind, overlapping schemas, similar/related titles, sample values that look like the same population.
- Be AGGRESSIVE about the headerless-continuation signs above. Same column count + field-names-that-look-like-data + a constant repeated value in one field is enough evidence by itself.
- For tableAdjacency entries: judge the gap text per the criteria above. When you classify it as a continuation gap, treat the merge as strongly supported even if column counts differ or one side looks "headerless".
- Titles can DIFFER between continuation groups (the OCR re-titles each visual region). Don't reject a merge just because titles differ — focus on column count, sample values, and the data-as-fieldnames pattern.
- COLUMN-SUBSET MERGES: if a smaller group has FEWER columns than a canonical group but its columns clearly map to a subset of the canonical schema (by data shape — same origin/country values, same code style, etc.), STILL merge. In fieldMap, map the smaller group's fields onto the matching canonical fields; the unified schema is the canonical superset, and records from the smaller group simply omit the missing columns (downstream will see undefined/null for those cells). A 3-field group merging into a 4-field canonical is fine.
- For row-merge: every source group's raw fields must appear in fieldMap; unmapped fields stay under their raw name and the unified schema includes them with raw-name keys.
- For row-merge: do NOT merge groups whose sample records are clearly different populations (e.g. one is suppliers with country/currency, the other is farmer associations with org-id/city). When records describe the same kind of entity in different countries/regions, that's still ONE table.
- For column-pivot: pivotFields must look like sub-columns of the SAME logical column (e.g. supplier1/2/3 → supplier). Don't pivot unrelated fields. If pivoting changes record count from N to N*K, that's expected.
- If a group is fine as-is, do NOT include it. Empty consolidations list is fine.
- Output VALID JSON only.`;

function applyConsolidations(
  structured: StructuredOutput,
  analysis: ConsolidationAnalysis,
): StructuredOutput {
  const groupsByName = new Map(structured.groups.map((g) => [g.name, g]));
  const consumed = new Set<string>();
  const newGroups: StructuredOutput["groups"] = [];

  for (const c of analysis.consolidations ?? []) {
    if (c.kind === "row-merge") {
      const srcGroups = c.groups
        .map((n) => groupsByName.get(n))
        .filter((g): g is NonNullable<typeof g> => !!g);
      if (srcGroups.length < 2) continue;

      const schema: Record<string, string> = { ...c.unifiedSchema };
      const records: Record<string, unknown>[] = [];
      for (const src of srcGroups) {
        const map = c.fieldMap[src.name] ?? {};
        for (const rec of src.records) {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rec)) {
            const dst = map[k] ?? (camelCase(k) || k);
            out[dst] = v;
          }
          records.push(out);
        }
        // Schema additions for unmapped fields
        for (const [k, type] of Object.entries(src.schema)) {
          if (!(k in map)) {
            const dst = camelCase(k) || k;
            if (!(dst in schema)) schema[dst] = type;
          }
        }
      }
      newGroups.push({
        name: c.consolidatedName,
        title: c.consolidatedTitle,
        description: `Row-merged from ${srcGroups.map((g) => g.name).join(", ")}. ${c.reason ?? ""}`.trim(),
        schema,
        records,
      });
      for (const src of srcGroups) consumed.add(src.name);
    } else if (c.kind === "column-pivot") {
      const srcName = c.groups[0];
      if (!srcName) continue;
      const src = groupsByName.get(srcName);
      if (!src) continue;
      const pivot = c.pivotFields ?? [];
      const keep = c.keepFields ?? [];
      if (pivot.length < 2) continue;

      const records: Record<string, unknown>[] = [];
      for (const rec of src.records) {
        const keptValues: Record<string, unknown> = {};
        for (const k of keep) keptValues[k] = rec[k];
        for (const pf of pivot) {
          const val = rec[pf];
          if (val == null || val === "") continue;
          records.push({ [c.targetField]: val, ...keptValues });
        }
      }

      const schema: Record<string, string> = { ...c.unifiedSchema };
      if (!schema[c.targetField]) schema[c.targetField] = src.schema[pivot[0]!] ?? "string";
      for (const k of keep) {
        if (!schema[k]) schema[k] = src.schema[k] ?? "string";
      }

      newGroups.push({
        name: c.consolidatedName,
        title: c.consolidatedTitle,
        description: `Column-pivoted from ${src.name} (fields ${pivot.join(", ")} -> ${c.targetField}). ${c.reason ?? ""}`.trim(),
        schema,
        records,
      });
      consumed.add(src.name);
    }
  }

  for (const g of structured.groups) {
    if (!consumed.has(g.name)) newGroups.push(g);
  }
  return { groups: newGroups };
}

export type ConsolidateTablesOptions = {
  gemini: GeminiClient;
  force?: boolean;
  /** Optional stitched HTML used to detect adjacent table anchors separated by short prose. */
  stitchedHtml?: string;
  /** Max chars of prose between adjacent anchors to flag as a potential continuation gap. Default 800. */
  adjacencyMaxGapChars?: number;
};

type AdjacencyHint = {
  firstTitle: string;
  firstKind: string;
  secondTitle: string;
  secondKind: string;
  gapChars: number;
  gapText: string;
};

function detectAdjacentTables(html: string, maxGapChars = 800): AdjacencyHint[] {
  const { starts, ends } = parseAnchors(html);
  const hints: AdjacencyHint[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const s = starts[i]!;
    const next = starts[i + 1]!;
    if (s.kind !== "table" || next.kind !== "table") continue;
    const e = findRegionEnd(s, next.idx, ends);
    if (!e) continue;
    const gapStart = e.idx + e.len;
    const gapEnd = next.idx;
    const gapRaw = html.slice(gapStart, gapEnd);
    const gapStripped = gapRaw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!gapStripped) continue;
    if (gapStripped.length > maxGapChars) continue;
    hints.push({
      firstTitle: s.title,
      firstKind: s.kind,
      secondTitle: next.title,
      secondKind: next.kind,
      gapChars: gapStripped.length,
      gapText: gapStripped.slice(0, 600),
    });
  }
  return hints;
}

export type ConsolidateTablesResult = {
  analysis: ConsolidationAnalysis;
  consolidated: StructuredOutput;
};

export async function consolidateTables(
  structured: StructuredOutput,
  analysisPath: string,
  consolidatedPath: string,
  opts: ConsolidateTablesOptions,
): Promise<ConsolidateTablesResult> {
  const { gemini, force = false } = opts;

  if (!force) {
    try {
      const a = await stat(analysisPath);
      const b = await stat(consolidatedPath);
      if (a.size > 0 && b.size > 0) {
        console.log(`[4d/5] Using cached consolidation at ${analysisPath}`);
        return {
          analysis: JSON.parse(await readFile(analysisPath, "utf8")),
          consolidated: JSON.parse(await readFile(consolidatedPath, "utf8")),
        };
      }
    } catch {}
  }

  if (structured.groups.length === 0) {
    const empty: ConsolidationAnalysis = { consolidations: [] };
    await writeFile(analysisPath, JSON.stringify(empty, null, 2));
    await writeFile(consolidatedPath, JSON.stringify(structured, null, 2));
    return { analysis: empty, consolidated: structured };
  }

  console.log(`[4d/5] Looking for table consolidations across ${structured.groups.length} group(s)...`);
  const adjacency = opts.stitchedHtml
    ? detectAdjacentTables(opts.stitchedHtml, opts.adjacencyMaxGapChars ?? 800)
    : [];
  if (adjacency.length > 0) {
    console.log(`[4d/5]   ${adjacency.length} adjacent-table pair(s) with short prose gaps detected.`);
  }
  const summary = {
    groups: structured.groups.map((g) => ({
      name: g.name,
      title: g.title,
      description: g.description,
      schema: g.schema,
      recordCount: g.records.length,
      sampleRecords: g.records.slice(0, 5),
    })),
    tableAdjacency: adjacency,
  };
  const res = await gemini.generate("consolidate-tables", {
    model: gemini.model,
    config: { responseMimeType: "application/json" },
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT },
          { text: "\n\nInput:\n\n" + JSON.stringify(summary, null, 2) },
        ],
      },
    ],
  });
  let analysis: ConsolidationAnalysis;
  try {
    analysis = JSON.parse(res.text ?? "{}") as ConsolidationAnalysis;
  } catch (err) {
    throw new Error(`Failed to parse consolidation JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(analysis.consolidations)) analysis.consolidations = [];

  const consolidated = applyConsolidations(structured, analysis);

  await writeFile(analysisPath, JSON.stringify(analysis, null, 2));
  await writeFile(consolidatedPath, JSON.stringify(consolidated, null, 2));

  const rowMerges = analysis.consolidations.filter((c) => c.kind === "row-merge").length;
  const pivots = analysis.consolidations.filter((c) => c.kind === "column-pivot").length;
  console.log(
    `[4d/5] Applied ${rowMerges} row-merge(s) and ${pivots} column-pivot(s); ${structured.groups.length} -> ${consolidated.groups.length} group(s).`,
  );
  return { analysis, consolidated };
}
