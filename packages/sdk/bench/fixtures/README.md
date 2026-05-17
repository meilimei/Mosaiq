# Bench fixtures

Static HTML snapshots used as regression inputs by vitest. Unlike
`bench/results/` (gitignored — captured per-run fresh from live sites),
files here are **committed** to the repo so CI can run the parser
regression tests deterministically.

## Inventory

### `creepjs-v0.5.0-snapshot.html`

- **Captured**: 2026-05-17, from `https://abrahamjuliot.github.io/creepjs/`
  during the v0.5.0 bench run (`bench/results/2026-05-17T01-27-18-536Z/`).
- **Why it matters**: this exact HTML produced 23 phantom `<unknown>`
  entries in the v0.5.0 report due to a parser bug in
  `extractCreepjsFromDocument`. The v0.5.1 fix must collapse those 23
  phantoms to the 2 real surface markers (WebGL bold-fail, Audio lies).
- **Test**: `bench/sites-creepjs.test.ts` →
  `extractCreepjsFromDocument — v0.5.0 bench fixture`.
- **Size**: ~290 KB. Full page including head + scripts; the test injects
  only the `<body>` content into happy-dom.

## Adding a new fixture

1. Capture the page into `bench/results/<timestamp>/<name>.html` via a
   normal bench run.
2. Copy the file (don't symlink — `bench/results/` is gitignored) here
   under a stable filename describing **what regression** it guards:
   `<feature>-<context>-snapshot.html`.
3. Update this README with the capture date, source URL, and the bug
   it pins down.
4. Reference it from a test via `resolve(__dirname, 'fixtures', '<name>.html')`.
