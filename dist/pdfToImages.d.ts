export type PdfToImagesOptions = {
    force?: boolean;
    scale?: number;
};
export declare function pdfToImages(pdfPath: string, outDir: string, opts?: PdfToImagesOptions): Promise<string[]>;
