import { type GeminiClient } from "./gemini";
export type OcrPagesOptions = {
    gemini: GeminiClient;
    force?: boolean;
    hintsDir?: string;
    /** Max concurrent Gemini calls. Default 4. */
    concurrency?: number;
};
export type OcrPagesResult = {
    htmlPaths: string[];
    hintsPaths: string[];
};
export declare function ocrPages(imagePaths: string[], outDir: string, opts: OcrPagesOptions): Promise<OcrPagesResult>;
