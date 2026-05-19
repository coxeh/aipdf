import { readFile, writeFile, stat } from "node:fs/promises";
import { generateJsonWithRetry, type GeminiClient } from "./gemini";

const DEFAULT_TAIL_CHARS = 3000;
const DEFAULT_BOILERPLATE_MAX = 12;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_FALLBACK_MODEL = "gemini-2.5-flash";

const PROMPT = `You are stitching a multi-page PDF into a single clean HTML document body. Pages arrive one at a time. For each page you receive:

- "Known boilerplate": page headers / footers we have already learned to strip on this document.
- "Previous tail": the trailing portion of the stitched document built so far. May be empty for page 1.
- "New page HTML": semantic HTML of the next page (already OCR'd).

Return JSON of EXACTLY this shape (no extra keys, no prose, no markdown):
{
  "tailReplacement": null | "string - rewritten previous-tail IF AND ONLY IF you need to edit it to merge content; otherwise null",
  "append": "string - cleaned new-page content to append after the (replaced or unchanged) tail",
  "newHeader": "string or null - exact text of any new running header detected on this page",
  "newFooter": "string or null - exact text of any new running footer (page numbers, etc.) detected on this page"
}

The DIFF contract is critical for cost:
- For pages with NO cross-page merge (the common case), set "tailReplacement": null. Do NOT echo the previous tail back. Put the cleaned new page HTML in "append" only.
- For pages WHERE you need to edit the tail (table-continuation, paragraph-continuation), put the FULL rewritten tail in "tailReplacement" and put the new page's content in "append". The runtime concatenates tailReplacement + append.
- Page 1 case: "Previous tail" is empty. Set "tailReplacement": null and put cleaned HTML in "append".

Stitching rules:
1. STRIP any header/footer / page-number boilerplate from the new page before putting it in "append". If "Known boilerplate" entries appear, strip them. Also strip standalone page numbers, "Page X of Y", repeated dates, repeated document titles.
2. MERGE TABLES across pages. If the previous tail ENDS with a <table> and the new page BEGINS with a <table> that has the same column structure (same column count, same/near-identical <th> labels, or no <th> on the continuation):
   - Set "tailReplacement" to the previous tail with its closing </table> removed.
   - Set "append" to the continuation table's <tr> rows followed by </table>, then any remaining content of the new page. Drop a duplicate <thead> on the continuation.
3. CONTINUE PARAGRAPHS. If the previous tail ends mid-sentence (no terminal punctuation, or ends with a hyphen indicating a word break) and the new page begins with lowercase prose continuing the sentence:
   - Set "tailReplacement" to the previous tail with the open <p>'s closing </p> removed (and trailing hyphen removed if present).
   - Set "append" to the continuation text followed by </p>, then the rest of the new page.
4. COLUMNS. If the new page has multi-column layout in the source HTML, reflow into a single linear reading order (top to bottom, left column first, then right) in "append".
5. PRESERVE all unique non-boilerplate text exactly. Never summarise, paraphrase, or omit.
6. PRESERVE structured-data anchor comments. Lines like <!-- structured-start:id="..." kind="..." title="..." --> and <!-- structured-end:id="..." --> MUST survive stitching unchanged. They are NEVER boilerplate. When merging a table across pages (rule 2), keep the start comment from the earlier page (in the unchanged tail) and the end comment from the later page (in "append"); drop the end comment of the earlier page (omit from tailReplacement) and the start comment of the later page (omit from append).
7. Output VALID JSON only. Escape newlines inside strings as \\n. Use double quotes.`;

export type StitchHtmlOptions = {
  gemini: GeminiClient;
  force?: boolean;
  /** Chars of previous-tail to send with each page. Default 3000. */
  tailChars?: number;
  /** Max number of header/footer boilerplate examples to remember. Default 12. */
  boilerplateMax?: number;
  /**
   * Model to use for stitching. Defaults to gemini-2.5-flash-lite (cheapest).
   * Per-page model overrides the GeminiClient's default model for this stage only.
   */
  model?: string;
  /**
   * Model to fall back to if the primary model fails after all retries.
   * Default gemini-2.5-flash. Set to null/"" to disable fallback.
   */
  fallbackModel?: string | null;
};

type StitchState = {
  pagesProcessed: number;
  stitched: string;
  headerExamples: string[];
  footerExamples: string[];
};

type StitchResponse = {
  tailReplacement: string | null;
  append: string;
  newHeader: string | null;
  newFooter: string | null;
};

function dedupePush(list: string[], value: string | null | undefined, max: number) {
  if (!value) return;
  const v = value.trim();
  if (!v) return;
  const existing = list.indexOf(v);
  if (existing !== -1) {
    list.splice(existing, 1);
    list.push(v);
    return;
  }
  list.push(v);
  if (list.length > max) list.shift();
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

function validateStitchResponse(v: unknown): asserts v is StitchResponse {
  if (!v || typeof v !== "object") {
    throw new Error("response is not an object");
  }
  const r = v as Partial<StitchResponse>;
  if (typeof r.append !== "string") {
    throw new Error('response missing string "append" field');
  }
  if (r.tailReplacement != null && typeof r.tailReplacement !== "string") {
    throw new Error('"tailReplacement" must be string or null');
  }
}

async function stitchOnePage(
  gemini: GeminiClient,
  pageNum: number,
  userContext: string,
  primaryModel: string,
  fallbackModel: string | null,
): Promise<StitchResponse> {
  const params = (model: string) => ({
    model,
    config: { responseMimeType: "application/json" },
    contents: [
      { role: "user", parts: [{ text: PROMPT }, { text: userContext }] },
    ],
  });

  try {
    return await generateJsonWithRetry<StitchResponse>(
      gemini,
      `stitch:p${pageNum}`,
      params(primaryModel),
      { maxAttempts: 3, validate: (v) => validateStitchResponse(v) },
    );
  } catch (err) {
    if (!fallbackModel) throw err;
    console.log(
      `[3/5]   page ${pageNum}: ${primaryModel} failed (${(err as Error).message.slice(0, 200)}). Falling back to ${fallbackModel}.`,
    );
    return await generateJsonWithRetry<StitchResponse>(
      gemini,
      `stitch:p${pageNum}-fallback`,
      params(fallbackModel),
      { maxAttempts: 3, validate: (v) => validateStitchResponse(v) },
    );
  }
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
    model = DEFAULT_MODEL,
    fallbackModel = DEFAULT_FALLBACK_MODEL,
  } = opts;
  const effectiveFallback = fallbackModel && fallbackModel.length > 0 ? fallbackModel : null;

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
  console.log(
    `[3/5] Stitching ${total} page(s) incrementally (model=${model}, fallback=${effectiveFallback ?? "none"}, resuming from page ${state.pagesProcessed + 1}).`,
  );

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

    const parsed = await stitchOnePage(
      gemini,
      i + 1,
      userContext,
      model,
      effectiveFallback,
    );

    // Apply the diff: replace tail if requested, then append.
    const base =
      parsed.tailReplacement !== null
        ? state.stitched.slice(0, state.stitched.length - tail.length) +
          parsed.tailReplacement
        : state.stitched;
    state.stitched = base + parsed.append;

    dedupePush(state.headerExamples, parsed.newHeader, boilerplateMax);
    dedupePush(state.footerExamples, parsed.newFooter, boilerplateMax);
    state.pagesProcessed = i + 1;

    await saveState(statePath, state);
    await writeFile(outPath, state.stitched);

    const mergeKind = parsed.tailReplacement !== null ? "MERGE" : "append";
    console.log(
      `[3/5]   stitched page ${i + 1}/${total} (${mergeKind}; doc=${state.stitched.length} chars, headers=${state.headerExamples.length}, footers=${state.footerExamples.length})`,
    );
  }

  return state.stitched;
}
