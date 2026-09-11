import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("public wrapper licences are explicit and do not relicense the server", () => {
  assert.match(read("action/LICENSE"), /^MIT License/m);
  assert.match(read("action.yml"), /^# SPDX-License-Identifier: MIT/m);
  assert.match(read("action/index.mjs"), /^\/\/ SPDX-License-Identifier: MIT/m);

  const plugin = read("wordpress-plugin/utilityhouse-release-gate-for-woocommerce/utilityhouse-release-gate-for-woocommerce.php");
  const pluginReadme = read("wordpress-plugin/utilityhouse-release-gate-for-woocommerce/readme.txt");
  assert.match(plugin, /License:\s+GPL-2\.0-or-later/);
  assert.match(pluginReadme, /License:\s+GPLv2 or later/);

  const stagingReadme = join(root, "registration-handoff/public-repo-staging/README.md.new");
  const publicReadme = readFileSync(existsSync(stagingReadme) ? stagingReadme : join(root, "README.md"), "utf8");
  assert.match(publicReadme, /`action\.yml` and `action\/\*\*` are licensed under the MIT License/);
  assert.match(publicReadme, /`wordpress-plugin\/utilityhouse-release-gate-for-woocommerce\/\*\*` is licensed GPL-2\.0-or-later/);
  assert.match(publicReadme, /remaining server, test, deployment or mirror\s+files[\s\S]*all rights reserved/);
  assert.doesNotMatch(publicReadme, /entire repository is licensed/i);
});
