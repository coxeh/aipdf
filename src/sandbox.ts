import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as cheerio from "cheerio";
import { getQuickJS, type QuickJSWASMModule } from "quickjs-emscripten";
import { parseAnchors, findRegionEnd } from "./anchors";

// ---------------------------------------------------------------------------
// Layer 1: forbidden-token regex pass
// ---------------------------------------------------------------------------

type ForbiddenToken = { pattern: RegExp; name: string };

const FORBIDDEN_TOKEN_PATTERNS: ForbiddenToken[] = [
  { pattern: /\beval\s*\(/, name: "eval()" },
  { pattern: /\bnew\s+Function\b/, name: "new Function" },
  { pattern: /\bFunction\s*\(/, name: "Function()" },
  { pattern: /\bimport\s*\(/, name: "dynamic import()" },
  { pattern: /\brequire\s*\(/, name: "require()" },
  { pattern: /\bprocess\b/, name: "process" },
  { pattern: /\bglobalThis\b/, name: "globalThis" },
  { pattern: /\bfetch\s*\(/, name: "fetch()" },
  { pattern: /\bXMLHttpRequest\b/, name: "XMLHttpRequest" },
  { pattern: /\bchild_process\b/, name: "child_process" },
  { pattern: /\b__proto__\b/, name: "__proto__" },
  { pattern: /\.constructor\b/, name: ".constructor" },
];

export function scanForbiddenTokens(code: string): { ok: true } | { ok: false; reason: string } {
  for (const { pattern, name } of FORBIDDEN_TOKEN_PATTERNS) {
    const m = pattern.exec(code);
    if (m) {
      const idx = m.index ?? 0;
      const ctx = code.slice(Math.max(0, idx - 20), idx + m[0].length + 20);
      return {
        ok: false,
        reason: `forbidden token ${name} at offset ${idx}: ...${ctx.replace(/\s+/g, " ")}...`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Layer 2: AST scan via acorn
// ---------------------------------------------------------------------------

const FORBIDDEN_IDS = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "process",
  "globalThis",
  "global",
  "self",
  "window",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "fs",
  "child_process",
  "http",
  "https",
  "net",
  "tls",
  "dgram",
  "cluster",
  "Buffer",
  "setImmediate",
]);

export function scanAst(code: string): { ok: true } | { ok: false; reason: string } {
  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  let issue: string | null = null;
  const flag = (s: string) => {
    if (!issue) issue = s;
  };

  walk.simple(ast, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Identifier(node: any) {
      if (FORBIDDEN_IDS.has(node.name)) flag(`forbidden identifier "${node.name}"`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MemberExpression(node: any) {
      const direct =
        !node.computed && node.property.type === "Identifier" ? node.property.name : null;
      const computed =
        node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
          ? node.property.value
          : null;
      const name = direct ?? computed;
      if (!name) return;
      if (name === "constructor" || name === "__proto__") {
        flag(`forbidden prototype access ${node.computed ? `[${JSON.stringify(name)}]` : `.${name}`}`);
      } else if (FORBIDDEN_IDS.has(name)) {
        flag(`forbidden member access .${name}`);
      }
    },
    ImportDeclaration() {
      flag("import declarations not allowed");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ImportExpression(_node: any) {
      flag("dynamic import() not allowed");
    },
    WithStatement() {
      flag("with statements not allowed");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    NewExpression(node: any) {
      if (
        node.callee.type === "Identifier" &&
        ["Function", "AsyncFunction", "GeneratorFunction"].includes(node.callee.name)
      ) {
        flag(`new ${node.callee.name}() not allowed`);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CallExpression(node: any) {
      if (node.callee.type === "Identifier" && node.callee.name === "eval") {
        flag("direct eval() not allowed");
      }
    },
  });

  if (issue) return { ok: false, reason: issue };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Host helpers (called from inside the sandbox via callbacks)
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tidy(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function findRegionsHost(html: string): Array<{
  id: string;
  kind: string;
  title: string;
  html: string;
}> {
  const { starts, ends } = parseAnchors(html);
  const out: Array<{ id: string; kind: string; title: string; html: string }> = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const next = starts[i + 1];
    const ceiling = next ? next.idx : html.length;
    const end = findRegionEnd(s, ceiling, ends);
    const endIdx = end ? end.idx : ceiling;
    out.push({
      id: s.id,
      kind: s.kind,
      title: s.title,
      html: html.slice(s.idx + s.len, endIdx),
    });
  }
  return out;
}

/**
 * Returns true when `first` looks like a data row mistaken for a header row.
 * Signal: at least one cell value of `first` reappears in the same column
 * position in 2+ of the subsequent rows. Real header labels are typically
 * unique within their column; data values like country codes or "sourcing
 * district" repeat row-after-row.
 *
 * Requires at least 2 subsequent rows to fire (otherwise we can't tell).
 */
function firstRowLooksLikeData(first: string[], rest: string[][]): boolean {
  if (rest.length < 2) return false;
  for (let col = 0; col < first.length; col++) {
    const v = first[col];
    if (!v) continue;
    let matches = 0;
    for (const row of rest) {
      if (row[col] === v) matches++;
    }
    if (matches >= 2) return true;
  }
  return false;
}

export function parseTableHost(html: string): { headers: string[]; rows: string[][] } {
  const $ = cheerio.load(`<root>${html}</root>`);
  const $table = $("table").first();
  if (!$table.length) return { headers: [], rows: [] };

  let headers: string[] = [];
  let headerRowSeen = false;
  const dataRows: string[][] = [];

  $table.find("tr").each((_, tr) => {
    const $tr = $(tr);
    const ths = $tr.find("th");
    if (ths.length > 0 && !headerRowSeen) {
      ths.each((_i, th) => {
        headers.push(tidy($(th).text()));
      });
      headerRowSeen = true;
      return;
    }
    if (ths.length > 0) return; // skip secondary header rows
    const cells: string[] = [];
    $tr.find("td").each((_, td) => {
      cells.push(tidy($(td).text()));
    });
    if (cells.length > 0) dataRows.push(cells);
  });

  // No <th> at all - decide whether to promote the first <td> row to headers,
  // or report headerless (so consolidation knows this is a continuation).
  if (!headerRowSeen && dataRows.length > 0) {
    const first = dataRows[0]!;
    if (firstRowLooksLikeData(first, dataRows.slice(1))) {
      // Keep all rows as data; let downstream use positional placeholders.
      return { headers: [], rows: dataRows };
    }
    headers = dataRows.shift()!;
  }

  return { headers, rows: dataRows };
}

const DL_BLOCK_BOUNDARY = new Set([
  "p", "div", "br", "tr", "li", "dt", "dl", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "ul", "ol", "section", "article", "header", "footer",
]);

export function parseDlHost(html: string): Record<string, string> {
  const $ = cheerio.load(`<root>${html}</root>`);
  const out: Record<string, string> = {};

  // Pass 1: classic <dl><dt><dd> pairs.
  $("dl dt").each((_i, dt) => {
    const key = tidy($(dt).text()).replace(/:$/, "").trim();
    const $dd = $(dt).nextAll("dd").first();
    if (key && $dd.length) {
      const value = tidy($dd.text());
      if (value && !(key in out)) out[key] = value;
    }
  });

  // Pass 2: <strong>Key:</strong> value, <b>Key:</b> value, <dt>Key:</dt> value.
  // Walk all label-shaped elements; capture text from their DOM-next siblings
  // up to the next block boundary or another label.
  $("strong, b, dt").each((_i, el) => {
    const $el = $(el);
    const raw = tidy($el.text());
    if (!raw.endsWith(":")) return;
    const key = raw.slice(0, -1).trim();
    if (!key || key in out) return;

    let value = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = (el as unknown as { next?: unknown }).next;
    while (cur) {
      if (cur.type === "text") {
        value += cur.data ?? "";
      } else if (cur.type === "tag") {
        const tagName: string = cur.name;
        if (DL_BLOCK_BOUNDARY.has(tagName)) break;
        if (tagName === "strong" || tagName === "b") {
          const inner = $(cur).text().trim();
          if (inner.endsWith(":")) break; // next label
        }
        value += $(cur).text();
      }
      cur = cur.next;
    }
    value = tidy(value);
    if (value) out[key] = value;
  });

  return out;
}

export function parseListHost(html: string): string[] {
  const $ = cheerio.load(`<root>${html}</root>`);
  const out: string[] = [];
  $("li").each((_, li) => {
    out.push(tidy($(li).text()));
  });
  return out;
}

export function stripTagsHost(html: string): string {
  const $ = cheerio.load(`<root>${html}</root>`);
  return tidy($.root().text());
}

// ---------------------------------------------------------------------------
// Layer 3: quickjs-emscripten WASM sandbox
// ---------------------------------------------------------------------------

export type SandboxOptions = {
  /** Wall-clock timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Memory limit in MB. Default 256. */
  memoryMb?: number;
  /** Hard cap on JSON output size in bytes. Default 100 MB. */
  outputMaxBytes?: number;
};

let cachedQuickJS: QuickJSWASMModule | null = null;
async function quickjs(): Promise<QuickJSWASMModule> {
  if (cachedQuickJS) return cachedQuickJS;
  cachedQuickJS = await getQuickJS();
  return cachedQuickJS;
}

export type HelperImpl = (input: string) => unknown;

export async function runScriptInSandbox(
  code: string,
  input: string,
  helpers: Record<string, HelperImpl>,
  opts: SandboxOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const memoryMb = opts.memoryMb ?? 256;
  const outputMaxBytes = opts.outputMaxBytes ?? 100 * 1024 * 1024;

  const QuickJS = await quickjs();
  const vm = QuickJS.newContext();

  try {
    vm.runtime.setMemoryLimit(memoryMb * 1024 * 1024);
    const start = Date.now();
    vm.runtime.setInterruptHandler(() => Date.now() - start > timeoutMs);

    function exposeFn(globalName: string, fn: HelperImpl) {
      const handle = vm.newFunction(globalName, (argHandle) => {
        const arg = vm.getString(argHandle);
        let payload: string;
        try {
          const result = fn(arg);
          payload = JSON.stringify(result);
        } catch (err) {
          payload = `__HOST_ERROR__:${(err as Error).message}`;
        }
        return vm.newString(payload);
      });
      vm.setProp(vm.global, globalName, handle);
      handle.dispose();
    }

    const helperNames = Object.keys(helpers);
    for (const name of helperNames) {
      exposeFn(`__${name}`, helpers[name]!);
    }

    const inputHandle = vm.newString(input);
    vm.setProp(vm.global, "__input", inputHandle);
    inputHandle.dispose();

    const stripped = code.replace(/^\s*export\s+(?:default\s+)?/gm, "");

    const helperLines = helperNames
      .map(
        (n) => `  ${n}: (h) => {
    const r = __${n}(h);
    if (typeof r === "string" && r.indexOf("__HOST_ERROR__:") === 0) throw new Error("${n}: " + r.slice(15));
    return JSON.parse(r);
  },`,
      )
      .join("\n");

    const wrapper = `
"use strict";
${stripped}
const __helpers = {
${helperLines}
};
JSON.stringify(extract(__input, __helpers));
`;

    const evalRes = vm.evalCode(wrapper);
    if (evalRes.error) {
      const errVal = vm.dump(evalRes.error);
      evalRes.error.dispose();
      const msg =
        typeof errVal === "object" && errVal && "message" in errVal
          ? String((errVal as { message: unknown }).message)
          : String(errVal);
      throw new Error(`sandbox eval error: ${msg}`);
    }

    const resultJson = vm.getString(evalRes.value);
    evalRes.value.dispose();

    if (resultJson.length > outputMaxBytes) {
      throw new Error(
        `sandbox output exceeds size cap (${resultJson.length} > ${outputMaxBytes} bytes)`,
      );
    }
    return JSON.parse(resultJson);
  } finally {
    vm.dispose();
  }
}

export async function runExtractorInSandbox(
  code: string,
  html: string,
  opts: SandboxOptions = {},
): Promise<unknown> {
  return runScriptInSandbox(
    code,
    html,
    {
      findRegions: findRegionsHost,
      parseTable: parseTableHost,
      parseDl: parseDlHost,
      parseList: parseListHost,
      stripTags: stripTagsHost,
    },
    opts,
  );
}

export async function runTextPatternExtractorInSandbox(
  code: string,
  text: string,
  opts: SandboxOptions = {},
): Promise<unknown> {
  return runScriptInSandbox(code, text, {}, opts);
}

// ---------------------------------------------------------------------------
// Combined entry points: scan + run
// ---------------------------------------------------------------------------

function runStaticScans(code: string): void {
  const tokenCheck = scanForbiddenTokens(code);
  if (!tokenCheck.ok) {
    throw new Error(`static analysis (token scan) rejected the script: ${tokenCheck.reason}`);
  }
  const astCheck = scanAst(code);
  if (!astCheck.ok) {
    throw new Error(`static analysis (AST scan) rejected the script: ${astCheck.reason}`);
  }
}

export async function runExtractor(
  code: string,
  html: string,
  opts: SandboxOptions = {},
): Promise<unknown> {
  runStaticScans(code);
  return runExtractorInSandbox(code, html, opts);
}

export async function runTextPatternExtractor(
  code: string,
  text: string,
  opts: SandboxOptions = {},
): Promise<unknown> {
  runStaticScans(code);
  return runTextPatternExtractorInSandbox(code, text, opts);
}
