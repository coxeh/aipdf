import { parseTableHost } from "../src/sandbox";

// 1. Normal table with <th>: headers come from <th>.
const t1 = `<table>
  <thead><tr><th>Name</th><th>Country</th></tr></thead>
  <tbody>
    <tr><td>Acme</td><td>UK</td></tr>
    <tr><td>Brokeco</td><td>FR</td></tr>
  </tbody>
</table>`;
console.log("1) <th> present:", JSON.stringify(parseTableHost(t1)));

// 2. No <th>, first row clearly labels (no value repeats): promote first row.
const t2 = `<table><tbody>
  <tr><td>Name</td><td>Country</td></tr>
  <tr><td>Acme</td><td>UK</td></tr>
  <tr><td>Brokeco</td><td>FR</td></tr>
</tbody></table>`;
console.log("2) no <th>, label-like first row:", JSON.stringify(parseTableHost(t2)));

// 3. Headerless continuation: same value repeats across rows (the cocoa case).
const t3 = `<table><tbody>
  <tr><td>GHANA</td><td>NKAWIE</td><td>sourcing district</td><td>Nkawie</td></tr>
  <tr><td>GHANA</td><td>NSOKOTE</td><td>sourcing district</td><td>Nsokote</td></tr>
  <tr><td>GHANA</td><td>OBUASI</td><td>sourcing district</td><td>Obuasi</td></tr>
  <tr><td>GHANA</td><td>SUHUM</td><td>sourcing district</td><td>Suhum-Kibi</td></tr>
</tbody></table>`;
console.log("3) headerless continuation (cocoa case):", JSON.stringify(parseTableHost(t3)));
