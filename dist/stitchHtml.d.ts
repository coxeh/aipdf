import { type GeminiClient } from "./gemini";
export type StitchHtmlOptions = {
    gemini: GeminiClient;
    force?: boolean;
    /** Chars of previous-tail to send with each page. Default 3000. */
    tailChars?: number;
    /** Max number of header/footer boilerplate examples to remember. Default 12. */
    boilerplateMax?: number;
};
export declare function stitchHtml(htmlPaths: string[], outPath: string, statePath: string, opts: StitchHtmlOptions): Promise<string>;
