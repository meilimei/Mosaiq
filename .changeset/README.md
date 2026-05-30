# Changesets

This directory holds [changesets](https://github.com/changesets/changesets)
metadata for the three publishable Mosaiq packages:

- `@runova/persona-schema`
- `@runova/sdk`
- `@mosaiq/cli`

`@mosaiq/desktop` is **ignored** (Electron app, never publishes to npm).

## How to use

When you make a change to one (or more) of the publishable packages, add a
changeset describing the change:

```bash
pnpm changeset
```

It prompts you to:

1. Pick which package(s) the change applies to. **Because the three
   publishable packages are configured as a `fixed` group (see
   `config.json`), picking any one will bump all three together — this
   matches our v0.9 lock-step release pattern.**
2. Pick the bump type:
   - `major` — breaking change (Persona schema breaks back-compat, SDK
     exports rename, CLI flag removed)
   - `minor` — new feature, additive
   - `patch` — bug fix, doc update, internal refactor
3. Write a one-line summary (will surface in the release PR body, **not**
   in `CHANGELOG.md` — we keep that hand-written in Chinese; see
   `config.json` `"changelog": false`)

The result is a `.md` file under `.changeset/` named something like
`fluffy-bears-jump.md`. **Commit it as part of your PR.**

## Release workflow

1. Author adds `.changeset/<name>.md` to their PR; PR merges to `main`.
2. `.github/workflows/release.yml` (changesets/action) detects pending
   `.changeset/*.md` files on `main` and opens a `chore(release):
   version packages` PR that:
   - Bumps `@runova/persona-schema` / `@runova/sdk` / `@mosaiq/cli`
     versions in lock-step
   - Updates `pnpm-lock.yaml`
   - Removes the consumed `.changeset/*.md` files
3. Maintainer hand-edits `CHANGELOG.md` to add the corresponding
   `## [X.Y.Z]` section (Chinese, rich formatting; see existing
   `## [0.9.0]` entry for style). Push the edit to the release PR.
4. Merging the release PR triggers `release.yml` to:
   - Run `pnpm changeset publish` — publishes the three packages to npm
     with `provenance: true` (npm OIDC attestation)
   - Tag the commit `@runova/persona-schema@X.Y.Z` etc.
5. Maintainer creates the GitHub Release page off `vX.Y.Z` tag (manual,
   one-line creation in the web UI).

For the **first** v0.10.0 release, steps 1-2 are bypassed (no changesets
have accumulated yet). The release is done manually via
`pnpm changeset version --snapshot` or by bumping `version` in each
package.json by hand, then running `pnpm changeset publish` from a local
shell with `NPM_TOKEN` set.

## Useful commands

```bash
# Add a changeset
pnpm changeset

# Show pending changesets + planned bumps
pnpm changeset status

# Bump versions per pending changesets (consumes .changeset/*.md)
pnpm changeset version

# Publish (requires NPM_TOKEN env var; normally only run from release.yml)
pnpm changeset publish
```

## Config gotchas

- `"commit": false` — changesets does NOT auto-commit. release.yml /
  maintainer handles commits.
- `"changelog": false` — disable changesets' auto-CHANGELOG.md
  generation. `CHANGELOG.md` is hand-written in Chinese; matching the
  existing v0.1 → v0.9 style is more important than auto-generation.
- `"fixed": [[ "@runova/persona-schema", "@runova/sdk", "@mosaiq/cli" ]]`
  — lock-step group. Touching any of the three triggers all three to
  bump.
- `"updateInternalDependencies": "patch"` — when `@runova/persona-schema`
  bumps, `@runova/sdk` (which depends on it) gets a `patch` bump if not
  already bumping. With `"fixed"` this rarely matters but keeps
  consistency.
- `"ignore": ["@mosaiq/desktop"]` — desktop is private + Electron, never
  on npm. Excluded from changeset operations entirely.
