#!/usr/bin/env node
/**
 * Mosaiq CLI bin entry — thin shim that defers to the compiled ESM cli.js.
 *
 * Kept as plain .js (not .ts) so npm/pnpm can mark it executable without
 * relying on tsx at install time. The actual logic lives in `dist/cli.js`,
 * which is produced by `pnpm --filter @runova/cli build`.
 *
 * For local development you can skip the build step by running:
 *   pnpm mosaiq detection-lab run <persona-id>
 * — the root `mosaiq` script invokes `tsx packages/cli/src/cli.ts` directly.
 */
import('../dist/cli.js').catch((err) => {
  // Most likely cause: someone invoked `node bin/mosaiq.js` before running
  // `pnpm --filter @runova/cli build`. Surface a friendly hint rather than
  // a raw ERR_MODULE_NOT_FOUND.
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      '[mosaiq] dist/cli.js not found. Run `pnpm --filter @runova/cli build` first,\n' +
        '         or use `pnpm mosaiq <args>` from the workspace root to run via tsx.\n',
    );
    process.exit(127);
  }
  process.stderr.write(`[mosaiq] failed to launch CLI: ${err?.stack ?? err}\n`);
  process.exit(1);
});
