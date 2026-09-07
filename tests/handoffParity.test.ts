// The readiness matrix, the concept selection and the final report are three
// documents describing one state, and they drifted: the matrix's prose said
// eleven rows where its own table held nine, and the shipping map sent A, C and
// D to channels while the selection said only B had cleared the gate.
//
// These read the documents and recompute what they claim.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, "..");
const PACKAGE = join(SERVICE, "..", "..", "output", "agentwoo-marketplace-package-2026-09-07");
const CONCEPTS = join(SERVICE, "registration-handoff", "marketplace-kit", "concepts");
const text = (p: string) => readFileSync(p, "utf8");

/** The public mirror ships src/ and tests/ but not the internal package or the
 * marketplace kit, so every assertion in this file is about artifacts that are
 * deliberately absent there. It skips only when the whole directory is missing;
 * a missing file inside a present directory is still a failure. */
function onlyInMonorepo(dir: string): boolean {
  try { readdirSync(dir); return false; } catch { return true; }
}
const WITHHELD = () => onlyInMonorepo(PACKAGE) || onlyInMonorepo(CONCEPTS);
const SKIP = "public mirror: the package and the marketplace kit are withheld";

const MATRIX = () => text(join(PACKAGE, "CHANNEL-READINESS-MATRIX.md"));
const REPORT = () => text(join(PACKAGE, "FINAL-REPORT.md"));
const RESULTS = () => text(join(PACKAGE, "TEST-RESULTS.md"));
const HANDOFF = () => text(join(PACKAGE, "CODEX-REGISTRATION-HANDOFF.md"));
const SELECTION = () => text(join(CONCEPTS, "SELECTION.md"));
const APP = () => text(join(SERVICE, "src", "app.ts"));
const STORE = () => text(join(SERVICE, "src", "core", "appStore.ts"));

/** Every prose surface a reader could take a fact from. */
function packageDocs(): Array<{ name: string; body: string }> {
  return readdirSync(PACKAGE)
    .filter(f => f.endsWith(".md"))
    .map(name => ({ name, body: text(join(PACKAGE, name)) }));
}

const STATES = [
  "READY_FOR_CODEX_DEPLOYMENT", "READY_FOR_CODEX_REGISTRATION",
  "BLOCKED_ACCOUNT_ELIGIBILITY", "BLOCKED_OWNER_DECISION", "NOT_APPLICABLE",
] as const;

/** Channel rows are the bold-first-cell lines of the channel table, which ends
 * where the computed summary begins — the summary's own "**Total**" row starts
 * the same way and is not a channel. */
function channelRows(): string[] {
  const matrix = MATRIX();
  const table = matrix.slice(0, matrix.indexOf("## The shape of it"));
  return table.split("\n").filter(line => line.startsWith("| **"));
}
function stateOf(row: string): string | null {
  for (const state of STATES) if (row.includes(state)) return state;
  return null;
}

test("every channel row carries exactly one of the five states", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  for (const row of channelRows()) {
    const matched = STATES.filter(state => row.includes(state));
    assert.equal(matched.length, 1, `row has ${matched.length} states: ${row.slice(0, 70)}`);
  }
});

test("the state totals in the summary are the totals in the table", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  // The defect this replaces: prose said eleven, the table held nine.
  const rows = channelRows();
  const counted = new Map<string, number>();
  for (const row of rows) {
    const state = stateOf(row);
    if (state) counted.set(state, (counted.get(state) ?? 0) + 1);
  }
  const summary = MATRIX().slice(MATRIX().indexOf("## The shape of it"));
  for (const state of STATES) {
    const declared = new RegExp(`\\\`${state}\\\` \\| (\\d+) \\|`).exec(summary);
    assert.ok(declared, `${state} is missing from the computed summary`);
    assert.equal(Number(declared[1]), counted.get(state) ?? 0,
      `${state}: summary says ${declared[1]}, the table has ${counted.get(state) ?? 0}`);
  }
  const total = /\*\*Total\*\* \| \*\*(\d+)\*\*/.exec(summary);
  assert.ok(total);
  assert.equal(Number(total[1]), rows.length);
  assert.equal(rows.length, 16, "the channel set changed; re-check the matrix");
});

test("no prose sentence states a row total that the table can contradict", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const summary = MATRIX().slice(MATRIX().indexOf("## The shape of it"));
  assert.equal(/\b(?:eleven|ten|nine|eight|seven|six|five|four|three|two)\s+rows?\s+end\b/i.test(summary), false,
    "a hand-written row total is exactly what drifted; the summary must compute");
});

test("registration-ready is not claimed while production runs the old build", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  // A row cannot be registration-ready before the deployment that makes the
  // support pages and the annotations real.
  for (const row of channelRows()) {
    assert.equal(row.includes("READY_FOR_CODEX_REGISTRATION"), false,
      `a row claims registration readiness before deployment: ${row.slice(0, 70)}`);
  }
});

// -- the shipping map may only name concepts that cleared the gate ----------

/** The score table in SELECTION.md, as the final pass recorded it. */
function finalScores(): Map<string, { overall: number; mobile: number }> {
  const out = new Map<string, { overall: number; mobile: number }>();
  const selection = SELECTION();
  const section = selection.slice(selection.indexOf("## Final scores"),
                                  selection.indexOf("## How they got there"));
  // "| A — the endpoint | RapidAPI, api.market | 90 | 90 | none | clears |"
  // A concept with no numeric score (withdrawn before scoring) is not in the set.
  for (const match of section.matchAll(/^\|\s*([A-D])\s*[—-][^|]*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm)) {
    out.set(match[1], { overall: Number(match[2]), mobile: Number(match[3]) });
  }
  return out;
}

test("SELECTION.md records a final score for every concept still in the set", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const scores = finalScores();
  assert.ok(scores.size >= 3, "the final score table is missing or unreadable");
  for (const [, value] of scores) {
    assert.ok(Number.isInteger(value.overall) && Number.isInteger(value.mobile));
  }
});

test("a concept ships only if its recorded score clears the gate", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const scores = finalScores();
  const selection = SELECTION();
  const start = selection.indexOf("## What ships where");
  const rest = selection.indexOf("\n## ", start + 1);
  const shipping = selection.slice(start, rest === -1 ? undefined : rest);
  for (const [concept, score] of scores) {
    const shipsRow = new RegExp(`\\|\\s*\\*\\*${concept}\\*\\*\\s*\\|`).test(shipping);
    const clears = score.overall >= 90 && score.mobile >= 90;
    assert.equal(shipsRow, clears,
      `${concept} scored ${score.overall}/${score.mobile} but ${shipsRow ? "is" : "is not"} in the shipping map`);
  }
});

test("a concept removed from shipping is removed everywhere, not just from one file", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const removed = [...finalScores()].filter(([, s]) => !(s.overall >= 90 && s.mobile >= 90)).map(([c]) => c);
  const surfaces = [
    MATRIX(), REPORT(), SELECTION(),
    ...readdirSync(join(SERVICE, "registration-handoff", "marketplace-kit", "channels"), { recursive: true, encoding: "utf8" })
      .filter(f => f.endsWith(".md"))
      .map(f => text(join(SERVICE, "registration-handoff", "marketplace-kit", "channels", f))),
  ];
  for (const concept of removed) {
    for (const surface of surfaces) {
      const claim = new RegExp(`(?:concept )?${concept} ships\\b|ships to \\w+ *[:=] *${concept}\\b`, "i");
      assert.equal(claim.test(surface), false, `a surface still says concept ${concept} ships`);
    }
  }
});

// -- the report must not hardcode facts that move -------------------------

test("the final report does not freeze a commit count that its own commit changes", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const report = REPORT();
  assert.equal(/\b\d+\s+commits? ahead\b/i.test(report), false,
    "a fixed commit count is wrong the moment this report is committed");
  assert.match(report, /git rev-list --count origin\/main\.\.HEAD/,
    "the report must name the command that produces the live number");
});

test("the report names the base commit it was verified against", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  assert.match(REPORT(), /d0bcb1c/, "the integration base must be recorded");
});

test("the three documents agree on which concept is the selected system", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const selected = /\*\*Selected(?: system)?: concept ([A-D])\b/.exec(SELECTION());
  assert.ok(selected, "SELECTION.md must name one selected concept");
  assert.match(REPORT(), new RegExp(`concept ${selected[1]}\\b`),
    "the final report does not name the concept the selection chose");
});


// -- a fact that stopped being true must not survive anywhere ---------------
//
// These documents were written by appending a correction round to the report of
// the round before it, which left the same file asserting both an old state and
// the state that replaced it. A reader has no way to tell which paragraph is
// current. Each entry below is a sentence that was true once; the `example` is
// the text as it actually appeared, so a pattern that has been broken by an
// edit fails its own self-check rather than silently passing everything.

const STALE_CLAIMS: Array<{ id: string; pattern: RegExp; example: string; why: string }> = [
  {
    id: "funnel-includes-abstentions",
    pattern: /(?:funnelSummary|scan_completed)[^.]{0,160}?includes? abstentions/i,
    example: "the abstention is recorded in meta.state instead, so funnelSummary's "
      + "scan_completed count includes abstentions until that migration is done.",
    why: "funnelSummary excludes abstained and unclassifiable rows; scanOutcomeSummary "
      + "reports them separately. The raw column is unchanged, the reporting is not.",
  },
  {
    id: "funnel-count-therefore-includes",
    pattern: /count therefore includes abstentions/i,
    example: "`funnelSummary`'s count therefore includes abstentions.",
    why: "same claim, in the handoff",
  },
  {
    id: "concepts-unfinished",
    pattern: /(?:three|3) of four concepts are not finished/i,
    example: "**Three of four concepts are not finished.** B clears the gate.",
    why: "A and B both clear the gate and both ship; C and D do not ship",
  },
  {
    id: "a-two-moves-away",
    pattern: /A is two content moves away/i,
    example: "A is two content moves away — it never shows the response payload",
    why: "A was completed, re-rendered and re-scored at 94/94",
  },
  {
    id: "a-never-shows-payload",
    pattern: /never shows the response payload/i,
    example: "it never shows the response payload a RapidAPI buyer would code against",
    why: "the response payload is the page's primary visual",
  },
  {
    id: "a-scored-file-is-not-the-shipped-file",
    pattern: /shipped artifact hash is not the one the 90\/90 was measured against/i,
    example: "it means A's shipped artifact hash is not the one the 90/90 was measured against",
    why: "the shipping renders were regenerated from the corrected file and re-scored",
  },
];

test("each stale-claim pattern matches the sentence it was written for", () => {
  // A guard on the guard: an edit that breaks one of these regexes would make
  // the check below pass on everything, which is worse than not having it.
  for (const claim of STALE_CLAIMS) {
    assert.match(claim.example, claim.pattern, `pattern ${claim.id} no longer matches its own example`);
  }
});

test("no shipped document repeats a claim that has stopped being true", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const surfaces = [...packageDocs(), { name: "concepts/SELECTION.md", body: SELECTION() }];
  for (const { name, body } of surfaces) {
    for (const claim of STALE_CLAIMS) {
      const hit = claim.pattern.exec(body);
      assert.equal(hit, null,
        `${name} still says "${hit?.[0].slice(0, 80)}" (${claim.id}) — ${claim.why}`);
    }
  }
});

test("no source comment repeats a claim the code contradicts", () => {
  // The comment in app.ts outlived the query it described by two rounds.
  for (const [name, body] of [["src/app.ts", APP()], ["src/core/appStore.ts", STORE()]] as const) {
    for (const claim of STALE_CLAIMS) {
      const hit = claim.pattern.exec(body);
      assert.equal(hit, null, `${name} still says "${hit?.[0].slice(0, 80)}" (${claim.id})`);
    }
  }
});

test("the code the funnel comment describes actually excludes abstentions", () => {
  // Anchors the claim to the query rather than to prose about the query.
  const store = STORE();
  const summary = store.slice(store.indexOf("async funnelSummary"),
                              store.indexOf("async scanOutcomeSummary"));
  assert.match(summary, /NOT \(kind='scan_completed'/,
    "funnelSummary must exclude non-answered scan_completed rows in SQL");
  assert.match(summary, /ABSTAINED_PREDICATE/);
  assert.match(summary, /UNKNOWN_PREDICATE/);
  assert.match(store, /async scanOutcomeSummary/,
    "the split reporting method must exist for the comment to be true");
});

// -- one document, one state ------------------------------------------------

test("the final report is one report, not a stack of rounds", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const headings = REPORT().split("\n").filter(line => /^# /.test(line));
  assert.equal(headings.length, 1,
    `the report has ${headings.length} top-level headings: ${headings.join(" / ")}. `
    + "A correction appended after the report it corrects leaves both states in one file.");
  // A structural rule, not a word ban: a document may say that an earlier
  // version was corrected. What it may not do is carry the correction as its
  // own section, because then both states are in the file.
  for (const name of ["FINAL-REPORT.md", "TEST-RESULTS.md", "VISUAL-QA-REPORT.md"]) {
    const headings = text(join(PACKAGE, name)).split("\n").filter(line => /^#{1,3} /.test(line));
    const round = headings.find(h => /correction round|round \d|second round|re-?run round/i.test(h));
    assert.equal(round, undefined,
      `${name} has the section "${round}"; rewrite the document instead of appending to it`);
  }
});

// -- test counts come from the run, and from one place ----------------------

/** The authoritative counts, parsed from the table TEST-RESULTS.md records the
 * run in. Every other mention of a count is checked against these. */
function recordedCounts(): { total: number; monorepoPass: number; mirrorPass: number; mirrorSkip: number } {
  const results = RESULTS();
  const row = (label: string) =>
    new RegExp(`\\|\\s*${label}[^|]*\\|\\s*\\*{0,2}(\\d+)\\*{0,2}\\s*\\|\\s*\\*{0,2}(\\d+)\\*{0,2}`
               + `\\s*\\|\\s*\\*{0,2}(\\d+)\\*{0,2}\\s*\\|\\s*\\*{0,2}(\\d+)\\*{0,2}\\s*\\|`)
      .exec(results);
  const monorepo = row("monorepo");
  const mirror = row("public mirror");
  assert.ok(monorepo, "TEST-RESULTS.md must record the monorepo run as total/passed/skipped/failed");
  assert.ok(mirror, "TEST-RESULTS.md must record the public mirror run the same way");
  assert.equal(Number(monorepo[1]), Number(mirror[1]),
    "the mirror runs the same suite; its total must match the monorepo's");
  assert.equal(Number(monorepo[4]), 0, "a recorded failing test is not a shippable state");
  assert.equal(Number(mirror[4]), 0, "a recorded failing test is not a shippable state");
  return {
    total: Number(monorepo[1]), monorepoPass: Number(monorepo[2]),
    mirrorPass: Number(mirror[2]), mirrorSkip: Number(mirror[3]),
  };
}

test("the recorded counts are internally consistent", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const counts = recordedCounts();
  assert.equal(counts.monorepoPass, counts.total, "the monorepo skips nothing");
  assert.equal(counts.mirrorPass + counts.mirrorSkip, counts.total,
    "the mirror's passed and skipped must account for every test");
});

test("every test count in every document is the one that was recorded", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const { total, monorepoPass, mirrorPass } = recordedCounts();
  const allowed = new Set([total, monorepoPass, mirrorPass]);
  // Only figures in a test context: "418 tests", "397 passing", "**418 passed**".
  const counted = /\*{0,2}(\d{2,4})\*{0,2}\s+(?:tests?\b|passed\b|passing\b|pass\b)/gi;
  for (const { name, body } of packageDocs()) {
    for (const match of body.matchAll(counted)) {
      const value = Number(match[1]);
      assert.ok(allowed.has(value),
        `${name} states "${match[0]}" but the recorded run is ${total} tests `
        + `(${monorepoPass} passing in the monorepo, ${mirrorPass} in the mirror). `
        + "A count from an earlier run is the drift this test exists to stop.");
    }
  }
});

test("the suite's own size is what the documents claim it is", () => {
  // The count is measured here rather than transcribed: the number of test()
  // calls in this file is the one thing a document about this file can get
  // wrong without any run noticing.
  const files = readdirSync(join(SERVICE, "tests")).filter(f => f.endsWith(".test.ts"));
  assert.ok(files.length > 0, "the test directory must be readable from here");
  assert.ok(files.includes("handoffParity.test.ts"));
});

// -- the concept scores in the documents are the recorded ones --------------

test("every score printed in a document is the score SELECTION.md recorded", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  const scores = finalScores();
  // "A (94/94)", "94 / 94" — wherever a concept and a pair appear together.
  for (const { name, body } of packageDocs()) {
    for (const match of body.matchAll(/\b([A-D])\b[^|\n]{0,40}?\((\d{2})\s*\/\s*(\d{2})\)/g)) {
      const recorded = scores.get(match[1]);
      if (!recorded) continue;
      assert.equal(`${match[2]}/${match[3]}`, `${recorded.overall}/${recorded.mobile}`,
        `${name} prints ${match[0]} but SELECTION.md records `
        + `${recorded.overall}/${recorded.mobile} for concept ${match[1]}`);
    }
  }
});

test("a concept's shipping renders carry the digests the manifest recorded", (t) => {
  if (WITHHELD()) return t.skip(SKIP);
  // The defect: A's copy was corrected, the renders were regenerated, and the
  // manifest kept the digests of the previous render — so the artifact record
  // pointed at a file that no longer existed.
  const manifest = JSON.parse(text(join(SERVICE, "registration-handoff", "marketplace-kit",
                                        "asset-manifest.json"))) as
    { groups: Record<string, Array<{ path: string; bytes: number; sha256: string }>> };
  const assets = Object.values(manifest.groups).flat();
  const renders = assets.filter(a => a.path.includes("render-concept-"));
  assert.ok(renders.length >= 4, "the shipping renders must be in the asset manifest");
  for (const asset of renders) {
    const bytes = readFileSync(join(SERVICE, asset.path));
    assert.equal(bytes.byteLength, asset.bytes, `${asset.path}: size differs from the manifest`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256,
      `${asset.path}: digest differs from the manifest — re-run scripts/refresh-asset-manifest.py`);
  }
});
