# Testing

Use Node.js 24 (the version in `.nvmrc`) and install dependencies with
`pnpm install --frozen-lockfile`.

## Checks without credentials

```sh
pnpm check
```

`pnpm check` runs TypeScript, ESLint, the `node --test` suites, and the formatting check. The test
command builds the Sandbox worker and the runner first. A test that needs Redis or Blob skips when
its variables aren't set.

## Redis-backed tests

`compose.yaml` starts Redis and the same Upstash-compatible HTTP bridge that CI uses.

```sh
docker compose up -d
KV_REST_API_URL=http://127.0.0.1:8104 KV_REST_API_TOKEN=lore-ci pnpm test
```

## Integration suite

```sh
pnpm test:integration
```

This command needs `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and a dedicated private Vercel Blob store
in `BLOB_READ_WRITE_TOKEN`. It turns on the live GitHub resolver test. Missing credentials fail the
command. So do failures, skipped tests, pending tests, and cancelled tests. Test-owned UUID prefixes
keep concurrent runs apart. Don't point it at production storage.

## Browser tests

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:browser
```

Plain `pnpm test:browser` runs the fixture-backed specs in both the desktop and mobile projects.
They mount the production components and the WebGL scene against local snapshot fixtures. They don't
need a hosted app or storage credentials.

Three specs read the production gallery: `tests/browser/collection.spec.ts`,
`tests/browser/viewer.spec.ts`, and `tests/browser/theater.spec.ts`. `playwright.config.ts` skips
them unless `LORE_LIVE_BROWSER=1` is set. Run them against an app that has the 24 gallery films
seeded.

```sh
LORE_LIVE_BROWSER=1 LORE_TEST_URL=http://127.0.0.1:3000 pnpm test:browser
```

Two of those checks also read the snapshot JSON, so they can compare the page's commit ticks and
flare with the data it was built from. Those are the theater flare check and the viewer artifact
check. Point `LORE_SNAPSHOT_JSON_DIR` at a directory of published snapshot files, such as a
precompute `.cache/gallery`. Without that directory, those two checks skip.

## Continuous integration

The `Check` workflow starts isolated Redis containers for every PR. The checks that need no secrets
run on every PR. The integration job runs on pushes and on pull requests from this repository, with
a dedicated test Blob store. A fork runs only the checks that need no secrets. I run the integration
suite from a trusted branch before I merge a fork contribution.
