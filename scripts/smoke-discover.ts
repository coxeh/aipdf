import { htmlToPlainText, samplePlainText } from "../src/discoverPatterns";
import { runTextPatternExtractor } from "../src/sandbox";

const html = `
<h1>Approved Suppliers 2023</h1>
<p>Below is a list of approved suppliers.</p>
<p>
Acme Ltd<br>
12 High Street<br>
London, UK
</p>
<p>
Brokeco SA<br>
5 Rue de Paix<br>
Paris, FR
</p>
<p>
Caro Foods<br>
99 Marina Bay<br>
Singapore, SG
</p>
<p>
Dora Cocoa<br>
1 Avenida Brasil<br>
Sao Paulo, BR
</p>
<p>End of list.</p>
`;

const plain = htmlToPlainText(html);
console.log("--- plain text ---");
console.log(plain);
console.log();

const { sample, sampledChars, totalChars } = samplePlainText(plain);
console.log(`--- sample (${sampledChars}/${totalChars}) ---`);
console.log(sample.slice(0, 200));
console.log();

const patternExtractor = `
export function extract(text, helpers) {
  const lines = text.split("\\n").map(l => l.trim()).filter(Boolean);
  const records = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const street = lines[i + 1];
    const cityCountry = lines[i + 2];
    if (!/\\d/.test(street)) continue;
    const m = cityCountry.match(/^(.+),\\s*([A-Z]{2})$/);
    if (!m) continue;
    records.push({
      name: lines[i],
      street,
      city: m[1],
      country: m[2],
    });
    i += 2;
  }
  return {
    groups: [
      {
        name: "supplier-addresses",
        title: "Supplier Addresses",
        description: "Three-line address blocks discovered in prose",
        schema: { name: "string", street: "string", city: "string", country: "string" },
        records,
      },
    ],
  };
}
`;

const result = await runTextPatternExtractor(patternExtractor, plain, { timeoutMs: 5000 });
console.log("--- runTextPatternExtractor output ---");
console.log(JSON.stringify(result, null, 2));
