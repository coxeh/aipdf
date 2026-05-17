import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { generateJsonWithRetry, type GeminiClient } from "./gemini";
import type { PageHints, StructuredHint } from "./hints";

const PROMPT = `You are an OCR engine. You receive ONE image of a single PDF page and must return JSON of EXACTLY this shape:

{
  "html": "string - clean semantic HTML for this page (body content only, no <html>/<head>/<body>)",
  "structuredHints": [
    {
      "id": "string - unique id within this page, e.g. p<page>-g1",
      "kind": "table" | "key-value" | "contact-list" | "address-list" | "list" | "metadata",
      "title": "human-readable title of this structured region",
      "description": "what this data is and roughly where on the page it sits",
      "schemaGuess": { "fieldName": "string|number|boolean|date" },
      "recordCountApprox": number,
      "isContinuation": true | false,
      "continuesPrevious": "title of the prior table this continues, or null"
    }
  ]
}

OCR rules for "html":
- Preserve all text EXACTLY: numbers, punctuation, casing, spacing.
- Use semantic HTML: <h1>-<h6> for headings, <p> for paragraphs, <table>/<thead>/<tbody>/<tr>/<th>/<td> for tables, <ul>/<ol>/<li> for lists.
- For multi-column layouts, output the columns in natural reading order (left column fully, then right column). Do not wrap them in column divs.
- Wrap likely running page headers in <header class="page-header"> and likely page footers (page numbers, "page X of Y", repeated boilerplate) in <footer class="page-footer">.
- Preserve every table row and cell. Mark the header row(s) with <th>.

Structured-data anchoring (CRITICAL):
- For EVERY structured region you list in "structuredHints", wrap the corresponding HTML in BOTH a start AND an end comment:
    <!-- structured-start:id="<id>" kind="<kind>" title="<title>" -->
    ...the region's HTML (table / dl / list / paragraphs)...
    <!-- structured-end:id="<id>" -->
- The "id" in the comments MUST match the "id" in the hint object.
- A structured region is anything that LOOKS like a repeated record set: any table, any block of key/value rows, contact blocks, address blocks, repeated form fields, metadata at the top of the page (issuer, date, doc title, etc.).
- "schemaGuess" should reflect the columns you can see (for tables: column headers; for key/value: the keys).
- "recordCountApprox" is the number of rows / items / records visible in the region on THIS page.
- If a region clearly continues from the previous page or onto the next page (e.g. table with no header row, or "continued..." marker), still emit start/end comments around what is visible on this page.
- CONTINUATION DETECTION: set "isContinuation": true when this table has NO visible header row (the data starts immediately, no <th>-equivalent row at the top), OR the visual layout makes it clear this is the bottom half of a table started on a previous page (e.g. only horizontal rules, no caption). When isContinuation is true, you may know the title of the source table — set "continuesPrevious" to that title (matching exactly, if possible). Otherwise set it to null. If the table has a fresh, visible header row, set isContinuation: false.
- For continuation regions WITHOUT visible headers, do NOT invent field names from the first data row when building schemaGuess — instead use positional placeholders like \`col1\`, \`col2\`, \`col3\` so downstream stages know the headers came from elsewhere. (Or repeat the prior table's headers if you remember them.)
- If there is no structured data on the page, return "structuredHints": [].

Output rules:
- Return JSON only. No markdown fences. Double quotes. Escape newlines in "html" as \\n.`;

export type OcrPagesOptions = {
  gemini: GeminiClient;
  force?: boolean;
  hintsDir?: string;
  /** Max concurrent Gemini calls. Default 4. */
  concurrency?: number;
};

type OcrResponse = {
  html: string;
  structuredHints?: StructuredHint[];
};

export type OcrPagesResult = {
  htmlPaths: string[];
  hintsPaths: string[];
};

type OcrTask = {
  idx: number;
  imgPath: string;
  htmlPath: string;
  hintsPath: string;
};

async function ocrSinglePage(gemini: GeminiClient, task: OcrTask): Promise<void> {
  const pageNum = task.idx + 1;
  const data = (await readFile(task.imgPath)).toString("base64");

  const parsed = await generateJsonWithRetry<OcrResponse>(
    gemini,
    `ocr:p${pageNum}`,
    {
      model: gemini.model,
      config: { responseMimeType: "application/json" },
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data } },
            { text: PROMPT },
          ],
        },
      ],
    },
    {
      maxAttempts: 3,
      validate: (v) => {
        if (!v || typeof v !== "object" || typeof (v as OcrResponse).html !== "string") {
          throw new Error('response missing string "html" field');
        }
      },
    },
  );

  const pageHints: PageHints = {
    page: pageNum,
    structuredHints: Array.isArray(parsed.structuredHints) ? parsed.structuredHints : [],
  };

  await writeFile(task.htmlPath, parsed.html);
  await writeFile(task.hintsPath, JSON.stringify(pageHints, null, 2));
}

export async function ocrPages(
  imagePaths: string[],
  outDir: string,
  opts: OcrPagesOptions,
): Promise<OcrPagesResult> {
  const { gemini, force = false, concurrency = 4 } = opts;
  const hintsDir = opts.hintsDir ?? join(outDir, "..", "hints");
  await mkdir(outDir, { recursive: true });
  await mkdir(hintsDir, { recursive: true });

  const htmlPaths: string[] = [];
  const hintsPaths: string[] = [];
  const tasks: OcrTask[] = [];

  for (const [idx, imgPath] of imagePaths.entries()) {
    const htmlPath = join(outDir, basename(imgPath).replace(/\.png$/, ".html"));
    const hintsPath = join(hintsDir, basename(imgPath).replace(/\.png$/, ".json"));
    htmlPaths.push(htmlPath);
    hintsPaths.push(hintsPath);

    if (!force) {
      try {
        const h = await stat(htmlPath);
        const j = await stat(hintsPath);
        if (h.size > 0 && j.size > 0) {
          console.log(`[2/5] (${idx + 1}/${imagePaths.length}) cached ${basename(htmlPath)}`);
          continue;
        }
      } catch {}
    }

    tasks.push({ idx, imgPath, htmlPath, hintsPath });
  }

  if (tasks.length === 0) return { htmlPaths, hintsPaths };

  const eff = Math.max(1, Math.min(concurrency, tasks.length));
  console.log(`[2/5] OCR'ing ${tasks.length} page(s) with concurrency=${eff}...`);

  let next = 0;
  let completed = 0;
  const total = tasks.length;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i]!;
      try {
        await ocrSinglePage(gemini, task);
        completed++;
        console.log(
          `[2/5]   (${completed}/${total}) [w${workerId}] done page ${task.idx + 1}`,
        );
      } catch (err) {
        console.error(
          `[2/5]   [w${workerId}] error on page ${task.idx + 1}: ${(err as Error).message}`,
        );
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: eff }, (_, i) => worker(i + 1)));
  return { htmlPaths, hintsPaths };
}
