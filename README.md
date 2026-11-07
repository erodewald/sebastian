# Sebastian

> _J.F. Sebastian built his automata by hand, then let them run on their own._

Hub-first automations-as-code for SmartThings. You write automations as typed TypeScript, Sebastian compiles them to the Rules API, lints them for **local execution on the hub**, deploys them with `plan`/`apply`, and verifies behaviour over SSE. See [`docs/PLAN.md`](docs/PLAN.md) and [`docs/platform-facts.md`](docs/platform-facts.md).

**Status: M1 (vertical slice).** M0's Worker, token vault, metered client, OAuth and Access, plus: the DSL, the Rules compiler, a hub-aware locality linter, `seb pull` codegen, and `plan` / `apply` / `run` / `destroy` through an `ApplyWorkflow` that reads back where SmartThings actually runs each rule. Plus the web UI: a live console at the Worker's hostname (behind Access) that shows each rule's TypeScript, its compiled Rules JSON, and its runs lighting up from the SSE stream, hop by hop. The probe suite and verify mode are M2.

## Layout

```
packages/st-types   SmartThings API types, rate-limit/402/429 helpers, ledger categories
packages/protocol   zod schemas for the Worker ⇄ CLI API, canonical rule hash
packages/dsl        automation builder → plain AST; typed device/location handles
packages/compiler   AST → Rules API JSON; locality linter
apps/worker         Hono Worker, InstallDO (token vault + stFetch + ledger), ApplyWorkflow, StreamDO, cron, D1
apps/web            React + Vite console, served by the Worker as static assets
apps/cli            `seb` (talks only to the Worker, via Cloudflare Access)
docs/               PLAN, platform facts, ADRs
```

## Develop

```bash
pnpm install
pnpm check       # biome + st-host guard, typecheck, web build, unit + Workers-runtime tests
pnpm --filter @sebastian/web dev   # UI on demo data: http://localhost:5173/?demo
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
   wrangler secret put SENTRY_DSN   # optional: without it, Sentry reporting stays off
   wrangler secret list   # the first three must be listed
   ```
6. **Deploy.** Run `pnpm --filter @sebastian/worker exec wrangler d1 migrations apply sebastian --remote && pnpm --filter @sebastian/worker deploy`, or let `deploy.yml` do it on merge to `main` (repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus optional `SENTRY_AUTH_TOKEN` to upload source maps; the repo's default branch must be `main`).
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
   - Delete an install before re-testing an authorization at the same location; each new authorization after a delete gets a new installedAppId.
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

## Writing automations

Automations live in a separate, **private** home repo; device IDs never enter this one.

```bash
seb init ../home && cd ../home && git init          # once
export SEB_HOME=. CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… SEB_TOKEN=…
seb pull                                             # generated/home.generated.ts: typed devices + modes
```

One file per rule in `automations/`, default-exporting an automation:

```ts
// automations/pantry-light.ts
import { automation, sleep } from '@sebastian/dsl';
import { nookLight2, pantryDoor } from '../generated/home.generated.ts';

export default automation('Pantry light')
  .when(pantryDoor.contactSensor.contact.changesTo('open'))
  .do(nookLight2.switch.on(), sleep(300), nookLight2.switch.off());
```

```bash
seb plan     # compile, predict Local/Cloud/Unknown with reasons, diff against what's deployed
seb apply    # deploy via ApplyWorkflow; reports where SmartThings actually runs each rule
seb run pantry-light.ts   # execute it now
seb rules    # what's managed and where it runs
seb destroy --all
seb export   # write the location's automations (incl. ones edited in the web UI) to automations/
```

- **DSL:**
  - `.when()` takes a device or mode condition (it fires on the change) or `every.day(at('07:00'))` / `every.on(['Mon'], …)`.
  - `.onlyIf()` conditions never start the rule.
  - Actions: device commands, `sleep(s)`, `Home.mode.set('Night')`, `ifThen(cond, [...], [...])`, plus `.otherwise(...)`.
  - Unlock, open and disarm commands need `.allowDangerous('reason')`.
- **Locality:**
  - A rule is predicted **Local** only when every device runs on the same hub and every operation is known to run on the hub.
  - Mode conditions, time windows, sunrise/sunset and mode changes start as **Unknown** until the M2 probe suite measures them.
  - A rule mixing devices from two hubs is **Cloud**.
  - `apply` flags any rule whose actual location contradicts the prediction.

## People and locations (ADR-005)

- The first person to sign in is the admin. Admins connect SmartThings locations at `/oauth/start` (each one is a separate install of the same app).
- Switch locations with the picker in the top bar. Share one under the avatar → **People**: viewer (read and live view), editor (plan, apply, run), owner (manage people). New people must also be allowed by the Access policy.
- The CLI needs a personal token: avatar → **CLI tokens**, then `export SEB_TOKEN=…`. `seb locations` lists what you can reach; `SEB_INSTALL=<id>` picks one.

## Web UI

Open `https://sebastian.baltar.media/` (Access login). `?demo` shows a made-up home with simulated events; `?theme=light|dark` overrides the system theme.

- **Code** (top bar): write automations in the browser, with completions for your devices (imported automatically), the compiled Rules JSON and locality prediction as you type, then **Plan** and **Apply**. Sources are kept per location and autosaved; any apply, web or CLI, makes them exactly what was applied. `seb export` writes them to your home repo. Compiling happens in a sandboxed iframe (ADR-006).
- **Rules** (left): every managed rule, where SmartThings runs it, and the devices it uses with their latest values.
- **Flow**: WHEN → ONLY IF → DO, read back from the stored Rules JSON. A run lights it up: the trigger's device event opens the run, each command step turns green when the device reports the new value, sleeps count down.
- **Code**: the TypeScript next to the compiled Rules JSON. Hovering either highlights the matching flow step, and the other way round.
- **Trace**: one run as a waterfall: hub execution, SmartThings → Cloudflare, Cloudflare → tab, with sleeps drawn as axis breaks.
- **Hops / Events** (right): the device → hub → SmartThings → StreamDO → tab path with p50/p95, and the live event feed.

The feed is a WebSocket to `/api/stream`. StreamDO holds one SSE subscription, filtered to the devices in managed rules, only while a tab is open. SmartThings doesn't report rule executions, so a "run" is inferred from device events: a matching trigger event opens one, confirming events close its steps, and a step with no event within 20 s is marked as missed. Run source shows up after the next `seb apply`.

## Invariants

- `InstallDO.stFetch()` is the **only** path to SmartThings. `pnpm lint` fails if a SmartThings host appears elsewhere.
- CI never holds SmartThings credentials.
- Device IDs and automations live in the private `home` repo, never here.
