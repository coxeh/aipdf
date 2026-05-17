import { writeFile, readFile, stat } from "node:fs/promises";
import { generateJsonWithRetry, type GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";

export type Recommendation = {
  prominent: {
    groupName: string;
    title: string;
    summary: string;
    reasons: string[];
    keyMetrics: Array<{ label: string; value: string }>;
    runnerUp: string | null;
  };
};

export type RecommendStrategy = "data-volume" | "llm-judgement";

export type RecommendProminentOptions = {
  gemini: GeminiClient;
  force?: boolean;
  /**
   * "data-volume" (default): deterministically pick the group with the highest
   *   recordCount × fieldCount. LLM only writes the narrative for that group.
   * "llm-judgement": let the LLM weight narrative importance alongside size.
   *   Useful when the document's "headliner" table matters more than its appendix.
   */
  strategy?: RecommendStrategy;
};

type GroupType = StructuredOutput["groups"][number];

const NARRATIVE_PROMPT = `You are given ONE structured-data group from a PDF (name, title, description, schema, recordCount, sample records). Write a short narrative describing what it tells us. The group has already been chosen — your job is NOT to recommend a different one.

Return JSON of EXACTLY this shape (no prose, no markdown):
{
  "summary": "<2-3 sentences summarising what this data tells us>",
  "reasons": ["<concrete reason this group matters>", "<another>", "..."],
  "keyMetrics": [ { "label": "<string>", "value": "<string>" } ]
}

Rules:
- Reasons should cite evidence (record count, field types, what the samples show).
- keyMetrics should be derivable from the input (record count, distinct categories visible in samples, date range, etc.). Do NOT invent data.
- Output VALID JSON only.`;

const JUDGEMENT_PROMPT = `You are given a summary of structured data groups extracted from a PDF (with record counts and sample records). Identify the SINGLE most prominent / most important group and justify the choice.

"Prominent" can mean: largest by volume, most central to the document's purpose, most likely the reason the PDF was produced, or carrying the most actionable information. Use your judgement to weight these.

Return JSON of EXACTLY this shape:
{
  "prominent": {
    "groupName": "name from input",
    "title": "human readable title",
    "summary": "2-3 sentence summary of what this data tells us",
    "reasons": ["concrete reason 1", "concrete reason 2", "..."],
    "keyMetrics": [ { "label": "string", "value": "string" } ],
    "runnerUp": "name of next-most-prominent group, or null"
  }
}

Reasons must be concrete and cite evidence. Output ONLY valid JSON.`;

function cellCount(g: GroupType): number {
  return g.records.length * Math.max(1, Object.keys(g.schema).length);
}

function rankByDataVolume(groups: GroupType[]): GroupType[] {
  return [...groups].sort((a, b) => {
    const diff = cellCount(b) - cellCount(a);
    if (diff !== 0) return diff;
    // Tiebreak: more records, then more fields, then alphabetical name (stable)
    const recDiff = b.records.length - a.records.length;
    if (recDiff !== 0) return recDiff;
    const fieldDiff = Object.keys(b.schema).length - Object.keys(a.schema).length;
    if (fieldDiff !== 0) return fieldDiff;
    return a.name.localeCompare(b.name);
  });
}

async function recommendByDataVolume(
  structured: StructuredOutput,
  opts: RecommendProminentOptions,
): Promise<Recommendation> {
  const ranked = rankByDataVolume(structured.groups);
  const chosen = ranked[0];
  if (!chosen) {
    throw new Error("No groups to recommend.");
  }
  const runnerUp = ranked[1]?.name ?? null;

  console.log(
    `[5/5] Deterministic pick: ${chosen.name} (${chosen.records.length} records × ${Object.keys(chosen.schema).length} fields = ${cellCount(chosen)} cells; runner-up: ${runnerUp ?? "(none)"}).`,
  );

  const narrative = await generateJsonWithRetry<{
    summary: string;
    reasons: string[];
    keyMetrics: Array<{ label: string; value: string }>;
  }>(
    opts.gemini,
    "recommend-narrative",
    {
      model: opts.gemini.model,
      config: { responseMimeType: "application/json" },
      contents: [
        {
          role: "user",
          parts: [
            { text: NARRATIVE_PROMPT },
            {
              text:
                "\n\nChosen group:\n\n" +
                JSON.stringify(
                  {
                    name: chosen.name,
                    title: chosen.title,
                    description: chosen.description,
                    schema: chosen.schema,
                    recordCount: chosen.records.length,
                    sampleRecords: chosen.records.slice(0, 3),
                  },
                  null,
                  2,
                ),
            },
          ],
        },
      ],
    },
    {
      maxAttempts: 3,
      validate: (v) => {
        if (
          !v ||
          typeof (v as { summary?: unknown }).summary !== "string" ||
          !Array.isArray((v as { reasons?: unknown }).reasons)
        ) {
          throw new Error('response missing "summary" string or "reasons" array');
        }
      },
    },
  );

  return {
    prominent: {
      groupName: chosen.name,
      title: chosen.title,
      summary: narrative.summary,
      reasons: narrative.reasons,
      keyMetrics: Array.isArray(narrative.keyMetrics) ? narrative.keyMetrics : [],
      runnerUp,
    },
  };
}

async function recommendByLlmJudgement(
  structured: StructuredOutput,
  opts: RecommendProminentOptions,
): Promise<Recommendation> {
  console.log(`[5/5] Recommending most prominent data (LLM-judgement strategy)...`);
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
  const result = await generateJsonWithRetry<Recommendation>(
    opts.gemini,
    "recommend",
    {
      model: opts.gemini.model,
      config: { responseMimeType: "application/json" },
      contents: [
        {
          role: "user",
          parts: [
            { text: JUDGEMENT_PROMPT },
            { text: "\n\nGroups summary:\n\n" + JSON.stringify(summary, null, 2) },
          ],
        },
      ],
    },
    {
      maxAttempts: 3,
      validate: (v) => {
        const p = (v as Recommendation)?.prominent;
        if (!p || typeof p.groupName !== "string") {
          throw new Error('response missing "prominent.groupName"');
        }
      },
    },
  );
  return result;
}

export async function recommendProminent(
  structured: StructuredOutput,
  outPath: string,
  opts: RecommendProminentOptions,
): Promise<Recommendation> {
  const { force = false, strategy = "data-volume" } = opts;

  if (!force) {
    try {
      const s = await stat(outPath);
      if (s.size > 0) {
        console.log(`[5/5] Using cached recommendation at ${outPath}`);
        return JSON.parse(await readFile(outPath, "utf8"));
      }
    } catch {}
  }

  const recommendation =
    strategy === "data-volume"
      ? await recommendByDataVolume(structured, opts)
      : await recommendByLlmJudgement(structured, opts);

  await writeFile(outPath, JSON.stringify(recommendation, null, 2));
  return recommendation;
}
