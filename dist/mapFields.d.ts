import type { GeminiClient } from "./gemini";
import type { StructuredOutput } from "./extractData";
export type PreferredField = {
    /** Canonical field name. camelCase preferred. */
    name: string;
    /** Optional semantic hint for the LLM. */
    description?: string;
    /** Optional synonyms / aliases that should map to this field. */
    aliases?: string[];
    /** Optional expected type. */
    type?: "string" | "number" | "boolean" | "date";
};
export type FieldMappingForGroup = {
    groupName: string;
    fieldMap: Record<string, string>;
    matchedPreferredFields: string[];
    unmappedPreferredFields: string[];
    notes?: string;
};
export type FieldMappingResult = {
    mappings: FieldMappingForGroup[];
};
export type MapFieldsOptions = {
    gemini: GeminiClient;
    force?: boolean;
    preferredFields: PreferredField[];
};
export type MapFieldsResult = {
    mapping: FieldMappingResult;
    harmonised: StructuredOutput;
};
export declare function mapFields(structured: StructuredOutput, mappingPath: string, harmonisedPath: string, opts: MapFieldsOptions): Promise<MapFieldsResult>;
/**
 * Parse a CLI-friendly `--fields` value (comma-separated names) into PreferredField[].
 */
export declare function parseFieldsFlag(value: string): PreferredField[];
/**
 * Load a JSON file describing preferred fields. Accepts either:
 *   ["productName", "sku", ...]                                 (array of strings)
 *   [{ "name": "...", "description": "...", "aliases": [...] }] (rich)
 */
export declare function loadFieldsFile(path: string): Promise<PreferredField[]>;
