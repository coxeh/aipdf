import { readFile, writeFile, stat } from "node:fs/promises";
import { generateJsonWithRetry, type GeminiClient } from "./gemini";

const DEFAULT_TAIL_CHARS = 3000;
const DEFAULT_BOILERPLATE_MAX = 12;

const PROMPT = `You are stitching a multi-page PDF into a single clean HTML document body. Pages arrive one at a time. For each page you receive:

- "Known boilerplate": page headers / footers we have already learned to strip on this document.
- "Previous tail": the trailing portion of the stitched document built so far. May be empty for page 1.
- "New page HTML": semantic HTML of the next page (already OCR'd).

Return JSON of EXACTLY this shape (no extra keys, no prose, no markdown):
{
  "merged": "string - HTML that REPLACES the previous tail (i.e. previous tail rewritten if needed for joins, followed by the new page's cleaned content)",
  "newHeader": "string or null - exact text of any new running header detected on this page",
  "newFooter": "string or null - exact text of any new running footer (page numbers, etc.) detected on this page"
}

Stitching rules:
1. STRIP any header/footer / page-number boilerplate from the new page before appending. If "Known boilerplate" entries appear, strip them. Also strip any text matching common patterns: standalone page numbers, "Page X of Y", repeated dates, repeated document titles.
2. MERGE TABLES across pages. If the previous tail ENDS with a <table> and the new page BEGINS with a <table> that has the same column structure (same column count, same/near-identical <th> labels, or no <th> on the continuation), DO NOT emit two tables. Instead, rewrite the previous tail's closing </table> away and append the continuation table's <tr> rows into the existing <tbody>. Drop a duplicate <thead> on the continuation.
3. CONTINUE PARAGRAPHS. If the previous tail ends mid-sentence (no terminal punctuation, or ends with a hyphen indicating a word break) and the new page begins with lowercase prose continuing the sentence, concatenate them into one <p>. For hyphen line breaks, also remove the trailing hyphen.
4. COLUMNS. If the new page has multi-column layout in the source HTML, reflow into a single linear reading order (top to bottom, left column first, then right).
5. PRESERVE all unique non-boilerplate text exactly. Never summarise, paraphrase, or omit.
6. PRESERVE structured-data anchor comments. Lines like <!-- structured-start:id="..." kind="..." title="..." --> and <!-- structured-end:id="..." --> MUST survive stitching unchanged. They are NEVER boilerplate — never strip them. When merging a table across pages (rule 2), keep the start comment from the earlier page and the end comment from the later page; drop the end comment of the earlier page and the start comment of the later page (they wrap the same merged region).
7. Page 1 case: "Previous tail" is empty. "merged" is simply the cleaned new page HTML.
8. "merged" must begin with the same content as "Previous tail" (rewritten where needed for joins/continuations) and end with the new page's appended cleaned content. Never drop earlier tail content other than tags removed for table joins or punctuation adjusted for paragraph joins.
9. Output VALID JSON only. Escape newlines inside "merged" as \\n. Use double quotes.`;

export type StitchHtmlOptions = {
  gemini: GeminiClient;
  force?: boolean;
  /** Chars of previous-tail to send with each page. Default 3000. */
  tailChars?: number;
  /** Max number of header/footer boilerplate examples to remember. Default 12. */
  boilerplateMax?: number;
};

type StitchState = {
  pagesProcessed: number;
  stitched: string;
  headerExamples: string[];
  footerExamples: string[];
};

type StitchResponse = {
  merged: string;
  newHeader: string | null;
  newFooter: string | null;
};

function dedupePush(list: string[], value: string | null | undefined, max: number) {
  if (!value) return;
  const v = value.trim();
  if (!v) return;
  const existing = list.indexOf(v);
  if (existing !== -1) {
    // Already known - move to end to mark as recently seen (LRU).
    list.splice(existing, 1);
    list.push(v);
    return;
  }
  list.push(v);
  if (list.length > max) list.shift(); // evict least-recently-seen
}

async function loadState(statePath: string): Promise<StitchState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StitchState>;
    return {
      pagesProcessed: parsed.pagesProcessed ?? 0,
      stitched: parsed.stitched ?? "",
      headerExamples: parsed.headerExamples ?? [],
      footerExamples: parsed.footerExamples ?? [],
    };
  } catch {
    return { pagesProcessed: 0, stitched: "", headerExamples: [], footerExamples: [] };
  }
}

async function saveState(statePath: string, state: StitchState) {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

export async function stitchHtml(
  htmlPaths: string[],
  outPath: string,
  statePath: string,
  opts: StitchHtmlOptions,
): Promise<string> {
  const {
    gemini,
    force = false,
    tailChars = DEFAULT_TAIL_CHARS,
    boilerplateMax = DEFAULT_BOILERPLATE_MAX,
  } = opts;

  if (force) {
    await writeFile(
      statePath,
      JSON.stringify(
        { pagesProcessed: 0, stitched: "", headerExamples: [], footerExamples: [] },
        null,
        2,
      ),
    );
  } else {
    try {
      const s = await stat(outPath);
      const state = await loadState(statePath);
      if (s.size > 0 && state.pagesProcessed === htmlPaths.length) {
        console.log(`[3/5] Using cached stitched HTML at ${outPath}`);
        return await readFile(outPath, "utf8");
      }
    } catch {}
  }

  const state = await loadState(statePath);
  const total = htmlPaths.length;
  console.log(`[3/5] Stitching ${total} page(s) incrementally (resuming from page ${state.pagesProcessed + 1})...`);

  for (let i = state.pagesProcessed; i < total; i++) {
    const pagePath = htmlPaths[i]!;
    const pageHtml = await readFile(pagePath, "utf8");
    const tail = state.stitched.slice(-tailChars);

    const userContext = [
      `Known boilerplate:`,
      `  headers: ${JSON.stringify(state.headerExamples)}`,
      `  footers: ${JSON.stringify(state.footerExamples)}`,
      ``,
      `Previous tail (length=${tail.length}):`,
      tail.length ? tail : "(empty - this is page 1)",
      ``,
      `New page HTML (page ${i + 1} of ${total}):`,
      pageHtml,
    ].join("\n");

    const parsed = await generateJsonWithRetry<StitchResponse>(
      gemini,
      `stitch:p${i + 1}`,
      {
        model: gemini.model,
        config: { responseMimeType: "application/json" },
        contents: [
          { role: "user", parts: [{ text: PROMPT }, { text: userContext }] },
        ],
      },
      {
        maxAttempts: 3,
        validate: (v) => {
          if (!v || typeof v !== "object" || typeof (v as StitchResponse).merged !== "string") {
            throw new Error('response missing string "merged" field');
          }
        },
      },
    );

    state.stitched = state.stitched.slice(0, state.stitched.length - tail.length) + parsed.merged;
    dedupePush(state.headerExamples, parsed.newHeader, boilerplateMax);
    dedupePush(state.footerExamples, parsed.newFooter, boilerplateMax);
    state.pagesProcessed = i + 1;

    await saveState(statePath, state);
    await writeFile(outPath, state.stitched);

    console.log(
      `[3/5]   stitched page ${i + 1}/${total} (doc=${state.stitched.length} chars, headers=${state.headerExamples.length}, footers=${state.footerExamples.length})`,
    );
  }

  return state.stitched;
}
