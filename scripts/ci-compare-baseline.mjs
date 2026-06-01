#!/usr/bin/env node
// =============================================================================
// scripts/ci-compare-baseline.mjs
//
// v0.10 phase 10.7 — Detection Lab CI gate comparator.
//
// Compares a fresh Detection Lab run (the "candidate", produced by
// `mosaiq detection-lab run <persona> --json > candidate.json` on the CI
// runner) against a committed baseline checked into the repo at
// `tests/fixtures/baseline-runs/<persona>/baseline.json`.
//
// Two modes:
//
//   1. compare <baseline.json> <candidate.json>
//        [--fail-on-regression]
//        [--markdown-out <file>]
//        [--network-failure-tolerance <n>]   (default: 2)
//        [--require-baseline]
//
//      Loads both files, strips the candidate to baseline shape via
//      `stripRunForBaseline`, then runs `diffRuns` from @runova/sdk.
//      Emits a markdown report (always) and a green/red verdict.
//      Lenient policy: a small number of network-driven `ok → fail`
//      flips can be tolerated (configurable; see below) so the gate
//      doesn't flap on transient HTTP errors.
//
//   2. write-baseline <candidate.json> <out-baseline.json>
//
//      Reads a freshly-produced DetectionRun JSON, applies
//      `stripRunForBaseline`, and writes the result. Used to bootstrap
//      a baseline file from a known-good CI candidate (download the
//      `candidate-<persona>.json` artifact from a green workflow run,
//      run this command, commit the result).
//
// Why a separate script instead of extending `mosaiq detection-lab compare`?
//   - The CLI compare command reads from `~/.mosaiq/detection-runs/` (the
//     user's run store). CI doesn't have a baseline run there — it has a
//     committed JSON file at a known path. File-vs-file is a cleaner
//     contract for the workflow yaml than fabricating fake runId entries
//     in `~/.mosaiq/` just to satisfy the CLI shape.
//   - The CI gate also needs network-failure tolerance (see below), which
//     is policy that doesn't belong in the general-purpose CLI surface.
//   - Future Phase 10.8 baseline-refresh-workflow can compose `write-
//     baseline` mode without touching SDK / CLI internals.
//
// Network-failure tolerance:
//   `diffRuns` treats any `ok → fail` site flip as a regression. In a CI
//   environment that's too strict — a single 5xx from creepjs.com /
//   browserscan / sannysoft is enough to flap the gate red on otherwise-
//   clean SDK changes. We override the SDK's `hasRegression` boolean with
//   a more lenient one:
//     - If `added.length === 0` AND `delta.weightedHits <= 0` AND
//       `okToFail.length <= tolerance` → PASS (with a "network noise"
//       note in the markdown).
//     - Otherwise → follow `diff.hasRegression`.
//
// Exit codes:
//   0 = pass (no regression OR regression under tolerance OR baseline
//       missing without --require-baseline)
//   1 = regression detected (with --fail-on-regression)
//   2 = arg error / file read error / SDK module load error
//
// Run via:
//   node scripts/ci-compare-baseline.mjs compare <baseline> <candidate> ...
//   pnpm ci-compare-baseline compare <baseline> <candidate> ...
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// We import the SDK directly from the workspace build output rather than
// via the bare-specifier `@runova/sdk`. Reason: pnpm only symlinks
// `@runova/sdk` into consumer packages' `node_modules` (cli / desktop /
// persona-schema-tests), NOT into the workspace root. Bare-specifier
// import would fail when this script runs from the repo root.
// The file-URL import side-steps the resolver and works from any cwd.
const SDK_DIST = resolve(ROOT, 'packages', 'sdk', 'dist', 'index.js');
let sdkExports;
try {
  if (!existsSync(SDK_DIST)) {
    throw new Error(`SDK dist not found at ${SDK_DIST}`);
  }
  sdkExports = await import(pathToFileURL(SDK_DIST).href);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `❌ Failed to import @runova/sdk: ${err?.message ?? err}\nHint: run \`pnpm --filter @runova/sdk build\` first, then re-invoke.`,
  );
  process.exit(2);
}
const { diffRuns, stripRunForBaseline } = sdkExports;

// ─────────────────────────────────────────────────────────────────────────────
// argv 解析
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const mode = argv[0];

if (!mode || mode === '-h' || mode === '--help') {
  printUsage();
  process.exit(mode ? 0 : 2);
}

if (mode === 'compare') {
  runCompare(argv.slice(1));
} else if (mode === 'write-baseline') {
  runWriteBaseline(argv.slice(1));
} else {
  // eslint-disable-next-line no-console
  console.error(`❌ Unknown mode: '${mode}'. Expected 'compare' or 'write-baseline'.\n`);
  printUsage();
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: compare
// ─────────────────────────────────────────────────────────────────────────────

function runCompare(rest) {
  const opts = parseCompareArgs(rest);

  // ─── 1. Baseline missing → bootstrap path ──────────────────────────────
  if (!existsSync(opts.baselineFile)) {
    const candidateExists = existsSync(opts.candidateFile);
    const lines = [];
    lines.push('## ⚠ Detection Lab baseline missing');
    lines.push('');
    lines.push(`No baseline file found at \`${relRoot(opts.baselineFile)}\`.`);
    lines.push('');
    if (candidateExists) {
      lines.push(
        'A candidate run was produced. To **bootstrap** the baseline from this candidate, ' +
          'download the workflow artifact and commit it via:',
      );
      lines.push('');
      lines.push('```bash');
      lines.push(
        `node scripts/ci-compare-baseline.mjs write-baseline \\\n  ${relRoot(opts.candidateFile)} \\\n  ${relRoot(opts.baselineFile)}`,
      );
      lines.push('git add tests/fixtures/baseline-runs/');
      lines.push('git commit -m "chore(baseline): bootstrap detection-lab baseline"');
      lines.push('```');
    } else {
      lines.push('(No candidate file was produced either — investigate the run step.)');
    }
    lines.push('');

    const md = lines.join('\n');
    process.stdout.write(`${md}\n`);
    if (opts.markdownOut) writeMarkdown(opts.markdownOut, md);

    if (opts.requireBaseline) {
      // eslint-disable-next-line no-console
      console.error('\n❌ --require-baseline set but baseline file is missing.');
      process.exit(1);
    }
    // Without --require-baseline this is bootstrap mode, not a failure.
    process.exit(0);
  }

  // ─── 2. Load both runs ────────────────────────────────────────────────
  const baseline = readJson(opts.baselineFile, 'baseline');
  const candidateRaw = readJson(opts.candidateFile, 'candidate');

  // Strip candidate to baseline shape so the diff isolates behavior delta
  // from environmental noise (host chromium version, ISO timestamps, ...).
  const candidate = stripRunForBaseline(candidateRaw);

  const personaId =
    typeof baseline.personaId === 'string' && baseline.personaId.length > 0
      ? baseline.personaId
      : (candidate.personaId ?? 'unknown');

  // ─── 3. Compute diff + lenient regression decision ────────────────────
  const diff = diffRuns(personaId, baseline, candidate);
  const okToFail = diff.sitesFlipped.okToFail;
  const networkOnly =
    diff.added.length === 0 &&
    diff.delta.weightedHits <= 0 &&
    okToFail.length > 0 &&
    okToFail.length <= opts.networkTolerance;

  const isRegression = diff.hasRegression && !networkOnly;

  // ─── 4. Emit markdown report ──────────────────────────────────────────
  const md = renderMarkdown(diff, {
    personaId,
    baselineFile: opts.baselineFile,
    candidateFile: opts.candidateFile,
    networkTolerance: opts.networkTolerance,
    networkOnly,
    isRegression,
  });
  process.stdout.write(`${md}\n`);
  if (opts.markdownOut) writeMarkdown(opts.markdownOut, md);

  // ─── 5. Exit code ─────────────────────────────────────────────────────
  if (isRegression && opts.failOnRegression) {
    process.exit(1);
  }
  process.exit(0);
}

function parseCompareArgs(rest) {
  let baselineFile;
  let candidateFile;
  let failOnRegression = false;
  let requireBaseline = false;
  let markdownOut;
  let networkTolerance = 2;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--fail-on-regression') failOnRegression = true;
    else if (a === '--require-baseline') requireBaseline = true;
    else if (a === '--markdown-out') {
      markdownOut = rest[++i];
      if (!markdownOut) bail('--markdown-out requires a file path');
    } else if (a === '--network-failure-tolerance') {
      const v = rest[++i];
      if (v === undefined) bail('--network-failure-tolerance requires a number');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== v.trim()) {
        bail(`--network-failure-tolerance must be a non-negative integer (got '${v}')`);
      }
      networkTolerance = n;
    } else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else if (a.startsWith('-')) {
      bail(`Unknown flag: ${a}`);
    } else if (!baselineFile) baselineFile = resolveCwd(a);
    else if (!candidateFile) candidateFile = resolveCwd(a);
    else bail(`Unexpected extra positional: ${a}`);
  }

  if (!baselineFile || !candidateFile) {
    bail('compare requires <baseline.json> and <candidate.json>');
  }

  return {
    baselineFile,
    candidateFile,
    failOnRegression,
    requireBaseline,
    markdownOut,
    networkTolerance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: write-baseline
// ─────────────────────────────────────────────────────────────────────────────

function runWriteBaseline(rest) {
  const positional = rest.filter((x) => !x.startsWith('-'));
  if (positional.length !== 2) {
    bail('write-baseline requires <candidate.json> <out-baseline.json>');
  }
  const candidateFile = resolveCwd(positional[0]);
  const outFile = resolveCwd(positional[1]);

  const candidate = readJson(candidateFile, 'candidate');
  const stripped = stripRunForBaseline(candidate);

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(stripped, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(`✓ Wrote stripped baseline to ${relRoot(outFile)}`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdown(diff, ctx) {
  const lines = [];

  // Title
  if (ctx.isRegression) {
    lines.push(`## 🚨 Detection Lab regression on **${ctx.personaId}**`);
  } else if (ctx.networkOnly) {
    lines.push(`## ⚠ Detection Lab tolerated network noise on **${ctx.personaId}**`);
  } else if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.sitesFlipped.okToFail.length === 0 &&
    diff.sitesFlipped.failToOk.length === 0
  ) {
    lines.push(`## ✅ Detection Lab clean on **${ctx.personaId}**`);
  } else {
    lines.push(`## ✅ Detection Lab passed on **${ctx.personaId}** (no regression)`);
  }
  lines.push('');

  // Metric table (baseline | candidate | Δ)
  lines.push('| metric | baseline | candidate | Δ |');
  lines.push('|---|---:|---:|---:|');
  lines.push(
    `| weightedHits | ${fmtWeighted(diff.runA.weightedHits)} | ${fmtWeighted(diff.runB.weightedHits)} | ${deltaCell(diff.delta.weightedHits, false, true)} |`,
  );
  lines.push(
    `| totalHits | ${diff.runA.totalHits} | ${diff.runB.totalHits} | ${deltaCell(diff.delta.totalHits)} |`,
  );
  lines.push(
    `| sitesOk | ${diff.runA.sitesOk} | ${diff.runB.sitesOk} | ${deltaCell(diff.delta.sitesOk, true)} |`,
  );
  lines.push(
    `| sitesFail | ${diff.runA.sitesFail} | ${diff.runB.sitesFail} | ${deltaCell(diff.delta.sitesFail)} |`,
  );
  lines.push('');

  // Added hits
  if (diff.added.length > 0) {
    lines.push(`### Added hits (${diff.added.length})`);
    lines.push('');
    for (const h of diff.added) lines.push(formatHitLine(h));
    lines.push('');
  }

  // Removed hits (improvements — celebrate)
  if (diff.removed.length > 0) {
    lines.push(`### Removed hits (${diff.removed.length}) — improvement`);
    lines.push('');
    for (const h of diff.removed) lines.push(formatHitLine(h));
    lines.push('');
  }

  // Changed hits (same identity, different severity/evidence)
  if (diff.changed.length > 0) {
    lines.push(`### Changed hits (${diff.changed.length})`);
    lines.push('');
    for (const c of diff.changed) {
      const fields = c.diff.join(', ');
      lines.push(
        `- ${severityEmoji(c.after.severity)} **${escapeMd(c.after.surface)}** / \`${escapeMd(c.after.site)}\` — ${escapeMd(c.after.detector)} _(changed: ${fields})_`,
      );
    }
    lines.push('');
  }

  // Site flips
  if (diff.sitesFlipped.okToFail.length > 0) {
    lines.push(`### Sites flipped ok → fail (${diff.sitesFlipped.okToFail.length})`);
    lines.push('');
    for (const id of diff.sitesFlipped.okToFail) lines.push(`- \`${escapeMd(id)}\``);
    lines.push('');
  }
  if (diff.sitesFlipped.failToOk.length > 0) {
    lines.push(`### Sites recovered fail → ok (${diff.sitesFlipped.failToOk.length})`);
    lines.push('');
    for (const id of diff.sitesFlipped.failToOk) lines.push(`- \`${escapeMd(id)}\``);
    lines.push('');
  }

  // Site-list discrepancy (run flag mismatch)
  if (diff.sitesOnlyInA.length > 0 || diff.sitesOnlyInB.length > 0) {
    lines.push('### ⚠ Site list mismatch between baseline and candidate');
    lines.push('');
    if (diff.sitesOnlyInA.length > 0)
      lines.push(`- only in baseline: ${diff.sitesOnlyInA.map((s) => `\`${s}\``).join(', ')}`);
    if (diff.sitesOnlyInB.length > 0)
      lines.push(`- only in candidate: ${diff.sitesOnlyInB.map((s) => `\`${s}\``).join(', ')}`);
    lines.push('');
  }

  // Network-tolerance note
  if (ctx.networkOnly) {
    lines.push('---');
    lines.push('');
    lines.push(
      `> ℹ️ ${diff.sitesFlipped.okToFail.length} site(s) flipped \`ok → fail\` but \`weightedHits\` did not increase and no hits were added. Within \`--network-failure-tolerance=${ctx.networkTolerance}\`, so this is treated as transient network noise rather than a regression.`,
    );
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`- baseline: \`${relRoot(ctx.baselineFile)}\``);
  lines.push(
    `- candidate: \`${relRoot(ctx.candidateFile)}\` (stripped via \`stripRunForBaseline\`)`,
  );

  return lines.join('\n');
}

function formatHitLine(h) {
  const evidence = h.evidence ? ` — ${escapeMd(h.evidence)}` : '';
  return `- ${severityEmoji(h.severity)} **${escapeMd(h.surface)}** / \`${escapeMd(h.site)}\` — ${escapeMd(h.detector)}${evidence}`;
}

function severityEmoji(s) {
  if (s === 'high') return '🔴';
  if (s === 'medium') return '🟡';
  return '⚪';
}

function escapeMd(s) {
  // Conservative GFM escape — only the characters that would actively
  // break inline rendering (bold/italic, code, links, table cells).
  // Periods / parens / hyphens are left alone so detector strings stay
  // readable (e.g. `navigator.webdriver` shouldn't become `navigator\.webdriver`).
  return String(s).replace(/([\\`*_\[\]|])/g, '\\$1');
}

function fmtWeighted(n) {
  // weightedHits is conceptually a float sum-of-severity-weights; always
  // show 2 decimals for table alignment even when the underlying value
  // happens to be a whole number (4 → "4.00", not "4").
  return n.toFixed(2);
}

function deltaCell(n, invertColor = false, isFloat = false) {
  if (n === 0) return '0';
  const sign = n > 0 ? '+' : '';
  const num = isFloat ? n.toFixed(2) : Number.isInteger(n) ? String(n) : n.toFixed(2);
  // For weightedHits / totalHits / sitesFail: positive = bad → red arrow
  // For sitesOk: positive = good → green arrow (invertColor=true)
  const isBad = invertColor ? n < 0 : n > 0;
  const arrow = isBad ? '🔺' : '🔻';
  return `**${sign}${num} ${arrow}**`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readJson(file, label) {
  if (!existsSync(file)) bail(`${label} file does not exist: ${file}`);
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    bail(`Failed to read ${label} (${file}): ${err?.message ?? err}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    bail(`Failed to parse ${label} JSON (${file}): ${err?.message ?? err}`);
  }
}

function writeMarkdown(file, md) {
  mkdirSync(dirname(resolveCwd(file)), { recursive: true });
  writeFileSync(resolveCwd(file), `${md}\n`);
}

function resolveCwd(p) {
  return resolve(process.cwd(), p);
}

function relRoot(p) {
  const rel = relative(ROOT, p);
  return rel.split('\\').join('/');
}

function bail(msg) {
  // eslint-disable-next-line no-console
  console.error(`❌ ${msg}`);
  process.exit(2);
}

function printUsage() {
  const usage = `Usage:
  node scripts/ci-compare-baseline.mjs compare <baseline.json> <candidate.json> [options]
  node scripts/ci-compare-baseline.mjs write-baseline <candidate.json> <out-baseline.json>

compare options:
  --fail-on-regression               Exit 1 if a regression is detected (after lenient policy)
  --require-baseline                 Exit 1 if the baseline file is missing (default: bootstrap)
  --markdown-out <file>              Also write the markdown report to <file>
  --network-failure-tolerance <n>    Allow up to n ok→fail site flips if weightedHits did
                                     not rise and no hits were added (default: 2)

Examples:
  pnpm --filter @runova/sdk build
  pnpm mosaiq detection-lab run win11-chrome-us --json > candidate.json
  node scripts/ci-compare-baseline.mjs compare \\
    tests/fixtures/baseline-runs/win11-chrome-us/baseline.json \\
    candidate.json \\
    --fail-on-regression \\
    --markdown-out regression.md

  node scripts/ci-compare-baseline.mjs write-baseline \\
    candidate.json \\
    tests/fixtures/baseline-runs/win11-chrome-us/baseline.json
`;
  process.stdout.write(usage);
}
