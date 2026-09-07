import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const manifest=JSON.parse(await readFile(new URL("../protocol-fixtures/manifest.json",import.meta.url),"utf8"));
let failed=false;
for(const artifact of manifest.artifacts){const bytes=await readFile(new URL(`../${artifact.path}`,import.meta.url));const actual=createHash("sha256").update(bytes).digest("hex");if(actual!==artifact.sha256){console.error(`hash mismatch: ${artifact.path}`);failed=true;}}
if(failed)process.exitCode=1;else console.log(`verified ${manifest.artifacts.length} immutable protocol artifacts`);
