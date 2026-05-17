import { pdf } from "pdf-to-img";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type PdfToImagesOptions = {
  force?: boolean;
  scale?: number;
};

export async function pdfToImages(
  pdfPath: string,
  outDir: string,
  opts: PdfToImagesOptions = {},
): Promise<string[]> {
  const { force = false, scale = 2 } = opts;
  await mkdir(outDir, { recursive: true });

  if (!force) {
    const cached = (await readdir(outDir))
      .filter((f) => f.endsWith(".png"))
      .sort();
    if (cached.length > 0) {
      console.log(`[1/5] Using ${cached.length} cached page image(s) in ${outDir}`);
      return cached.map((f) => join(outDir, f));
    }
  }

  console.log(`[1/5] Rendering PDF pages to images...`);
  const doc = await pdf(pdfPath, { scale });
  const paths: string[] = [];
  let i = 0;
  for await (const image of doc) {
    i++;
    const p = join(outDir, `page-${String(i).padStart(3, "0")}.png`);
    await writeFile(p, image);
    paths.push(p);
    process.stdout.write(`\r  rendered ${i} page(s)`);
  }
  process.stdout.write("\n");
  return paths;
}
