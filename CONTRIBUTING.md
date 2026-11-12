# Contributing

Use Node.js 24, the version in `.nvmrc`, and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs TypeScript, ESLint, the unit tests, and `prettier --check`. If the format check
fails, run `pnpm format` before you commit.

Some suites need services.

- `pnpm test` runs the Redis-backed tests when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set.
  `compose.yaml` starts a local Redis and an Upstash-compatible bridge.
- `pnpm test:integration` needs both Redis and a private Vercel Blob store through
  `BLOB_READ_WRITE_TOKEN`. Use a dedicated test store.
- `pnpm test:browser` runs fixture-backed specs without a server. The collection, viewer, and
  theater specs read production gallery data and run only with `LORE_LIVE_BROWSER=1` and a seeded
  app at `LORE_TEST_URL`.

I run the integration suite from a trusted branch before I merge an outside pull request. You can't
supply the Blob credentials.

Keep the change focused. If you change the snapshot format, the part format, or how a chapter is
interpreted, say so in the pull request and update the document that covers it. Don't commit
`.env.local`, generated bundles, or files under `.cache/`.

By contributing, you agree that your contribution is licensed under the MIT License in `LICENSE`.

Dependabot keeps dependencies current. npm packages update weekly, grouped by minor and patch
version, and GitHub Actions update monthly. I ignore major `@types/node` upgrades. The types track
the runtime version in `.nvmrc`.
