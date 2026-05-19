import { type GeminiClient } from "./gemini";
export type StitchHtmlOptions = {
    gemini: GeminiClient;
    force?: boolean;
    /** Chars of previous-tail to send with each page. Default 3000. */
    tailChars?: number;
    /** Max number of header/footer boilerplate examples to remember. Default 12. */
    boilerplateMax?: number;
    /**
     * Model to use for stitching. Defaults to gemini-2.5-flash-lite (cheapest).
     * Per-page model overrides the GeminiClient's default model for this stage only.
     */
    model?: string;
    /**
     * Model to fall back to if the primary model fails after all retries.
     * Default gemini-2.5-flash. Set to null/"" to disable fallback.
     */
    fallbackModel?: string | null;
};
export declare function stitchHtml(htmlPaths: string[], outPath: string, statePath: string, opts: StitchHtmlOptions): Promise<string>;
