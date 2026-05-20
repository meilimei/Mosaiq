'use strict';

// =============================================================================
// @mosaiq/sdk postinstall script
//
// Applies the rebrowser-patches patch to the consumer's
// `playwright-core@1.59.1`. The patch (302 lines, see
// `packages/sdk/patches/playwright-core@1.59.1.patch`) closes the
// `Runtime.enable` execution-context detection vector that creepjs /
// sannysoft / similar fingerprinters use to flag automated Chrome.
//
// Strategy:
//   1. If running inside the Mosaiq monorepo itself (our own path doesn't
//      contain `node_modules`), exit 0 — `pnpm.patchedDependencies` in the
//      workspace root handles the patch during `pnpm install`.
//   2. Otherwise (we're installed under `<consumer>/node_modules/@mosaiq/sdk/`):
//      walk up from `__dirname` to find the consumer project root (closest
//      ancestor `node_modules`'s parent), verify `playwright-core` exists
//      under it, and invoke `patch-package` with `--patch-dir` pointing to
//      our shipped `patches/` directory.
//
// Escape hatches:
//   - `MOSAIQ_SDK_SKIP_POSTINSTALL=1` — skip entirely (CI environments that
//     intentionally don't want the patch)
//   - `npm install --ignore-scripts` — npm's own escape hatch; this script
//     simply doesn't run (and `npm` itself prints a warning the user can see)
//
// This script never exits non-zero. A failed patch is reported via stderr but
// does not break the consumer's `npm install` — degraded anti-detection is
// better than a broken install.
// =============================================================================

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const TAG = '[@mosaiq/sdk postinstall]';

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`${TAG} ${msg}`);
}

function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(`${TAG} ${msg}`);
}

function main() {
  if (process.env.MOSAIQ_SDK_SKIP_POSTINSTALL === '1') {
    log('Skipped via MOSAIQ_SDK_SKIP_POSTINSTALL=1.');
    return;
  }

  // Resolve our package directory via realpath so pnpm symlinks don't fool the
  // "is this monorepo?" check below.
  const ourDir = path.resolve(fs.realpathSync(__dirname), '..');

  // Step 1: if we're not under any node_modules tree, assume monorepo.
  // pnpm.patchedDependencies in the workspace root handles patching.
  const nodeModulesMarker = `${path.sep}node_modules${path.sep}`;
  if (!ourDir.includes(nodeModulesMarker) && !ourDir.endsWith(`${path.sep}node_modules`)) {
    log('Running inside Mosaiq monorepo; pnpm patchedDependencies handles patching.');
    return;
  }

  // Step 2: find consumer project root (closest ancestor node_modules' parent).
  let cur = ourDir;
  let projectRoot = null;
  while (cur !== path.dirname(cur)) {
    if (path.basename(cur) === 'node_modules') {
      projectRoot = path.dirname(cur);
      break;
    }
    cur = path.dirname(cur);
  }

  if (!projectRoot) {
    warn(`Could not detect consumer project root from ${ourDir}; skipping patch.`);
    return;
  }

  // Step 3: verify playwright-core exists under consumer's node_modules.
  const playwrightCorePkg = path.join(
    projectRoot,
    'node_modules',
    'playwright-core',
    'package.json',
  );
  if (!fs.existsSync(playwrightCorePkg)) {
    warn(
      `playwright-core not found at ${playwrightCorePkg}. @mosaiq/sdk requires playwright-core to be installed as a sibling dependency; add 'playwright-core' to your dependencies (or install 'playwright', which bundles it) and re-install to enable Mosaiq anti-detection.`,
    );
    return;
  }

  // Step 4: read the installed playwright-core version and skip if it's not 1.59.1.
  // The patch is hand-authored against 1.59.1; applying to a different version is unsafe.
  try {
    const installed = JSON.parse(fs.readFileSync(playwrightCorePkg, 'utf-8'));
    const installedVersion = installed?.version;
    if (installedVersion !== '1.59.1') {
      warn(
        `playwright-core@${installedVersion} detected; @mosaiq/sdk patch only supports playwright-core@1.59.1. Pin playwright-core (or playwright) to '1.59.1' in your dependencies, or expect degraded anti-detection (creepjs / sannysoft will flag webdriver).`,
      );
      return;
    }
  } catch (e) {
    warn(`Could not read playwright-core package.json: ${e?.message}. Skip patch.`);
    return;
  }

  // Step 5: resolve patch-package bin via its package.json (avoids hard-coded paths
  // that break across patch-package major versions).
  let patchPackageBin;
  try {
    const pkgPath = require.resolve('patch-package/package.json');
    const pkg = require(pkgPath);
    const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['patch-package'];
    if (!binEntry) {
      throw new Error('patch-package has no bin entry');
    }
    patchPackageBin = path.resolve(path.dirname(pkgPath), binEntry);
  } catch (e) {
    warn(
      `Could not resolve patch-package bin (${e?.message}); this should be a regular dependency of @mosaiq/sdk. Skip patch.`,
    );
    return;
  }

  // Step 6: invoke patch-package with --patch-dir pointing to OUR patches/,
  // cwd set to consumer root.
  const patchesDir = path.resolve(ourDir, 'patches');
  log('Applying playwright-core@1.59.1 patch (rebrowser-patches)...');
  const result = spawnSync('node', [patchPackageBin, '--patch-dir', patchesDir], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    warn(
      `patch-package exited with code ${result.status}. Mosaiq anti-detection is degraded; expect creepjs / sannysoft to flag webdriver. Verify your playwright-core install at ${playwrightCorePkg} is unmodified and re-run \`npx patch-package --patch-dir <path-to-mosaiq-patches>\` manually.`,
    );
    // Don't exit non-zero — consumer's `npm install` should still succeed.
  }
}

try {
  main();
} catch (e) {
  // Last-resort safety net: never break the consumer's install.
  warn(`Unexpected error: ${e?.message ? e.message : e}. Skip patch.`);
}
