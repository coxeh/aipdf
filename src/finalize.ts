import { writeFile } from "node:fs/promises";
import type { StructuredOutput } from "./extractData";
import type { Recommendation } from "./recommend";
import type { AddressAnalysis, AddressRecommendation } from "./detectAddresses";

export type FinalOutput = {
  groupName: string;
  title: string;
  recordCount: number;
  schema: Record<string, string>;
  address: {
    hasAddress: boolean;
    columns: string[];
    joinTemplate: string | null;
    confidence: AddressRecommendation["confidence"];
    fieldName: string | null;
  };
  recommendation: {
    summary: string;
    reasons: string[];
    keyMetrics: Array<{ label: string; value: string }>;
  };
  records: Array<Record<string, unknown>>;
};

function applyAddressTemplate(
  rec: Record<string, unknown>,
  template: string,
): string {
  return template
    .replace(/\{([^}]+)\}/g, (_, name) => {
      const v = rec[name];
      return v != null && v !== "" ? String(v).trim() : "";
    })
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^\s*[,\s]+|[,\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function buildFinalOutput(
  merged: StructuredOutput,
  recommendation: Recommendation,
  addresses: AddressAnalysis | null,
  outPath: string,
): Promise<FinalOutput | null> {
  const groupName = recommendation.prominent?.groupName;
  if (!groupName) return null;

  const group = merged.groups.find((g) => g.name === groupName);
  if (!group) return null;

  const addrRec =
    addresses?.addressRecommendations.find((r) => r.groupName === groupName) ?? null;
  const hasUsableAddress =
    !!(addrRec && addrRec.hasAddress && addrRec.joinTemplate && addrRec.columns.length > 0);

  // Avoid clobbering an existing "address" field if the source table already has one.
  const addressFieldName = hasUsableAddress
    ? "address" in group.schema
      ? "fullAddress"
      : "address"
    : null;

  const records = group.records.map((rec) => {
    if (!hasUsableAddress || !addrRec?.joinTemplate || !addressFieldName) {
      return { ...rec };
    }
    return {
      ...rec,
      [addressFieldName]: applyAddressTemplate(rec, addrRec.joinTemplate),
    };
  });

  const schema: Record<string, string> = { ...group.schema };
  if (addressFieldName && !(addressFieldName in schema)) schema[addressFieldName] = "string";

  const final: FinalOutput = {
    groupName: group.name,
    title: group.title,
    recordCount: records.length,
    schema,
    address: {
      hasAddress: !!addrRec?.hasAddress,
      columns: addrRec?.columns ?? [],
      joinTemplate: addrRec?.joinTemplate ?? null,
      confidence: addrRec?.confidence ?? "none",
      fieldName: addressFieldName,
    },
    recommendation: {
      summary: recommendation.prominent.summary,
      reasons: recommendation.prominent.reasons,
      keyMetrics: recommendation.prominent.keyMetrics,
    },
    records,
  };
  await writeFile(outPath, JSON.stringify(final, null, 2));
  return final;
}
