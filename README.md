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

Steps 4–9 are in order: SmartThings has to be able to reach `/st/lifecycle` before you confirm the target, and the target has to be confirmed before you install.

1. **Cloudflare Zero Trust.**
   - Add PocketID as a generic OIDC identity provider (redirect `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`), and enable one-time PIN as break-glass.
   - Create the main Access app as **self-hosted with a public hostname** `sebastian.baltar.media` and no path. Don't use a **Workers** destination: it applies to every path on the Worker and rejects WebSocket upgrades (ADR-004).
   - Policies: you (**Allow**), plus `seb-cli` and `seb-ci` (**Service Auth**; **Allow** doesn't work for service tokens).
   - Put the team domain and the app's AUD tag in `apps/worker/wrangler.jsonc` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`).
2. **Bot protection.** Turn off **Bot Fight Mode** for the zone (Security → Bots). It silently blocks SmartThings' CONFIRMATION requests, and on the Free plan it can't be exempted per path. On Pro and up, use Super Bot Fight Mode with a WAF **Skip** rule for `/st/lifecycle` instead.
3. **D1.** Done: `sebastian` (`3b11b032-…`, ENAM) is created and wired into `wrangler.jsonc`. Migrations run on first deploy.
4. **SmartThings app.**
   - Run `smartthings smartapps:create -O <default-org-id> -i infra/smartthings-app.yaml`. It sets `apiOnly.targetUrl`, which installs need even though the CLI calls it optional.
   - It prints the OAuth client ID and secret **once**: put them straight into Worker secrets (step 5). If they're lost, run `smartthings smartapps:oauth:generate <appId>`; don't recreate the app.
   - Set `ST_APP_ID` in `wrangler.jsonc` to the new app ID.
   - `ST_SCOPES` must be a subset of the registered `oauth.scope`, and must avoid the combinations noted in `wrangler.jsonc` that fail with `server_error`.
5. **Secrets:**

   ```bash
   cd apps/worker
   wrangler secret put ST_CLIENT_ID
   wrangler secret put ST_CLIENT_SECRET
   openssl rand -base64 32 | wrangler secret put DATA_KEY
   wrangler secret list   # all three must be listed
   ```
6. **Deploy.** Run `pnpm --filter @sebastian/worker exec wrangler d1 migrations apply sebastian --remote && pnpm --filter @sebastian/worker deploy`, or let `deploy.yml` do it on merge to `main` (repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the repo's default branch must be `main`).
7. **Lifecycle bypass.** Add a second Access app with **only** a public hostname: `sebastian.baltar.media`, path `st/lifecycle`, policy **Bypass / Everyone**. Don't add a Workers row: that would bypass Access for the whole Worker. Then check both of these from outside:

   ```bash
   # must be 302 to <team>.cloudflareaccess.com: Access still guards everything else
   curl -si https://sebastian.baltar.media/api/status | head -1
   # must be 200 {"pingData":{"challenge":"x"}}: SmartThings can reach the target
   curl -si -X POST https://sebastian.baltar.media/st/lifecycle -H 'content-type: application/json' \
     -d '{"lifecycle":"PING","pingData":{"challenge":"x"}}'
   ```
8. **Confirm the target.** With `wrangler tail sebastian` running, run `smartthings smartapps:confirm <appId>`. The tail should show `{"stLifecycle":"CONFIRMATION"}` and then `{"stConfirmation":200}`. `smartthings smartapps <appId> -j` should then report `targetStatus: CONFIRMED`; `register` returns 202 even when delivery fails.
9. **Install.** Open `https://sebastian.baltar.media/oauth/start` and pick the location. `?scope=a%20b` narrows the request to a subset of `ST_SCOPES`, for bisecting a `server_error`.
   - Every successful authorization creates a **new** install, even though the app is single-instance.
   - `smartthings installedapps` doesn't list `API_ONLY` installs. D1's `installs` table does; delete stale ones with `smartthings installedapps:delete <id>`.
10. **Check.** From the repo root on **Node ≥ 22.18** (the CLI runs its TypeScript directly), with `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` set: `pnpm --filter @sebastian/cli seb whoami`.

### Troubleshooting

| Symptom                                                                          | Cause                                                                               | Fix                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `seb`: `unauthenticated (HTTP 401)` with no detail                               | Request reached the Worker with no Access JWT, i.e. Access isn't guarding that path | Remove any Workers destination from the bypass app (step 7) |
| `seb`: `access_redirect`                                                         | Service token not accepted                                                          | Policy for `seb-cli` must be **Service Auth**               |
| `authorization_denied: server_error` after approving                             | Missing or unconfirmed target, or a scope combination SmartThings rejects           | Steps 4, 8; bisect with `/oauth/start?scope=…`              |
| `invalid_scope: unable to build scope from a+b+c`                                | Scopes joined with a literal `+`                                                    | Space-separated only (`%20`)                                |
| `smartapps:confirm` succeeds, nothing in `wrangler tail`, target stays `PENDING` | Bot Fight Mode or WAF blocked SmartThings                                           | Step 2                                                      |
| `create` fails: `app with this name already exists`                              | `appName` stays reserved after delete                                               | New UUID suffix on `appName`                                |

## Invariants

- `InstallDO.stFetch()` is the **only** path to SmartThings. `pnpm lint` fails if a SmartThings host appears elsewhere.
- CI never holds SmartThings credentials.
- Device IDs and automations live in the private `home` repo, never here.
