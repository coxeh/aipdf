import { GoogleGenAI } from "@google/genai";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
/**
 * Built-in Gemini pricing as of late 2025.
 * Verify against https://ai.google.dev/pricing for your tier; override via `pricing`.
 */
export const DEFAULT_MODEL_PRICING = {
    "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10.0 },
    "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
    "gemini-2.5-flash-lite": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    "gemini-2.0-flash-lite": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    "gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    "gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5.0 },
};
function findPricing(table, model) {
    if (table[model])
        return table[model];
    let best = null;
    for (const [key, value] of Object.entries(table)) {
        if (model.startsWith(key) && (!best || key.length > best.key.length)) {
            best = { key, pricing: value };
        }
    }
    return best?.pricing ?? null;
}
function emptyStageSummary() {
    return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}
export function createGeminiClient(opts = {}) {
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY not set. Pass { apiKey } to createGeminiClient(), or set the GEMINI_API_KEY environment variable.");
    }
    const model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const pricingTable = {
        ...DEFAULT_MODEL_PRICING,
        ...(opts.pricing ?? {}),
    };
    const costsLogPath = opts.costsLogPath;
    const logCalls = opts.logCalls ?? true;
    const ai = new GoogleGenAI({ apiKey });
    const records = [];
    const unknownModels = new Set();
    let logDirEnsured = false;
    async function ensureLogDir() {
        if (logDirEnsured || !costsLogPath)
            return;
        await mkdir(dirname(costsLogPath), { recursive: true });
        logDirEnsured = true;
    }
    async function generate(stage, params) {
        const usedModel = typeof params.model === "string"
            ? params.model
            : model;
        const res = await ai.models.generateContent(params);
        const usage = res.usageMetadata;
        if (usage) {
            const inputTokens = usage.promptTokenCount ?? 0;
            const totalTokens = usage.totalTokenCount ?? inputTokens + (usage.candidatesTokenCount ?? 0);
            const outputTokens = Math.max(0, totalTokens - inputTokens);
            const cachedTokens = usage.cachedContentTokenCount ?? 0;
            const pricing = findPricing(pricingTable, usedModel);
            if (!pricing)
                unknownModels.add(usedModel);
            const costUsd = pricing
                ? (inputTokens / 1_000_000) * pricing.inputPerMillion +
                    (outputTokens / 1_000_000) * pricing.outputPerMillion
                : 0;
            const record = {
                ts: new Date().toISOString(),
                stage,
                model: usedModel,
                inputTokens,
                outputTokens,
                totalTokens,
                cachedTokens,
                costUsd,
                pricingKnown: !!pricing,
            };
            records.push(record);
            if (logCalls) {
                const dollars = pricing ? `$${costUsd.toFixed(5)}` : "$? (unknown pricing)";
                console.log(`  [cost:${stage}] ${inputTokens}+${outputTokens} tokens, ${dollars} (${usedModel})`);
            }
            if (costsLogPath) {
                await ensureLogDir();
                await appendFile(costsLogPath, JSON.stringify(record) + "\n");
            }
        }
        else if (logCalls) {
            console.log(`  [cost:${stage}] (no usageMetadata returned)`);
        }
        return res;
    }
    function summary() {
        const byStage = {};
        const byModel = {};
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCostUsd = 0;
        for (const r of records) {
            totalInputTokens += r.inputTokens;
            totalOutputTokens += r.outputTokens;
            totalCostUsd += r.costUsd;
            const stage = (byStage[r.stage] ??= emptyStageSummary());
            stage.calls += 1;
            stage.inputTokens += r.inputTokens;
            stage.outputTokens += r.outputTokens;
            stage.costUsd += r.costUsd;
            const mdl = (byModel[r.model] ??= emptyStageSummary());
            mdl.calls += 1;
            mdl.inputTokens += r.inputTokens;
            mdl.outputTokens += r.outputTokens;
            mdl.costUsd += r.costUsd;
        }
        return {
            totalCalls: records.length,
            totalInputTokens,
            totalOutputTokens,
            totalCostUsd,
            byStage,
            byModel,
            unknownPricingModels: [...unknownModels],
        };
    }
    return {
        ai,
        model,
        generate,
        getUsageLog: () => [...records],
        summary,
    };
}
const TRANSIENT_PATTERN = /rate.?limit|429|too many requests|503|502|504|ECONN|ENETUNREACH|ETIMEDOUT|UND_ERR|fetch failed|socket hang up|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/i;
function isTransientError(err) {
    const msg = err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err);
    return TRANSIENT_PATTERN.test(msg);
}
async function callWithBackoff(fn, stage, opts) {
    let lastErr;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (!isTransientError(err) || attempt >= opts.maxAttempts) {
                throw err;
            }
            const expo = opts.baseMs * 2 ** (attempt - 1);
            const jitter = Math.random() * (opts.baseMs / 2);
            const delay = Math.min(opts.maxMs, expo) + jitter;
            console.log(`  [${stage}] transient error (attempt ${attempt}/${opts.maxAttempts}): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}. Backing off ${Math.round(delay)}ms.`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
/**
 * Call gemini.generate(stage, ...) and JSON.parse the response. If parsing
 * (or validation) fails, retry up to `maxAttempts` times with a follow-up
 * message describing the failure so the model can self-correct.
 *
 * Common LLM JSON failure modes this addresses:
 *   - raw newlines/control chars inside string values (should be \\n)
 *   - unescaped quotes
 *   - truncated responses
 *   - markdown fences wrapping the JSON
 */
export async function generateJsonWithRetry(client, stage, params, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 3;
    const transientMaxAttempts = opts.transientMaxAttempts ?? 5;
    const transientBaseMs = opts.transientBaseMs ?? 1000;
    const transientMaxMs = opts.transientMaxMs ?? 30_000;
    let lastErr = null;
    let lastRaw = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const effectiveParams = attempt === 1
            ? params
            : addJsonFixupHint(params, lastErr.message, lastRaw);
        const callStage = attempt === 1 ? stage : `${stage}-jsonfix`;
        const res = await callWithBackoff(() => client.generate(callStage, effectiveParams), callStage, {
            maxAttempts: transientMaxAttempts,
            baseMs: transientBaseMs,
            maxMs: transientMaxMs,
        });
        const raw = stripFences(res.text ?? "");
        try {
            const parsed = JSON.parse(raw);
            if (opts.validate)
                opts.validate(parsed);
            if (attempt > 1) {
                console.log(`  [${stage}] recovered on attempt ${attempt}/${maxAttempts}`);
            }
            return parsed;
        }
        catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            lastRaw = raw;
            console.log(`  [${stage}] JSON parse attempt ${attempt}/${maxAttempts} failed: ${lastErr.message.slice(0, 200)}`);
        }
    }
    throw new Error(`[${stage}] failed to obtain valid JSON after ${maxAttempts} attempts: ${lastErr?.message}\nLast response (first 500 chars):\n${lastRaw.slice(0, 500)}`);
}
function addJsonFixupHint(params, errorMessage, rawSnippet) {
    const fixHint = {
        text: `\n\nYour previous response was NOT valid JSON. JSON.parse() failed with: "${errorMessage}".\n\nFirst 1000 chars of your previous response:\n${rawSnippet.slice(0, 1000)}\n\nReturn the SAME response again, but as STRICTLY VALID JSON. Pay attention to:\n- Every newline INSIDE a string value MUST be escaped as \\\\n (NOT a raw newline character).\n- Every double-quote INSIDE a string value MUST be escaped as \\\\\".\n- Every backslash inside a string MUST be escaped as \\\\\\\\.\n- Other control characters (tabs, carriage returns) must also be escaped (\\\\t, \\\\r).\n- The JSON must be complete (not truncated).\n- No markdown fences. No commentary. JSON only.`,
    };
    const clone = { ...params };
    const contents = clone.contents ?? [];
    if (Array.isArray(contents) && contents.length > 0) {
        const last = contents[contents.length - 1];
        const existingParts = Array.isArray(last.parts) ? last.parts : [];
        const newLast = { ...last, parts: [...existingParts, fixHint] };
        clone.contents = [...contents.slice(0, -1), newLast];
    }
    else {
        clone.contents = [{ role: "user", parts: [fixHint] }];
    }
    return clone;
}
export function stripFences(text) {
    const trimmed = text.trim();
    // If the WHOLE response is wrapped in a single fence, extract its content.
    // This handles the common LLM mistake of returning ```json\n{...}\n``` even
    // when responseMimeType is set; it does NOT mangle content that contains
    // legitimate inline backticks (e.g. template literals) because both an
    // opening and closing fence at the OUTER boundary are required.
    const wrapped = trimmed.match(/^```(?:html|json|javascript|js|typescript|ts|jsx|tsx)?\s*\n?([\s\S]*?)\n?```\s*$/i);
    if (wrapped)
        return wrapped[1].trim();
    return trimmed;
}
//# sourceMappingURL=gemini.js.map