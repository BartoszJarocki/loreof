# Lore

Lore turns a public GitHub repository into a documentary you can play. A file shows up when the
history creates it. A later commit touches it, and it lights up. Delete the file and it fades. Each
chapter's caption points at commits that are actually in the record.

It's live at [loreof.vercel.app](https://loreof.vercel.app).

## Stack

I built Lore as a Next.js App Router app, and it runs on Vercel. Ask for a repository, and a Vercel
Workflow starts a Sandbox. The Sandbox clones that public repo without file blobs, reads the
first-parent history, lays the files out in 3D, and cuts the history into chapters. Each chapter
comes with a fact sheet. A model on AI Gateway picks landmark commits from that sheet. The validator
throws out a pick that isn't on the sheet.

The snapshot stored in private Blob is gzip JSON. It doesn't change after that. A manifest goes into
Upstash Redis, and the files and commits stay out of it. The repository page renders the chapters
from that manifest. The browser then streams three parts of the artifact into a three.js point
cloud. `map` and `touches` are binary. `paths` is JSON. See
[docs/architecture.md](docs/architecture.md).

## Run the checks

You'll want Node.js 24, the version in `.nvmrc`, and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript, ESLint, the unit tests, and the formatting check. It doesn't need
credentials. A test that wants Redis or Blob skips when those variables aren't set.

```sh
pnpm build
```

The build bundles the Sandbox worker and the runner before Next builds the app.

Dependabot opens grouped npm minor and patch updates every week, and GitHub Actions updates every
month. I left major `@types/node` upgrades out. Those types follow the runtime version in `.nvmrc`.

## Run the Redis-backed tests

`compose.yaml` starts Redis and an Upstash-compatible HTTP bridge, with the same images the CI
workflow uses. The bridge listens on port 8104. CI uses 8079.

```sh
docker compose up -d
KV_REST_API_URL=http://127.0.0.1:8104 KV_REST_API_TOKEN=lore-ci pnpm test
docker compose down
```

The integration suite also needs a private Vercel Blob store. Use a dedicated test store. Don't
point it at production.

```sh
KV_REST_API_URL=http://127.0.0.1:8104 \
KV_REST_API_TOKEN=lore-ci \
BLOB_READ_WRITE_TOKEN=... \
pnpm test:integration
```

The integration command fails if any test is skipped, pending, or cancelled.

## Run the browser tests

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:browser
```

That runs the fixture-backed specs in both the desktop and mobile projects. It doesn't need a
server. The collection, viewer, and theater specs read production gallery data, so they stay skipped
unless you set `LORE_LIVE_BROWSER=1`. To run them, start an app with the seeded gallery and point
the tests at it.

```sh
LORE_LIVE_BROWSER=1 LORE_TEST_URL=http://127.0.0.1:3000 pnpm test:browser
```

The theater flare check and the viewer artifact check also compare the page with the snapshot JSON.
Set `LORE_SNAPSHOT_JSON_DIR` to a directory of published snapshot files, such as the
`.cache/gallery` that `precompute` writes. Those two checks skip without it.

See [docs/testing.md](docs/testing.md) for the suites and what each one needs.

## Security

Every response carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a permissions policy that denies camera,
microphone, and geolocation (`next.config.ts`). A mutating route accepts a request only when BotID
reports that it isn't a bot. Report a vulnerability the way [SECURITY.md](SECURITY.md) describes.

## Self-host on Vercel

1. Import the repository into your own Vercel account.
2. Create an Upstash Redis database and set `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the
   `UPSTASH_REDIS_REST_*` aliases).
3. Create a private Vercel Blob store and set `BLOB_READ_WRITE_TOKEN`.
4. Enable AI Gateway. On Vercel, `VERCEL_OIDC_TOKEN` authenticates model calls and Sandbox. Don't
   create it, and don't paste it.
5. Set the rest of the variables in the table below. `NEXT_PUBLIC_SITE_URL` is your canonical
   origin. It defaults to the Vercel production URL, and locally to `http://localhost:3000`.
6. Deploy. The hourly cron at `/api/cron/checkpoints` authenticates with `CRON_SECRET` and removes
   expired analysis checkpoints.

| Variable                   | Required | Purpose                                                                   |
| -------------------------- | -------- | ------------------------------------------------------------------------- |
| `KV_REST_API_URL`          | Yes      | Upstash Redis REST endpoint.                                              |
| `KV_REST_API_TOKEN`        | Yes      | Upstash Redis REST token.                                                 |
| `UPSTASH_REDIS_REST_URL`   | Alias    | Alternative name for the Redis endpoint.                                  |
| `UPSTASH_REDIS_REST_TOKEN` | Alias    | Alternative name for the Redis token.                                     |
| `BLOB_READ_WRITE_TOKEN`    | Yes      | Private Blob store for artifacts and checkpoints.                         |
| `LORE_IP_SALT`             | Yes      | Salt for hashed visitor IPs in admission limits.                          |
| `CRON_SECRET`              | Yes*     | Authenticates the hourly checkpoint cleanup cron.                         |
| `NEXT_PUBLIC_SITE_URL`     | Yes*     | Canonical origin for links and share images.                              |
| `AI_GATEWAY_API_KEY`       | No       | Local or non-Vercel Gateway authentication.                               |
| `VERCEL_OIDC_TOKEN`        | Vercel   | Provided by Vercel at runtime. Never set it.                              |
| `GITHUB_TOKEN`             | No       | Raises GitHub REST rate limits for repository metadata.                   |
| `LORE_REDIS_PREFIX`        | No       | Namespace for Redis keys. Defaults to `lore:v1`.                          |
| `LORE_BLOB_PREFIX`         | No       | Blob path prefix. It must start with a letter or digit and end with `/`.  |
| `LORE_MODEL`               | No       | Gateway model ID. Defaults to `anthropic/claude-sonnet-5.5`.              |
| `LORE_AI_MONTHLY_USD`      | No       | Monthly narration budget cap, in US dollars. Defaults to 20.              |
| `LORE_DAILY_LIMIT`         | No       | Daily admission limit. Defaults to 10.                                    |
| `LORE_MONTHLY_LIMIT`       | No       | Monthly admission limit. Defaults to 100.                                 |
| `LORE_IP_DAILY_LIMIT`      | No       | Daily submissions per IPv4 address and per IPv6 /64 block. Defaults to 3. |
| `LORE_CONCURRENT_LIMIT`    | No       | Concurrent analysis limit. Defaults to 2.                                 |

\* Required in production. Without `CRON_SECRET` the cleanup route refuses to run. Without
`NEXT_PUBLIC_SITE_URL` the site uses the Vercel production hostname, or `http://localhost:3000`
locally.

`.env.example` lists the same variables, with comments. Keep `.env.local` out of Git.

## Operator scripts

The commands below load `.env.local`. Analysis output goes under `.cache/`.

```sh
node --env-file=.env.local --import tsx scripts/precompute.ts --repo react/react
node --env-file=.env.local --import tsx scripts/precompute.ts --repo react/react --publish
node --env-file=.env.local --import tsx scripts/admin.ts --remove owner/repository
node --env-file=.env.local --import tsx scripts/layout-report.ts
```

`precompute` analyzes a repository on your machine. Pass `--publish` and it writes the same Blob and
Redis objects the web pipeline writes. A refresh reads repository metadata with the `gh` CLI and
fetches the default branch, so `gh` has to be installed and authenticated. `--head <commit-sha>`
runs a pinned analysis on a clone that already sits under `.cache/repos/`. It won't publish. `admin`
removes a repository and its stored data. It doesn't write a file under `.cache/`. `layout-report`
writes a layout comparison to `.cache/layout-comparison.md`. `scripts/analyze.ts` analyzes one
checkout. `scripts/verify-workflow.ts` inspects a finished workflow run.

## Project documents

- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)
- [Prior art](docs/prior-art.md)
- [Design system](DESIGN.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [License](LICENSE) and [third-party notices](NOTICE)
