import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as cheerio from "cheerio";
import { getQuickJS } from "quickjs-emscripten";
import { parseAnchors, findRegionEnd } from "./anchors";
const FORBIDDEN_TOKEN_PATTERNS = [
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
export function scanForbiddenTokens(code) {
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
export function scanAst(code) {
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
    }
    catch (err) {
        return { ok: false, reason: `parse error: ${err.message}` };
    }
    let issue = null;
    const flag = (s) => {
        if (!issue)
            issue = s;
    };
    walk.simple(ast, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Identifier(node) {
            if (FORBIDDEN_IDS.has(node.name))
                flag(`forbidden identifier "${node.name}"`);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        MemberExpression(node) {
            const direct = !node.computed && node.property.type === "Identifier" ? node.property.name : null;
            const computed = node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
                ? node.property.value
                : null;
            const name = direct ?? computed;
            if (!name)
                return;
            if (name === "constructor" || name === "__proto__") {
                flag(`forbidden prototype access ${node.computed ? `[${JSON.stringify(name)}]` : `.${name}`}`);
            }
            else if (FORBIDDEN_IDS.has(name)) {
                flag(`forbidden member access .${name}`);
            }
        },
        ImportDeclaration() {
            flag("import declarations not allowed");
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ImportExpression(_node) {
            flag("dynamic import() not allowed");
        },
        WithStatement() {
            flag("with statements not allowed");
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        NewExpression(node) {
            if (node.callee.type === "Identifier" &&
                ["Function", "AsyncFunction", "GeneratorFunction"].includes(node.callee.name)) {
                flag(`new ${node.callee.name}() not allowed`);
            }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        CallExpression(node) {
            if (node.callee.type === "Identifier" && node.callee.name === "eval") {
                flag("direct eval() not allowed");
            }
        },
    });
    if (issue)
        return { ok: false, reason: issue };
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Host helpers (called from inside the sandbox via callbacks)
// ---------------------------------------------------------------------------
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tidy(s) {
    return s.trim().replace(/\s+/g, " ");
}
export function findRegionsHost(html) {
    const { starts, ends } = parseAnchors(html);
    const out = [];
    for (let i = 0; i < starts.length; i++) {
        const s = starts[i];
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
function firstRowLooksLikeData(first, rest) {
    if (rest.length < 2)
        return false;
    for (let col = 0; col < first.length; col++) {
        const v = first[col];
        if (!v)
            continue;
        let matches = 0;
        for (const row of rest) {
            if (row[col] === v)
                matches++;
        }
        if (matches >= 2)
            return true;
    }
    return false;
}
export function parseTableHost(html) {
    const $ = cheerio.load(`<root>${html}</root>`);
    const $table = $("table").first();
    if (!$table.length)
        return { headers: [], rows: [] };
    let headers = [];
    let headerRowSeen = false;
    const dataRows = [];
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
        if (ths.length > 0)
            return; // skip secondary header rows
        const cells = [];
        $tr.find("td").each((_, td) => {
            cells.push(tidy($(td).text()));
        });
        if (cells.length > 0)
            dataRows.push(cells);
    });
    // No <th> at all - decide whether to promote the first <td> row to headers,
    // or report headerless (so consolidation knows this is a continuation).
    if (!headerRowSeen && dataRows.length > 0) {
        const first = dataRows[0];
        if (firstRowLooksLikeData(first, dataRows.slice(1))) {
            // Keep all rows as data; let downstream use positional placeholders.
            return { headers: [], rows: dataRows };
        }
        headers = dataRows.shift();
    }
    return { headers, rows: dataRows };
}
const DL_BLOCK_BOUNDARY = new Set([
    "p", "div", "br", "tr", "li", "dt", "dl", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "ul", "ol", "section", "article", "header", "footer",
]);
export function parseDlHost(html) {
    const $ = cheerio.load(`<root>${html}</root>`);
    const out = {};
    // Pass 1: classic <dl><dt><dd> pairs.
    $("dl dt").each((_i, dt) => {
        const key = tidy($(dt).text()).replace(/:$/, "").trim();
        const $dd = $(dt).nextAll("dd").first();
        if (key && $dd.length) {
            const value = tidy($dd.text());
            if (value && !(key in out))
                out[key] = value;
        }
    });
    // Pass 2: <strong>Key:</strong> value, <b>Key:</b> value, <dt>Key:</dt> value.
    // Walk all label-shaped elements; capture text from their DOM-next siblings
    // up to the next block boundary or another label.
    $("strong, b, dt").each((_i, el) => {
        const $el = $(el);
        const raw = tidy($el.text());
        if (!raw.endsWith(":"))
            return;
        const key = raw.slice(0, -1).trim();
        if (!key || key in out)
            return;
        let value = "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cur = el.next;
        while (cur) {
            if (cur.type === "text") {
                value += cur.data ?? "";
            }
            else if (cur.type === "tag") {
                const tagName = cur.name;
                if (DL_BLOCK_BOUNDARY.has(tagName))
                    break;
                if (tagName === "strong" || tagName === "b") {
                    const inner = $(cur).text().trim();
                    if (inner.endsWith(":"))
                        break; // next label
                }
                value += $(cur).text();
            }
            cur = cur.next;
        }
        value = tidy(value);
        if (value)
            out[key] = value;
    });
    return out;
}
export function parseListHost(html) {
    const $ = cheerio.load(`<root>${html}</root>`);
    const out = [];
    $("li").each((_, li) => {
        out.push(tidy($(li).text()));
    });
    return out;
}
export function stripTagsHost(html) {
    const $ = cheerio.load(`<root>${html}</root>`);
    return tidy($.root().text());
}
let cachedQuickJS = null;
async function quickjs() {
    if (cachedQuickJS)
        return cachedQuickJS;
    cachedQuickJS = await getQuickJS();
    return cachedQuickJS;
}
export async function runScriptInSandbox(code, input, helpers, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const memoryMb = opts.memoryMb ?? 256;
    const outputMaxBytes = opts.outputMaxBytes ?? 100 * 1024 * 1024;
    const QuickJS = await quickjs();
    const vm = QuickJS.newContext();
    try {
        vm.runtime.setMemoryLimit(memoryMb * 1024 * 1024);
        const start = Date.now();
        vm.runtime.setInterruptHandler(() => Date.now() - start > timeoutMs);
        function exposeFn(globalName, fn) {
            const handle = vm.newFunction(globalName, (argHandle) => {
                const arg = vm.getString(argHandle);
                let payload;
                try {
                    const result = fn(arg);
                    payload = JSON.stringify(result);
                }
                catch (err) {
                    payload = `__HOST_ERROR__:${err.message}`;
                }
                return vm.newString(payload);
            });
            vm.setProp(vm.global, globalName, handle);
            handle.dispose();
        }
        const helperNames = Object.keys(helpers);
        for (const name of helperNames) {
            exposeFn(`__${name}`, helpers[name]);
        }
        const inputHandle = vm.newString(input);
        vm.setProp(vm.global, "__input", inputHandle);
        inputHandle.dispose();
        const stripped = code.replace(/^\s*export\s+(?:default\s+)?/gm, "");
        const helperLines = helperNames
            .map((n) => `  ${n}: (h) => {
    const r = __${n}(h);
    if (typeof r === "string" && r.indexOf("__HOST_ERROR__:") === 0) throw new Error("${n}: " + r.slice(15));
    return JSON.parse(r);
  },`)
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
            const msg = typeof errVal === "object" && errVal && "message" in errVal
                ? String(errVal.message)
                : String(errVal);
            throw new Error(`sandbox eval error: ${msg}`);
        }
        const resultJson = vm.getString(evalRes.value);
        evalRes.value.dispose();
        if (resultJson.length > outputMaxBytes) {
            throw new Error(`sandbox output exceeds size cap (${resultJson.length} > ${outputMaxBytes} bytes)`);
        }
        return JSON.parse(resultJson);
    }
    finally {
        vm.dispose();
    }
}
export async function runExtractorInSandbox(code, html, opts = {}) {
    return runScriptInSandbox(code, html, {
        findRegions: findRegionsHost,
        parseTable: parseTableHost,
        parseDl: parseDlHost,
        parseList: parseListHost,
        stripTags: stripTagsHost,
    }, opts);
}
export async function runTextPatternExtractorInSandbox(code, text, opts = {}) {
    return runScriptInSandbox(code, text, {}, opts);
}
// ---------------------------------------------------------------------------
// Combined entry points: scan + run
// ---------------------------------------------------------------------------
function runStaticScans(code) {
    const tokenCheck = scanForbiddenTokens(code);
    if (!tokenCheck.ok) {
        throw new Error(`static analysis (token scan) rejected the script: ${tokenCheck.reason}`);
    }
    const astCheck = scanAst(code);
    if (!astCheck.ok) {
        throw new Error(`static analysis (AST scan) rejected the script: ${astCheck.reason}`);
    }
}
export async function runExtractor(code, html, opts = {}) {
    runStaticScans(code);
    return runExtractorInSandbox(code, html, opts);
}
export async function runTextPatternExtractor(code, text, opts = {}) {
    runStaticScans(code);
    return runTextPatternExtractorInSandbox(code, text, opts);
}
//# sourceMappingURL=sandbox.js.map