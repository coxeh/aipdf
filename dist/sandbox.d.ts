export declare function scanForbiddenTokens(code: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function scanAst(code: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function findRegionsHost(html: string): Array<{
    id: string;
    kind: string;
    title: string;
    html: string;
}>;
export declare function parseTableHost(html: string): {
    headers: string[];
    rows: string[][];
};
export declare function parseDlHost(html: string): Record<string, string>;
export declare function parseListHost(html: string): string[];
export declare function stripTagsHost(html: string): string;
export type SandboxOptions = {
    /** Wall-clock timeout in ms. Default 30_000. */
    timeoutMs?: number;
    /** Memory limit in MB. Default 256. */
    memoryMb?: number;
    /** Hard cap on JSON output size in bytes. Default 100 MB. */
    outputMaxBytes?: number;
};
export type HelperImpl = (input: string) => unknown;
export declare function runScriptInSandbox(code: string, input: string, helpers: Record<string, HelperImpl>, opts?: SandboxOptions): Promise<unknown>;
export declare function runExtractorInSandbox(code: string, html: string, opts?: SandboxOptions): Promise<unknown>;
export declare function runTextPatternExtractorInSandbox(code: string, text: string, opts?: SandboxOptions): Promise<unknown>;
export declare function runExtractor(code: string, html: string, opts?: SandboxOptions): Promise<unknown>;
export declare function runTextPatternExtractor(code: string, text: string, opts?: SandboxOptions): Promise<unknown>;
