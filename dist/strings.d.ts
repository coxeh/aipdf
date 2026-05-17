/**
 * Convert an arbitrary label (header text, field name) to camelCase.
 *
 *   "Supplier Name"        -> "supplierName"
 *   "ISO Country Code"     -> "isoCountryCode"
 *   "first-name"           -> "firstName"
 *   "FULL_NAME"            -> "fullName"
 *
 * Stripping non-alphanumeric chars at the end intentionally drops separators,
 * trailing punctuation, and stray symbols.
 */
export declare function camelCase(s: string): string;
/**
 * Returns true if `code` defines a top-level identifier named `extract` in any
 * common form, after stripping leading `export` / `export default` keywords.
 *
 * Accepts:
 *   export function extract(...) {}
 *   export default function extract(...) {}
 *   export const extract = (...) => ...
 *   export const extract = function (...) {...}
 *   export let extract = ...
 *   function extract(...) {}        (export was stripped by the sandbox runner)
 *
 * The sandbox runner strips `export` keywords before evaluation; this check
 * only validates that some form of `extract` declaration is present so we can
 * fail fast (and re-prompt) rather than incurring a sandbox round-trip.
 */
export declare function hasExtractFunction(code: string): boolean;
