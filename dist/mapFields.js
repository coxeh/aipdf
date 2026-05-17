import { writeFile, readFile, stat } from "node:fs/promises";
import { camelCase } from "./strings";
const PROMPT = `You are given:
1. A list of PREFERRED FIELDS the user wants to extract (the target schema). Each has a canonical name and optional description / aliases / type.
2. A list of EXTRACTED GROUPS, each with a name, title, schema (raw field names from the document) and a few sample records.

For each group, propose a mapping from its raw field names to preferred field names where there is a confident semantic match.

Return JSON of EXACTLY this shape (no prose, no markdown):
{
  "mappings": [
    {
      "groupName": "<exact group name from input>",
      "fieldMap": { "<rawFieldName>": "<preferredFieldName or original camelCased>" },
      "matchedPreferredFields": [ "<list of preferred names that were mapped to in this group>" ],
      "unmappedPreferredFields": [ "<preferred names with no match in this group>" ],
      "notes": "<optional one-line reasoning>"
    }
  ]
}

Rules:
- Map only when semantically confident. "Supplier" -> "supplierName" is fine. "Country" -> "supplierName" is NOT.
- Use evidence from the sample records, not just the field name. If the sample values look like SKUs/codes, the field is probably "sku" regardless of the raw label.
- Each preferred field can be matched at most once per group. If two raw fields both look like the same preferred field, pick the better one and keep the other under its original name (camelCased).
- For raw fields that don't match any preferred field, the mapping target IS the original name, but camelCased (e.g. "Supplier Name" -> "supplierName" even if "supplierName" isn't preferred; "ISO Country Code" -> "isoCountryCode").
- Do NOT invent fields. Only emit mappings for fields that actually exist in the group's schema.
- Include EVERY raw field from the schema in fieldMap. Every field gets either a preferred name or its camelCased original.
- Output VALID JSON only.`;
function applyMappings(structured, mapping) {
    const byName = new Map(mapping.mappings.map((m) => [m.groupName, m]));
    return {
        groups: structured.groups.map((g) => {
            const m = byName.get(g.name);
            if (!m)
                return g;
            const renameMap = {};
            const usedTargets = new Set();
            // Build the renameMap using LLM proposals, with collision suffixing.
            for (const [src, dst] of Object.entries(m.fieldMap)) {
                if (!(src in g.schema))
                    continue;
                let finalDst = dst;
                if (usedTargets.has(finalDst)) {
                    let i = 2;
                    while (usedTargets.has(`${dst}${i}`))
                        i++;
                    finalDst = `${dst}${i}`;
                }
                usedTargets.add(finalDst);
                renameMap[src] = finalDst;
            }
            // Fields the LLM forgot — fall back to camelCased original.
            for (const src of Object.keys(g.schema)) {
                if (renameMap[src])
                    continue;
                let dst = camelCase(src) || src;
                if (usedTargets.has(dst)) {
                    let i = 2;
                    while (usedTargets.has(`${dst}${i}`))
                        i++;
                    dst = `${dst}${i}`;
                }
                usedTargets.add(dst);
                renameMap[src] = dst;
            }
            const newSchema = {};
            for (const [src, dst] of Object.entries(renameMap)) {
                newSchema[dst] = g.schema[src] ?? "string";
            }
            const records = g.records.map((rec) => {
                const out = {};
                for (const [k, v] of Object.entries(rec)) {
                    const mapped = renameMap[k] ?? (camelCase(k) || k);
                    out[mapped] = v;
                }
                return out;
            });
            return { ...g, schema: newSchema, records };
        }),
    };
}
export async function mapFields(structured, mappingPath, harmonisedPath, opts) {
    const { gemini, force = false, preferredFields } = opts;
    if (preferredFields.length === 0) {
        const empty = { mappings: [] };
        await writeFile(mappingPath, JSON.stringify(empty, null, 2));
        await writeFile(harmonisedPath, JSON.stringify(structured, null, 2));
        return { mapping: empty, harmonised: structured };
    }
    if (!force) {
        try {
            const a = await stat(mappingPath);
            const b = await stat(harmonisedPath);
            if (a.size > 0 && b.size > 0) {
                console.log(`[4c/5] Using cached field mapping at ${mappingPath}`);
                return {
                    mapping: JSON.parse(await readFile(mappingPath, "utf8")),
                    harmonised: JSON.parse(await readFile(harmonisedPath, "utf8")),
                };
            }
        }
        catch { }
    }
    if (structured.groups.length === 0) {
        console.log(`[4c/5] No groups to map.`);
        const empty = { mappings: [] };
        await writeFile(mappingPath, JSON.stringify(empty, null, 2));
        await writeFile(harmonisedPath, JSON.stringify(structured, null, 2));
        return { mapping: empty, harmonised: structured };
    }
    console.log(`[4c/5] Mapping ${structured.groups.length} group(s) onto ${preferredFields.length} preferred field(s)...`);
    const summary = {
        preferredFields,
        groups: structured.groups.map((g) => ({
            name: g.name,
            title: g.title,
            schema: g.schema,
            sampleRecords: g.records.slice(0, 4),
        })),
    };
    const res = await gemini.generate("map-fields", {
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
    let mapping;
    try {
        mapping = JSON.parse(res.text ?? "{}");
    }
    catch (err) {
        throw new Error(`Failed to parse field-mapping JSON: ${err.message}`);
    }
    if (!Array.isArray(mapping.mappings))
        mapping.mappings = [];
    const harmonised = applyMappings(structured, mapping);
    await writeFile(mappingPath, JSON.stringify(mapping, null, 2));
    await writeFile(harmonisedPath, JSON.stringify(harmonised, null, 2));
    const totalMatched = mapping.mappings.reduce((n, m) => n + m.matchedPreferredFields.length, 0);
    console.log(`[4c/5] Mapped ${totalMatched} preferred-field match(es) across ${mapping.mappings.length} group(s).`);
    return { mapping, harmonised };
}
/**
 * Parse a CLI-friendly `--fields` value (comma-separated names) into PreferredField[].
 */
export function parseFieldsFlag(value) {
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
}
/**
 * Load a JSON file describing preferred fields. Accepts either:
 *   ["productName", "sku", ...]                                 (array of strings)
 *   [{ "name": "...", "description": "...", "aliases": [...] }] (rich)
 */
export async function loadFieldsFile(path) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`${path}: expected a JSON array`);
    }
    return parsed.map((entry, i) => {
        if (typeof entry === "string")
            return { name: entry };
        if (entry && typeof entry === "object" && typeof entry.name === "string") {
            return entry;
        }
        throw new Error(`${path}[${i}]: expected string or { name, ... }`);
    });
}
//# sourceMappingURL=mapFields.js.map