# Contributing

Use the Node.js version in `.nvmrc` (24) and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs TypeScript, ESLint, the unit tests, and `prettier --check`. Run `pnpm format` before
committing if it fails.

Some suites need services:

- `pnpm test` runs the Redis-backed tests when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set.
  `compose.yaml` starts a local Redis and Upstash-compatible bridge.
- `pnpm test:integration` needs both Redis and a private Vercel Blob store through
  `BLOB_READ_WRITE_TOKEN`. Use a dedicated test store.
- `pnpm test:browser` runs fixture-backed specs without a server. The collection, viewer, and
  theater specs read production gallery data and run only with `LORE_LIVE_BROWSER=1` and a seeded
  app at `LORE_TEST_URL`.

A maintainer runs the integration suite from a trusted branch before merging an outside pull
request. Contributors cannot supply the Blob credentials.

Keep changes focused. If a change alters the snapshot format, the part format, or the interpretation
of a chapter, say so in the pull request and update the relevant document. Do not commit `.env.local`,
generated bundles, or files under `.cache/`.

By contributing, you agree that your contribution is licensed under the MIT License in `LICENSE`.

Dependabot keeps dependencies current: npm packages update weekly, grouped by minor and patch
version, and GitHub Actions update monthly. Major `@types/node` upgrades are ignored because the
types track the runtime version in `.nvmrc`.
