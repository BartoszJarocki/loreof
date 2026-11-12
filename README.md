# Lore

Lore turns public GitHub history into an interactive documentary. Files appear when they are
created, light up when touched, and fade when deleted. Chapters link their captions to the recorded
commits.

Live at [loreof.vercel.app](https://loreof.vercel.app).

## Stack

Lore is a Next.js App Router application on Vercel. A Vercel Workflow starts a Sandbox that clones a
public repository with a blobless clone, reads its first-parent history, lays the files out in 3D,
and cuts the history into chapters with factual evidence. A model on AI Gateway picks landmark
commits for each chapter; a validator rejects anything that is not in the chapter's evidence sheet.
The snapshot is stored as an immutable gzip JSON artifact in private Blob, with a small manifest in
Upstash Redis. The repository page reads only the manifest, then streams three binary parts derived
from the artifact into a three.js point cloud. See [docs/architecture.md](docs/architecture.md).

## Run the checks

Use the Node.js version in `.nvmrc` (24) and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript, ESLint, the unit tests, and the formatting check. It needs no
credentials; the tests that require Redis or Blob skip when those variables are absent.

```sh
pnpm build
```

The build bundles the Sandbox worker and runner first.

Dependabot opens grouped npm minor and patch updates every week and GitHub Actions updates every
month. It leaves major `@types/node` upgrades alone because the types follow the runtime version in
`.nvmrc`.

## Run the Redis-backed tests

`compose.yaml` starts Redis and an Upstash-compatible HTTP bridge with the same images as the CI
workflow. The bridge listens on port 8104; CI uses 8079.

```sh
docker compose up -d
KV_REST_API_URL=http://127.0.0.1:8104 KV_REST_API_TOKEN=lore-ci pnpm test
docker compose down
```

The integration suite also needs a private Vercel Blob store. Use a dedicated test store, never
production:

```sh
KV_REST_API_URL=http://127.0.0.1:8104 \
KV_REST_API_TOKEN=lore-ci \
BLOB_READ_WRITE_TOKEN=... \
pnpm test:integration
```

The integration command fails on any skipped, pending, or cancelled test.

## Run the browser tests

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:browser
```

That runs the fixture-backed specs in both the desktop and mobile projects and needs no server. The
collection, viewer, and theater specs read production gallery data and are skipped unless
`LORE_LIVE_BROWSER=1` is set. To run them, start an app with the seeded gallery and point the tests at
it:

```sh
LORE_LIVE_BROWSER=1 LORE_TEST_URL=http://127.0.0.1:3000 pnpm test:browser
```

The theater flare check and the viewer artifact check also compare the page with the snapshot JSON
itself. Set `LORE_SNAPSHOT_JSON_DIR` to a directory of published snapshot files, such as the
`.cache/gallery` that `precompute` writes; those two checks skip without it.

See [docs/testing.md](docs/testing.md) for the suites and their requirements.

## Security

Every response carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, a strict
referrer policy, and a permissions policy that denies camera, microphone, and geolocation
(`next.config.ts`). Mutating routes accept a request only when BotID reports that it is not a bot.
Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Self-host on Vercel

1. Import the repository into your own Vercel account.
2. Create an Upstash Redis database and set `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the
   `UPSTASH_REDIS_REST_*` aliases).
3. Create a private Vercel Blob store and set `BLOB_READ_WRITE_TOKEN`.
4. Enable AI Gateway. On Vercel, `VERCEL_OIDC_TOKEN` authenticates model calls and Sandbox; do not
   create or paste it yourself.
5. Set the remaining variables in the table below. `NEXT_PUBLIC_SITE_URL` is your canonical origin;
   it defaults to the Vercel production URL, and locally to `http://localhost:3000`.
6. Deploy. The hourly cron at `/api/cron/checkpoints` authenticates with `CRON_SECRET` and removes
   expired analysis checkpoints.

| Variable                   | Required | Purpose                                                               |
| -------------------------- | -------- | --------------------------------------------------------------------- |
| `KV_REST_API_URL`          | Yes      | Upstash Redis REST endpoint.                                          |
| `KV_REST_API_TOKEN`        | Yes      | Upstash Redis REST token.                                             |
| `UPSTASH_REDIS_REST_URL`   | Alias    | Alternative name for the Redis endpoint.                              |
| `UPSTASH_REDIS_REST_TOKEN` | Alias    | Alternative name for the Redis token.                                 |
| `BLOB_READ_WRITE_TOKEN`    | Yes      | Private Blob store for artifacts and checkpoints.                     |
| `LORE_IP_SALT`             | Yes      | Salt for hashed visitor IPs in admission limits.                      |
| `CRON_SECRET`              | Yes*     | Authenticates the hourly checkpoint cleanup cron.                     |
| `NEXT_PUBLIC_SITE_URL`     | Yes*     | Canonical origin for links and share images.                          |
| `AI_GATEWAY_API_KEY`       | No       | Local or non-Vercel Gateway authentication.                           |
| `VERCEL_OIDC_TOKEN`        | Vercel   | Provided by Vercel at runtime; never set it.                          |
| `GITHUB_TOKEN`             | No       | Raises GitHub REST rate limits for repository metadata.               |
| `LORE_REDIS_PREFIX`        | No       | Namespace for Redis keys; defaults to `lore:v1`.                      |
| `LORE_BLOB_PREFIX`         | No       | Blob path prefix; must start with a letter or digit and end with `/`. |
| `LORE_MODEL`               | No       | Gateway model ID; defaults to `anthropic/claude-sonnet-5.5`.          |
| `LORE_AI_MONTHLY_USD`      | No       | Monthly narration budget cap; defaults to 20.                         |
| `LORE_DAILY_LIMIT`         | No       | Daily admission limit; defaults to 10.                                |
| `LORE_MONTHLY_LIMIT`       | No       | Monthly admission limit; defaults to 100.                             |
| `LORE_IP_DAILY_LIMIT`      | No       | Daily submissions per IPv4 address and IPv6 /64 block; default 3.     |
| `LORE_CONCURRENT_LIMIT`    | No       | Concurrent analysis limit; defaults to 2.                             |

\* Required in production. Without `CRON_SECRET` the cleanup route refuses to run; without
`NEXT_PUBLIC_SITE_URL` the site uses the Vercel production hostname, or `http://localhost:3000`
locally.

`.env.example` lists the same variables with comments. Keep `.env.local` out of Git.

## Operator scripts

The scripts read `.env.local` and write their output under `.cache/`.

```sh
node --env-file=.env.local --import tsx scripts/precompute.ts --repo react/react
node --env-file=.env.local --import tsx scripts/precompute.ts --repo react/react --publish
node --env-file=.env.local --import tsx scripts/admin.ts --remove owner/repository
node --env-file=.env.local --import tsx scripts/layout-report.ts
```

`precompute` analyzes a repository locally and, with `--publish`, writes the same Blob and Redis
objects as the web pipeline. A refresh reads repository metadata with the `gh` CLI and fetches the
default branch, so `gh` must be installed and authenticated; `--head <commit-sha>` instead runs a
pinned offline analysis on an existing clone under `.cache/repos/`. `admin` removes a repository and
its stored data. `layout-report` writes a layout comparison to `.cache/layout-comparison.md`.
`scripts/analyze.ts` analyzes one checkout, and `scripts/verify-workflow.ts` inspects a finished
workflow run.

## Project documents

- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)
- [Prior art](docs/prior-art.md)
- [Design system](DESIGN.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [License](LICENSE) and [third-party notices](NOTICE)
