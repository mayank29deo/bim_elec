// Bundles index.html and src/*.js into one self-contained HTML file you can email or host anywhere.
//   node scripts/build.mjs                 -> dist/phase-balancer-copilot.html
//   node scripts/build.mjs --fragment out  -> also writes a head-less fragment (for hosts that add their own <html> shell)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let html = readFileSync(join(root, "index.html"), "utf8");
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = readFileSync(join(root, src), "utf8");
  if (code.includes("</script")) throw new Error(`${src} contains a closing script tag`);
  return `<script>\n/* ${src} */\n${code}\n</script>`;
});
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "phase-balancer-copilot.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);

const i = process.argv.indexOf("--fragment");
if (i > -1 && process.argv[i + 1]) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
    .replace(/<meta charset[^>]*>\s*/, "").replace(/<meta name="viewport"[^>]*>\s*/, "");
  const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
  const rest = head.replace(title, "");
  const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
  writeFileSync(process.argv[i + 1], `${title}\n${rest.trim()}\n${body.trim()}\n`);
  console.log(`wrote ${process.argv[i + 1]}`);
}
