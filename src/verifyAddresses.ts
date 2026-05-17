import { writeFile, readFile, stat } from "node:fs/promises";
import { generateJsonWithRetry, type GeminiClient } from "./gemini";
import type { FinalOutput } from "./finalize";

export type RecordVerification = {
  confidence: "high" | "medium" | "low" | "unknown";
  matchedName: string | null;
  matchedAddress: string | null;
  evidence: string;
  sources: string[];
};

export type VerifyCosts = {
  inputTokens: number;
  outputTokens: number;
  tokensCostUsd: number;
  groundedCalls: number;
  groundingPricePerCall: number;
  groundingCostUsd: number;
  totalCostUsd: number;
};

export type VerifyAddressesResult = {
  meta: {
    model: string;
    batchSize: number;
    grounded: boolean;
    verifiedAt: string;
    summary: { high: number; medium: number; low: number; unknown: number };
    costs: VerifyCosts;
  };
  records: Array<Record<string, unknown> & { verification: RecordVerification }>;
};

export type VerifyAddressesOptions = {
  gemini: GeminiClient;
  force?: boolean;
  /** Records per LLM call. Default 5. */
  batchSize?: number;
  /** Concurrent in-flight batch requests. Default 4. */
  concurrency?: number;
  /** Use Google Search grounding via Gemini's googleSearch tool. Default true. */
  useGrounding?: boolean;
  /** Override which field on each record is treated as the entity name. */
  nameField?: string;
  /**
   * USD per grounded request (Google Search tool surcharge). Default 0.035.
   * Verify against current Gemini grounding pricing for your tier.
   */
  pricePerGroundingCall?: number;
  /** Document title (helps the model interpret what these records describe). */
  documentTitle?: string;
  /** Short summary describing what the document / dataset is about. */
  documentSummary?: string;
};

const NAME_FIELD_CANDIDATES = [
  "name", "fullName", "title", "company", "companyName",
  "organisation", "organization", "supplier", "supplierName",
  "producer", "producerName", "farmerGroup", "group", "groupName",
] as const;

function pickNameField(schema: Record<string, string>, override?: string): string | null {
  if (override && override in schema) return override;
  for (const f of NAME_FIELD_CANDIDATES) if (f in schema) return f;
  return null;
}

function buildPrompt(
  nameField: string | null,
  addressField: string,
  documentTitle: string | undefined,
  documentSummary: string | undefined,
): string {
  const contextLines: string[] = [];
  if (documentTitle) contextLines.push(`- Title: ${documentTitle}`);
  if (documentSummary) contextLines.push(`- Summary: ${documentSummary}`);
  const context = contextLines.length
    ? `\nDocument context (use this to disambiguate when search returns multiple candidates — prefer matches consistent with the document's subject and time period):\n${contextLines.join("\n")}\n`
    : "";

  return `You are given a batch of records, each describing an entity (organisation, supplier, farmer group, etc.) plus a candidate address.${context}

For EACH record, USE WEB SEARCH (grounding) to verify:
  1. Whether the entity exists and the name in the record matches what public sources call it.
  2. Whether the candidate address is plausibly the entity's actual address.
  3. The best canonical match: corrected name + full address from authoritative sources.

Return JSON of EXACTLY this shape (no prose, no markdown):
{
  "verifications": [
    {
      "index": <integer - the record's "index" field, verbatim>,
      "confidence": "high" | "medium" | "low" | "unknown",
      "matchedName": "<canonical entity name from public sources, or null>",
      "matchedAddress": "<canonical full address from public sources, or null>",
      "evidence": "<1-2 sentence summary of what your search results showed>",
      "sources": ["<url>", "<url>"]
    }
  ]
}

Confidence rules:
- "high": multiple agreeing public sources name this entity at this address.
- "medium": one decent source confirms the name AND address are consistent.
- "low": you found something related but the name OR address doesn't quite match.
- "unknown": no useful public information found.

Rules:
- ONE entry per input record. The "index" must exactly match the record's index field.
- matchedAddress should be a complete address string (street/locality/region/country as available); null if not found.
- sources: 1-3 most authoritative URLs you actually used.
- Output VALID JSON only.

Input records (${nameField ? `name field: "${nameField}", ` : ""}address field: "${addressField}"):`;
}

export async function verifyAddressesAndNames(
  final: FinalOutput,
  outPath: string,
  opts: VerifyAddressesOptions,
): Promise<VerifyAddressesResult> {
  const {
    gemini,
    force = false,
    batchSize = 5,
    useGrounding = true,
    concurrency = 4,
  } = opts;

  if (!force) {
    try {
      const s = await stat(outPath);
      if (s.size > 0) {
        console.log(`[verify] Using cached verification at ${outPath}`);
        return JSON.parse(await readFile(outPath, "utf8")) as VerifyAddressesResult;
      }
    } catch {}
  }

  const total = final.records.length;
  const addressField = final.address.fieldName ?? "address";
  const nameField = pickNameField(final.schema, opts.nameField);
  const grounded = useGrounding;

  if (total === 0) {
    const empty: VerifyAddressesResult = {
      meta: {
        model: gemini.model,
        batchSize,
        grounded,
        verifiedAt: new Date().toISOString(),
        summary: { high: 0, medium: 0, low: 0, unknown: 0 },
        costs: {
          inputTokens: 0,
          outputTokens: 0,
          tokensCostUsd: 0,
          groundedCalls: 0,
          groundingPricePerCall: opts.pricePerGroundingCall ?? 0.035,
          groundingCostUsd: 0,
          totalCostUsd: 0,
        },
      },
      records: [],
    };
    await writeFile(outPath, JSON.stringify(empty, null, 2));
    return empty;
  }

  const numBatches = Math.ceil(total / batchSize);
  const effConcurrency = Math.max(1, Math.min(concurrency, numBatches));
  console.log(
    `[verify] Verifying ${total} record(s) in ${numBatches} batch(es) of ${batchSize}, concurrency=${effConcurrency}${grounded ? ", Google Search grounding ON" : ""}.`,
  );
  console.log(
    `[verify]   name field: ${nameField ?? "(none — using all sample fields)"}; address field: ${addressField}`,
  );
  if (opts.documentTitle || opts.documentSummary) {
    console.log(`[verify]   context: title=${opts.documentTitle ? "yes" : "no"}, summary=${opts.documentSummary ? "yes" : "no"}`);
  }

  const out: Array<Record<string, unknown> & { verification: RecordVerification }> =
    new Array(total);
  const summary = { high: 0, medium: 0, low: 0, unknown: 0 };
  const prompt = buildPrompt(nameField, addressField, opts.documentTitle, opts.documentSummary);
  const config = grounded
    ? { tools: [{ googleSearch: {} }] as unknown as Record<string, unknown>[] }
    : undefined;

  async function runBatch(batchIdx: number): Promise<void> {
    const start = batchIdx * batchSize;
    const batch = final.records.slice(start, start + batchSize);
    const batchNum = batchIdx + 1;
    console.log(`[verify]   batch ${batchNum}/${numBatches}: records ${start + 1}..${start + batch.length}`);

    const inputs = batch.map((r, j) => {
      const o: Record<string, unknown> = { index: start + j };
      if (nameField) o.name = r[nameField];
      o.address = r[addressField];
      for (const col of final.address.columns) o[col] = r[col];
      return o;
    });

    const parsed = await generateJsonWithRetry<{
      verifications: Array<Partial<RecordVerification> & { index: number }>;
    }>(
      gemini,
      `verify:b${batchNum}`,
      {
        model: gemini.model,
        ...(config ? { config } : {}),
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { text: "\n\n" + JSON.stringify(inputs, null, 2) },
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
            !Array.isArray((v as { verifications?: unknown }).verifications)
          ) {
            throw new Error('response missing "verifications" array');
          }
        },
      },
    );

    const byIdx = new Map<number, RecordVerification>();
    for (const v of parsed.verifications) {
      const c = String(v.confidence ?? "").toLowerCase();
      const confidence: RecordVerification["confidence"] =
        c === "high" || c === "medium" || c === "low" ? c : "unknown";
      byIdx.set(v.index, {
        confidence,
        matchedName: v.matchedName ?? null,
        matchedAddress: v.matchedAddress ?? null,
        evidence: typeof v.evidence === "string" ? v.evidence : "",
        sources: Array.isArray(v.sources) ? v.sources.filter((s) => typeof s === "string") : [],
      });
    }

    for (let j = 0; j < batch.length; j++) {
      const idx = start + j;
      const verification =
        byIdx.get(idx) ?? {
          confidence: "unknown" as const,
          matchedName: null,
          matchedAddress: null,
          evidence: "No verification returned by the model.",
          sources: [],
        };
      summary[verification.confidence]++;
      out[idx] = { ...batch[j]!, verification };
    }
  }

  // Worker pool over batches.
  let nextBatch = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextBatch++;
      if (i >= numBatches) return;
      await runBatch(i);
    }
  }
  await Promise.all(Array.from({ length: effConcurrency }, () => worker()));

  // Compute cost summary for this run. Filter by "verify:" stage prefix so we
  // pick up both the initial calls and any -jsonfix retries.
  const allCosts = gemini.summary();
  const verifyStages = Object.entries(allCosts.byStage).filter(([k]) =>
    k.startsWith("verify:"),
  );
  const inputTokens = verifyStages.reduce((s, [, v]) => s + v.inputTokens, 0);
  const outputTokens = verifyStages.reduce((s, [, v]) => s + v.outputTokens, 0);
  const tokensCostUsd = verifyStages.reduce((s, [, v]) => s + v.costUsd, 0);
  const groundedCalls = grounded
    ? verifyStages.reduce((s, [, v]) => s + v.calls, 0)
    : 0;
  const groundingPricePerCall = opts.pricePerGroundingCall ?? 0.035;
  const groundingCostUsd = groundedCalls * groundingPricePerCall;
  const totalCostUsd = tokensCostUsd + groundingCostUsd;

  const result: VerifyAddressesResult = {
    meta: {
      model: gemini.model,
      batchSize,
      grounded,
      verifiedAt: new Date().toISOString(),
      summary,
      costs: {
        inputTokens,
        outputTokens,
        tokensCostUsd,
        groundedCalls,
        groundingPricePerCall,
        groundingCostUsd,
        totalCostUsd,
      },
    },
    records: out,
  };
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(
    `[verify] Done. high=${summary.high} medium=${summary.medium} low=${summary.low} unknown=${summary.unknown}`,
  );
  console.log(
    `[verify] Cost: tokens=$${tokensCostUsd.toFixed(4)} (${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out)` +
      (grounded ? ` + grounding=$${groundingCostUsd.toFixed(4)} (${groundedCalls} calls @ $${groundingPricePerCall})` : "") +
      ` = $${totalCostUsd.toFixed(4)}`,
  );
  return result;
}

/** Convenience: read a `final.json` and verify in one call. */
export async function verifyAddressesFromFile(
  finalJsonPath: string,
  outPath: string,
  opts: VerifyAddressesOptions,
): Promise<VerifyAddressesResult> {
  const final = JSON.parse(await readFile(finalJsonPath, "utf8")) as FinalOutput;
  // Auto-pull title + summary from the FinalOutput when the caller hasn't
  // explicitly overridden them.
  const enriched: VerifyAddressesOptions = {
    ...opts,
    documentTitle: opts.documentTitle ?? final.title,
    documentSummary: opts.documentSummary ?? final.recommendation?.summary,
  };
  return verifyAddressesAndNames(final, outPath, enriched);
}
