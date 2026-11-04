# Sebastian

> _J.F. Sebastian built his automata by hand, then let them run on their own._

Hub-first automations-as-code for SmartThings. You write automations as typed TypeScript, Sebastian compiles them to the Rules API, lints them for **local execution on the hub**, deploys them with `plan`/`apply`, and verifies behaviour over SSE. See [`docs/PLAN.md`](docs/PLAN.md) and [`docs/platform-facts.md`](docs/platform-facts.md).

**Status: M0 (foundations).** The Worker, the token vault plus metered client, OAuth, Access validation and `seb whoami` / `budget` / `status` / `resume` are in place. The DSL, compiler, Workflows and StreamDO arrive in M1–M2.

## Layout

```
packages/st-types   SmartThings API types, rate-limit/402/429 helpers, ledger categories
packages/protocol   zod schemas for the Worker ⇄ CLI API
apps/worker         Hono Worker, InstallDO (token vault + stFetch + ledger), cron, D1 migrations
apps/cli            `seb` (talks only to the Worker, via Cloudflare Access)
docs/               PLAN, platform facts, ADRs
```

## Develop

```bash
pnpm install
pnpm check       # biome + st-host guard, typecheck, unit + Workers-runtime tests
```

## First deploy (PLAN §13)

1. **Cloudflare Zero Trust.** Add PocketID as a generic OIDC IdP and enable one-time PIN. Create an Access app for `sebastian.baltar.media` with policies for you, `seb-cli` and `seb-ci`. Put the team domain and AUD tag in `apps/worker/wrangler.jsonc` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`).
2. **D1.** Done: `sebastian` (`3b11b032-…`, ENAM) is created and wired into `wrangler.jsonc`. Migrations run on first deploy.
3. **SmartThings Developer Center.** Register an API Access App with redirect `https://sebastian.baltar.media/oauth/callback`, CORS domain `sebastian.baltar.media`, and the scopes in `ST_SCOPES`.
4. **Secrets:**

   ```bash
   cd apps/worker
   wrangler secret put ST_CLIENT_ID
   wrangler secret put ST_CLIENT_SECRET
   openssl rand -base64 32 | wrangler secret put DATA_KEY
   ```
5. **Deploy.** Run `pnpm --filter @sebastian/worker exec wrangler d1 migrations apply sebastian --remote && pnpm --filter @sebastian/worker deploy`, or let `deploy.yml` do it on merge to `main` (repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
6. **Install.** Open `https://sebastian.baltar.media/oauth/start` and pick the Bur Oak location.
7. **Check.** With `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` set: `pnpm --filter @sebastian/cli seb whoami`.

## Invariants

- `InstallDO.stFetch()` is the **only** path to SmartThings. `pnpm lint` fails if a SmartThings host appears elsewhere.
- CI never holds SmartThings credentials.
- Device IDs and automations live in the private `home` repo, never here.
