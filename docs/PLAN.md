# Sebastian — hub-first automations-as-code for SmartThings

> _J.F. Sebastian built his automata by hand, then let them run on their own._

**Status:** Plan v3.1 · 2026-11-04 — ready to build (v2 reviewed; v3 = Cloudflare-native; v3.1 = open questions resolved)
**Platform:** SmartThings API Access App on the Developer Plan (OAuth, 100k cloud calls/mo, 10 installs, SSE + Rules included)
**Runs on:** Cloudflare at **`sebastian.baltar.media`**, behind Cloudflare Access with PocketID.

- **Core:** Workers, Durable Objects, D1, Workflows, Access.
- **Added only when they earn a place** (§5.0): Queues, R2, KV, Analytics Engine, AI Gateway, Containers.
  **Hub:** "Bur Oak", a Samsung SmartThings Hub 2015 (v2). A Hue Bridge exists but is out of scope. Matter and Thread are out of scope by choice.
  **Companion:** `docs/platform-facts.md`

---

## 1. The idea

Sebastian is a Terraform-style tool for SmartThings automations:

- You write automations as typed TypeScript in a private git repo.
- Sebastian compiles them to **Rules API** JSON and lints them for **local execution on the hub**.
- It deploys them with `plan` / `apply` (from your laptop, or from GitHub on merge).
- It reads back the platform's real `executionLocation` and verifies behavior over **SSE**.

**Headline:** _Automations cost zero API calls. Local ones survive outages of the internet, the homelab, and HA. Observability is opt-in and metered._

**Relationship to Home Assistant:** Sebastian is the **fail-safe tier**, not a second brain. HA stays primary. Sebastian owns the few automations that must work when HA or the homelab is down (leak → shutoff, entry lights, night mode, smoke → lights). A **device-ownership manifest** keeps HA and hub rules from fighting over the same device.

Hosting on Cloudflare strengthens this. The tooling (deploy, verify, ledger) also survives a homelab outage. The only homelab dependency is PocketID login, and a one-time PIN login covers that as break-glass (§5.2).

**Platform showcase:** the **locality probe suite** auto-deploys a micro-rule for each pairing of integration type and operation, then records the reported `executionLocation` into a published matrix. SmartThings doesn't publish this fact sheet, and it is what powers the linter.

## 2. How we picked it

| #     | Concept                              | Platform breadth | Paid-API fit | Useful to Eric | Novel vs HA | Buildable (~6 wks evenings) | /25    |
| ----- | ------------------------------------ | ---------------- | ------------ | -------------- | ----------- | --------------------------- | ------ |
| **A** | **Hub-first automations-as-code**    | 5                | 5            | 4              | 5           | 4                           | **23** |
| B     | Appliance + TOU energy concierge     | 3                | 3            | 4              | 2           | 4                           | 16     |
| C     | Home flight recorder / health digest | 3                | 4            | 3              | 1           | 5                           | 16     |
| D     | SmartThings MCP server for Claude    | 4                | 2            | 3              | 2           | 5                           | 16     |
| E     | Guest/rental mode orchestrator       | 3                | 3            | 2              | 3           | 3                           | 14     |

A absorbs C (as a narrow verify recorder) and D (as an optional MCP front-end on Workers, behind `plan` / `apply` approval).

**Changes from v2:**

- Hosting moved from a homelab LXC to Cloudflare.
- The SSE consumer is now a Durable Object.
- Token vault and quota ledger are Durable Objects, which serialize work by design and so give single-flight token refresh for free.
- `apply` and `probe` became Workflows.
- GitOps deploy runs from GitHub Actions.
- The whole hostname sits behind Access, so nothing is public.

## 3. Features (by phase)

**v1 (core, ~6 weeks)**

1. **`seb pull` + typed codegen.** Typed device bindings come from the capability model (capability definitions cached in a D1 table, keyed by id + version).
2. **Automations as code.** One file per rule in `home/automations/`, written in a DSL that maps 1:1 onto Rules grammar.
3. **Locality linter.** Predicts ✅ Local or ☁️ Cloud and names the device or operation responsible. It uses the probe matrix and is conservative where data is missing.
4. **`plan` / `apply` / `destroy`.** `plan` diffs against the managed-rule registry. `apply` runs as a Workflow (one step per rule, then readback of `executionLocation`); a mismatch is flagged and fed back into the matrix.
5. **GitOps.** A PR to the private `home` repo gets a `seb plan` comment; merging to `main` runs `seb apply`. CI authenticates with an Access service token and never holds SmartThings credentials.
6. **`seb run <rule>`.** Calls `POST /rules/execute/{id}` (per-action results) as a smoke test.
7. **Drift detection.** A weekly cron flags managed rules that were changed or deleted outside `apply`.
8. **Verify mode.** A narrow SSE consumer watches the devices that managed rules touch, measures trigger → effect latency, and shows gaps honestly.
9. **Budget ledger.** Every SmartThings call is metered by category, with daily and storm breakers. Daily counts live in InstallDO; rollups go to D1.
10. **Locality probe suite.** `seb probe` runs a Workflow and writes `docs/locality-matrix.md`, tagged with hub model and firmware.

**v2 (stretch, pick one or two)**

- **Web UI** (Workers static assets): explorer, rule list with locality badges, live verify view over WebSocket, and budget.
- **MCP server on Workers** (Agents SDK `McpAgent`, behind Access): read tools, `draft_automation`, and `plan`. `apply` requires human approval in the UI.
- **Natural-language authoring:** goes through **AI Gateway** to Claude, with Gateway logging and a spend cap.
- **HA → flag bridge:** HA flips hub-local virtual switches; hub rules react.
- **Edge driver (Lua)** with a custom capability for a local enum state machine (the hub equivalent of `input_select`).
- **Location operands** (security arm state, weather).

## 4. Platform coverage map

### SmartThings

| Surface                                                                  | Used for                                                           | Phase |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| API Access App: OAuth 2.0, scopes, rotating refresh tokens               | Install, token lifecycle                                           | M0    |
| Locations, rooms, modes, hubs                                            | Codegen; `mode.is()`; `mode.set()`; hub model/firmware in `whoami` | M0–M1 |
| Devices (`includeStatus`, `includeHealth`), components, capabilities     | Codegen, command validation, reconcile                             | M1    |
| Rules API: create / update / delete / execute + `executionLocation`      | Deploy target, verification, probe matrix                          | M0–M1 |
| Scenes API (`x:scenes`)                                                  | CLI execution; scene actions _inside_ rules are an M2 spike        | M2    |
| Hub-local virtual switches (stock Virtual Switch Edge driver on Bur Oak) | Local flags; probe fixtures                                        | M2    |
| SSE (DEVICE_EVENT, DEVICE_HEALTH_EVENT, MODE_EVENT, lifecycle)           | Verify mode, drift hints                                           | M2    |
| Rate-limit headers; 429 / 402 semantics                                  | Backoff; halt on 402                                               | M0    |
| Developer Center API Dashboard                                           | Cross-check of the ledger                                          | M3    |
| Edge driver + custom capability                                          | Local state machine                                                | v2    |

Webhooks are not used. SSE means nothing has to accept inbound calls from SmartThings.

### Cloudflare

| Product                             | Role                                                                                                                  | Tier                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Workers** (Hono)                  | API, OAuth callback, static UI, cron handlers                                                                         | Core (M0)                                                                     |
| **Durable Objects** (SQLite-backed) | `InstallDO` (token vault + metered client + ledger, one per install); `StreamDO` (SSE supervisor + WebSocket fan-out) | Core (M0/M2)                                                                  |
| **D1**                              | Managed-rule registry, devices, capability cache, probe results, events (30-day), ledger rollups                      | Core (M0)                                                                     |
| **Workflows**                       | `ApplyWorkflow` and `ProbeWorkflow` (durable steps, retries, `step.sleep` for readback and settle times)              | Core (M1/M2)                                                                  |
| **Access** (Zero Trust)             | PocketID as generic OIDC IdP; one-time PIN as break-glass; service tokens for CLI and CI                              | Core (M0)                                                                     |
| **Cron Triggers**                   | Token health; retention; weekly drift check; quota projection                                                         | Core (M0+)                                                                    |
| **Worker secrets**                  | ST client ID/secret, AES-GCM data key                                                                                 | Core (M0)                                                                     |
| **Workers Logs / Tail**             | Ops visibility                                                                                                        | Core                                                                          |
| **R2**                              | Per-apply audit snapshots; event archive beyond 30 days                                                               | Add if you want history past D1 Time Travel                                   |
| **Analytics Engine**                | Ledger and latency time series                                                                                        | Add with the v2 web UI's budget charts                                        |
| **Queues**                          | Decouple StreamDO from D1 writes                                                                                      | Add only if event volume makes direct batched writes a problem (not expected) |
| **KV**                              | Capability cache                                                                                                      | Skip: a D1 table does the job at this scale                                   |
| **AI Gateway**                      | Claude calls for NL authoring                                                                                         | v2                                                                            |
| **Containers**                      | SSE consumer fallback                                                                                                 | Only if ADR-001 flips                                                         |

## 5. Architecture

### 5.0 Hosting review: is Cloudflare the right call?

**Verdict: yes, with two corrections.**

**What's strong**

- The deploy and verify tooling lives off-premises. It survives homelab outages, which is exactly the failure the fail-safe tier exists for.
- Durable Objects are a natural fit for the riskiest logic. They run one request at a time, so you get a single token owner and atomic quota breakers.
- Workflows fit `apply` and `probe` well, since those are multi-step and need sleeps between steps.
- Access lets the whole hostname stay private with no tunnel.
- The runtime path is hub-local regardless of where the tooling runs.
- Cost is about $5/mo (Workers Paid) on top of the $4.99 Developer Plan.

**Correction 1: don't adopt the full suite for its own sake.**

- This is a single-user app with a few dozen rules and a low event rate. Queues, KV, R2, and Analytics Engine would each add a binding, a failure mode, and test surface without solving a problem v1 has.
- v1 runs on Workers + DOs + D1 + Workflows + Access. Everything else is listed in §4 with the trigger that would justify adding it.
- If showcasing Cloudflare is a goal in its own right, say so. Then they're v2 learning items, not v1 dependencies.

**Correction 2: PocketID turns a cloud app back into a homelab dependency.**

- **Login dependency:** Access must reach PocketID, so you can't log in to the UI or CLI when the homelab is down. OTP break-glass covers this.
- **Exposure:** resolved. PocketID is already public with trusted TLS, so this adds no new attack surface.
- **Decision:** PocketID is the primary IdP, with OTP as break-glass.

**Remaining weak spot: SSE in a Durable Object.**

- It works, but it fights the platform: the 15-minute pending-I/O cap, a 60 s watchdog alarm that keeps the object resident and billed around the clock, and dropped streams on every deploy.
- That's acceptable because verify mode is opt-in and gaps get reconciled. A Container fallback is pre-planned in ADR-001.
- If you'd rather not run it continuously, use windowed verify (`seb verify --for 2h`). Then nothing is resident between runs.

```
  browser ──┐                         ┌──────────────── Cloudflare ────────────────────────────┐
  seb CLI ──┼─▶ Access (PocketID OIDC │  Worker: sebastian.baltar.media (Hono)                  │
  GH Action ┘   / service tokens) ───▶│   ├─ /oauth/callback → InstallDO.completeAuth()         │
                                      │   ├─ /api/* (verifies Cf-Access-Jwt-Assertion)          │
                                      │   ├─ static UI (v2)                                     │
                                      │   ├─ cron: token health · retention · drift · projection│
                                      │   └─ latency correlation (StreamDO batches → D1)        │
                                      │                                                         │
                                      │  InstallDO (one per installedAppId)                     │
                                      │   ├─ token vault (DO SQLite, AES-GCM)                   │
                                      │   ├─ stFetch(): the ONLY path to api.smartthings.com    │
                                      │   └─ ledger counters + breakers ─▶ D1 rollups           │
                                      │  StreamDO ── outbound SSE ◀── api.smartthings.com       │
                                      │   └─ WebSocket hibernation fan-out (seb tail, UI)       │
                                      │  ApplyWorkflow / ProbeWorkflow ─▶ InstallDO RPC          │
                                      │  D1 · Worker secrets                                    │
                                      └──────────────────────────┬──────────────────────────────┘
                                                                 │ Rules JSON
                                                                 ▼
                                             SmartThings cloud ─▶ Bur Oak hub (local execution)
```

### 5.1 Key design decisions

- **InstallDO is the single token owner.** A Durable Object runs one request at a time, which removes the refresh-token race the v2 review flagged (§5.1 of v2).
  - Refresh runs inside `blockConcurrencyWhile`.
  - The new refresh token is written to DO storage _before_ the new access token is used.
  - A refresh that fails with `invalid_grant` puts the install into `NEEDS_REAUTH` and alerts you; it does not retry.
  - Every SmartThings call from any Worker, Workflow, or the StreamDO goes through `InstallDO.stFetch()` by RPC. A lint rule bans raw `fetch` to smartthings.com anywhere else, so nothing escapes the ledger.
- **StreamDO keeps the SSE connection alive.** An open outbound `fetch()` keeps a Durable Object in memory, but only for 15 minutes per operation. After that, normal eviction rules apply.
  - An **alarm every 60 s** acts as watchdog and heartbeat. Each alarm is an incoming event, so the DO stays resident. The alarm also checks stall timers and renews the subscription early when the TTL nears.
  - Cost is roughly one always-resident DO, well within Workers Paid allowances. It's still recorded in ADR-001.
  - **Deploys and platform restarts will drop the stream.** That's a normal "unexpected drop": reconnect, then reconcile. This is already part of the design because SSE has no replay.
  - **Fallback (ADR-001):** if DO-hosted SSE proves flaky in M2, move only the stream consumer into a **Cloudflare Container** (Node) bound to StreamDO. Everything else stays the same.
- **Apply and probe are Workflows.**
  - Each rule is its own durable step: compile hash check → `POST/PUT /rules` → `step.sleep('settle', '5s')` → `GET /rules/{id}` for `executionLocation` → write the D1 registry row, including compiled JSON (the audit trail).
  - A failure partway resumes rather than leaving the account half-applied.
  - The probe workflow deploys a micro-rule, sleeps, reads back, deletes, and records the result. It's paced to stay under 20 calls/min on the rules endpoints.
- **Two storage tiers.** Hot, strongly consistent state lives in DO SQLite: tokens, ledger counters, stream state, subscription IDs. Queryable history lives in D1, with Time Travel for recovery.
- **Compilation happens client-side.** The `seb` CLI (local or in CI) compiles DSL → `RuleRequest` JSON, then sends the compiled rules with source hashes to `/api/plan` or `/api/apply`. The Worker never executes your automation code, so the deployed service stays small and generic.

### 5.2 Auth & access

- **Access application:** `sebastian.baltar.media/*`, deny by default.
- **Policies:**
  - Allow your PocketID identity (by email or `sub`).
  - Allow two service tokens: `seb-cli` and `seb-ci`.
  - Enable one-time PIN to your email as a **break-glass** IdP, for when the homelab (and therefore PocketID) is down.
- **PocketID** must be reachable from the internet over trusted TLS, because Access calls its token and JWKS endpoints. The redirect URI to register in PocketID is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
- **The Worker validates the `Cf-Access-Jwt-Assertion` on every request** against the team JWKS and the application's AUD tag, as defense in depth.
- **SmartThings OAuth redirect:** `https://sebastian.baltar.media/oauth/callback`. It stays behind Access, since your browser already holds the Access session when SmartThings redirects back. Register `sebastian.baltar.media` as the app's CORS domain.
- **The OAuth `state`** is a signed, single-use nonce held in InstallDO with a 10-minute TTL.
- **Nothing on the hostname is public**, and no inbound endpoint is reachable by SmartThings.

### 5.3 Restore & recovery runbook

- **D1:** use Time Travel (30-day point-in-time restore).
- **Tokens in DO storage:** these are not restorable by design. If they're lost or invalid, the install goes to `NEEDS_REAUTH`. Re-authorize, then run `seb apply`.
- **Rules:** they live in git, so a reinstall that changes `installedAppId` costs one apply. Whether an uninstall deletes or orphans the old app-owned rules is spike R3.
- **Kill switch:** `seb destroy --all` deletes every managed rule.

### 5.4 Repos & layout (pnpm workspaces, TS strict, Biome, Vitest)

```
sebastian/                         ← can be public; built from public docs only
├─ packages/
│  ├─ dsl/          builder API (pure)
│  ├─ compiler/     DSL → RuleRequest (core-sdk types), locality linter
│  ├─ st-types/     shared API types, rate-limit/402/429 helpers
│  └─ protocol/     zod schemas for the Worker API (plan/apply/probe payloads)
├─ apps/
│  ├─ worker/       Hono app, InstallDO, StreamDO, Workflows, cron handlers
│  │  ├─ migrations/   D1 SQL migrations
│  │  └─ wrangler.jsonc
│  ├─ cli/          `seb` (pull, lint, plan, apply, destroy, run, probe, tail, budget, whoami)
│  └─ web/          (v2) React/Vite → Workers static assets
├─ docs/            PLAN.md, platform-facts.md, ADRs, locality-matrix.md
└─ .github/workflows/  ci.yml (lint/typecheck/test), deploy.yml (wrangler deploy + d1 migrations)

home/                              ← ALWAYS private repo
├─ generated/home.generated.ts     device IDs, labels, rooms, mode IDs
├─ automations/*.ts
├─ ownership.yaml                  device → owner (ha | hub)
└─ .github/workflows/gitops.yml    PR → seb plan comment; main → seb apply
```

### 5.5 Data

**InstallDO SQLite**

- `tokens(access_enc, refresh_enc, access_exp, refresh_exp, rotated_at, state)`
- `oauth_states(nonce, expires_at)`
- `ledger_day(day, category, count)`
- `breakers(name, tripped_at, reason)`

**StreamDO SQLite**

- `subscriptions(subscription_id, created_at, activated_at, closed_at, close_reason)`: written _before_ activation, so orphans are deleted on startup.
- `stream_state(epoch, last_welcome_at, keepalive_p95_ms)`

**D1**

- `installs(installed_app_id, location_id, hub_id, hub_model, hub_fw, scopes, created_at)`
- `devices(device_id, location_id, room_id, label, integration_type, driver_id, hub_id, profile_json, updated_at)`
- `rules_managed(rule_id, installed_app_id, source_path, source_hash, compiled_hash, predicted_loc, actual_loc, applied_at, compiled_json)`
- `capabilities(capability_id, version, definition_json, fetched_at)`: immutable cache, replaces KV
- `probe_results(integration_type, operation, execution_location, hub_model, hub_fw, observed_at)`
- `events(event_id UNIQUE, event_time, received_at, type, device_id, capability, attribute, value_json, state_change, epoch)`: kept 30 days, then deleted (add an R2 archive only if you want longer history).
- `latency(rule_id, trigger_event_id, effect_event_id, delta_ms)`
- `calls_daily(day, category, route_template, count, errors)`: rolled up from InstallDO

## 6. The DSL and Rules grammar

```ts
// home/automations/evening-entry-lights.ts
import { automation, mode, between, sunset, at } from '@sebastian/dsl';
import { Devices } from '../generated/home.generated';

export default automation('Evening entry lights')
  .when(Devices.frontDoor.contactSensor.contact.changesTo('open'))
  .onlyIf(mode.is('Evening'), between(sunset(), at('23:00')))
  .then(Devices.foyerLights.switchLevel.setLevel(60));
```

This compiles to the following (checked against core-sdk `RuleRequest` types and the Rules docs; a real POST in M1 is the final check):

```json
{
  "name": "[seb] Evening entry lights",
  "timeZoneId": "America/Chicago",
  "actions": [
    {
      "if": {
        "and": [
          {
            "changes": {
              "equals": {
                "left": {
                  "device": {
                    "devices": ["<frontDoorId>"],
                    "component": "main",
                    "capability": "contactSensor",
                    "attribute": "contact"
                  }
                },
                "right": { "string": "open" }
              }
            }
          },
          {
            "equals": {
              "left": { "location": { "attribute": "Mode", "trigger": "Never" } },
              "right": { "string": "<eveningModeId>" }
            }
          },
          {
            "between": {
              "value": { "time": { "reference": "Now", "trigger": "Never" } },
              "start": { "time": { "reference": "Sunset" } },
              "end": {
                "time": {
                  "reference": "Midnight",
                  "offset": { "value": { "integer": 1380 }, "unit": "Minute" }
                }
              }
            }
          }
        ],
        "then": [
          {
            "command": {
              "devices": ["<foyerId>"],
              "commands": [
                {
                  "component": "main",
                  "capability": "switchLevel",
                  "command": "setLevel",
                  "arguments": [{ "integer": 60 }]
                }
              ]
            }
          }
        ]
      }
    }
  ]
}
```

**Compiler rules**

- `.onlyIf()` conditions compile with `"trigger": "Never"`, so only the `.when()` operand starts the rule.
- Threshold triggers are wrapped in `changes{…}`, so they fire when the threshold is crossed.
- Times are `Midnight + N` minutes, with no negative offsets. Every rule sets `timeZoneId`. Windows that cross midnight get dedicated golden tests.
- `mode.set()` emits `{"location": {"locationId": …, "mode": …}}`.
- `every()` takes `interval` or `specific` (time + `daysOfWeek`) only; there's no cron syntax.
- `remains` / `was` are allowed but lint as ☁️ unless the matrix says otherwise.
  - The suggested local rewrite (`changesTo` → `sleep` → `if` re-check) is labeled **"not equivalent"**.
- **DSL v1 actions:** `command`, `sleep`, `if/else`, `mode.set`, `flag().on/off`. Scene actions inside rules wait on the M2 spike.
- **Safety:**
  - `lock.unlock`, `doorControl.open`, and `securitySystem.disarm` require `.allowDangerous('reason')`.
  - `ownership.yaml` blocks rules on HA-owned devices.
  - The rules guardrail is 50 per installed app; the linter warns at 40.

## 7. Quota design (SmartThings)

100,000 calls/month is about 3,225/day. **The quota is shared across every OAuth app on the developer account**, including an HA SmartThings integration registered under it.

**Monthly cost model:**

- monthly ≈ renewals + reconciles + deploy + model + interactive + probe
- renewals ≈ (30 × 1440 / TTL_min) × 2
- reconciles ≈ unexpected drops × pages, capped at 1 per 15 minutes

| SSE TTL | Renewals/mo | Reconcile                | Other  | Total | %                               |
| ------- | ----------- | ------------------------ | ------ | ----- | ------------------------------- |
| 60 min  | ~1,440      | ~300 typical, ≤2,900 cap | ~3,000 | ~4.7k | ~5%                             |
| 15 min  | ~5,760      | same                     | ~3,000 | ~9k   | ~9%                             |
| 5 min   | ~17,300     | same                     | ~3,000 | ~20k  | ~20% → switch to verify windows |

**Cloudflare adds:** Worker deploys and DO restarts count as unexpected drops. At ~5 deploys/day, that's about 150 extra reconciles a month, each 1–2 calls. It's negligible, and the 15-minute cap bounds it anyway.

**Reconcile** = `GET /devices?deviceId=…&includeStatus=true&includeHealth=true`, limited to the devices that managed rules touch. A clean `goodbye` rollover skips reconcile entirely.

**Guardrails** (enforced in InstallDO, so they are atomic):

- **Daily breaker:** when spend passes 1/30 of the remaining monthly budget, `interactive` and `probe` calls pause.
- **Storm breaker:** at most 6 subscription creates per hour.
- **402:** halts _all_ calls until a manual `seb resume`.
- **429:** back off on `x-ratelimit-reset`, parsed defensively, with ±20% jitter.
- **Categories:** `auth`, `deploy`, `verify`, `reconcile`, `model`, `probe`, `interactive`, `test`.

## 8. StreamDO (verify-mode SSE supervisor)

**States:** `IDLE → CREATING → (persist id) → ACTIVATING ≤60s → STREAMING → {goodbye → CREATING | drop/stall/restart → RECONCILING → CREATING}`.

- **Startup (constructor):** DELETE any persisted subscription IDs that aren't closed, then start the stream if verify mode is enabled.
- **Filters:** one subscription with `DEVICEIDS` filters for the devices managed rules touch, plus `MODE_EVENT`. Event types are always explicit. The second allowed subscription slot is reserved for make-before-break when filters change.
- **Event handling:** dedupe by `deviceEvent.eventId`. `stateChange` drives latency correlation. Events are batched directly into D1 (≤100 rows or every 2 s, `INSERT OR IGNORE` on `event_id`). A Queue goes in front only if write volume ever requires it.
- **Stall detection:** the timeout is 3× the p95 keepalive interval, measured over the first week. Until then, assume 120 s.
- **Fan-out:** `seb tail` and the UI connect over WebSocket with the hibernation API. There is only one SSE connection per token, so the DO fans out.
- **Modes:**
  - `continuous`, the default in M2 while measuring.
  - `windowed`: `seb verify --for 2h`, or a cron schedule. Use this if SSE events turn out to count toward quota (R1) or the TTL is short.
- **M2 spikes:**
  - Does the stream survive an access-token refresh? (InstallDO refreshes; StreamDO's open connection uses the old bearer.)
  - What is the real TTL distribution?
  - How does a DO-hosted stream behave across a deploy?

## 9. Milestones

| Milestone                                      | Scope                                                                                                                                                                                                                                                                               | Exit criteria                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 · Foundations** (wk 1)                    | Cloudflare setup (zone, Access + PocketID IdP + OTP + service tokens, D1, secrets); register the ST app with **all scopes**; Worker skeleton, InstallDO vault + `stFetch` + ledger, `/oauth/callback`; `seb whoami` (hub model and firmware); CI and deploy pipelines; **R3 spike** | Login works via PocketID _and_ OTP; tokens auto-refresh across 72 h; every call shows in the ledger; R3 answered                                                                                                    |
| **M1 · Vertical slice** (wk 1–2)               | Minimal DSL → compile → `/api/plan` → `ApplyWorkflow` → readback → `seb run` / `destroy`; codegen with the D1 capability cache                                                                                                                                                      | One real automation on Bur Oak, deployed from git, running locally, with predicted locality matching actual                                                                                                         |
| **M2 · Probe + flags + verify** (wk 2–4)       | Hub-local virtual switches (CLI-created once); `ProbeWorkflow` + matrix; matrix-driven linter; scene-in-rule spike; StreamDO → D1 events; latency                                                                                                                                   | Matrix covers each integration type on Bur Oak × ~10 operations; StreamDO runs 7 days with every drop reconciled; TTL, keepalive, and deploy-drop behavior measured; ADR-001 confirmed (DO) or switched (Container) |
| **M3 · DSL v1 + GitOps + guardrails** (wk 4–6) | Full v1 DSL, safety rules, `ownership.yaml`, drift cron, breakers, 402/429, `seb budget`, `home` repo GitOps, retention/archive cron, ADRs, README                                                                                                                                  | 5 fail-safe automations live via merged PRs; drift caught on an out-of-band delete; 14-day projection < 15% of quota; ledger vs API Dashboard delta recorded (R1 answered)                                          |
| **v2**                                         | Pick from §3                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                   |

**Suggested first five fail-safe automations** (pick from what's on Bur Oak):

1. Leak → valve/siren
2. Entry door → entry lights at night
3. Night mode → lights off + lock check
4. Smoke/CO → lights full
5. HA heartbeat: HA toggles a hub-local flag on a schedule; if the toggles stop, a hub rule notifies you or enables backup behavior. This needs a spike.

## 10. Testing

- **Unit (Vitest):** compiler golden files, linter, ledger math, StreamDO state machine against a fake SSE server (goodbye, stall, 403, 418, 429, duplicates, reordering).
- **Workers runtime (`@cloudflare/vitest-pool-workers`):** InstallDO refresh single-flight and persist-before-use; Workflow step retries; idempotent event inserts; Access JWT validation.
- **Lab:** a **"Sebastian Lab" room** in the home location with hub-local virtual switches and dimmers on Bur Oak, driven by commands. Integration tests run locally, are tagged `test` in the ledger, and never run in CI.
- **CI:** lint, typecheck, unit and Workers-pool tests; `wrangler deploy` and `d1 migrations apply` on `main`. CI holds only the Cloudflare API token and Access service tokens, never SmartThings credentials.

## 11. Risks & spikes

| #   | Unknown                                                                                                                                                                                                                                                                      | Spike / mitigation                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Do SSE events count toward the quota?                                                                                                                                                                                                                                        | Compare ledger to API Dashboard after 24 h; fall back to windowed verify                                                                                                                          |
| R2  | SSE TTL / keepalive                                                                                                                                                                                                                                                          | Measure in M2; the quota formula adapts                                                                                                                                                           |
| R3  | App-owned rules on re-auth/uninstall; visibility in the mobile app                                                                                                                                                                                                           | **Week-1 spike**                                                                                                                                                                                  |
| R4  | DO-hosted SSE stability (15-min pending-I/O cap, deploy restarts)                                                                                                                                                                                                            | 60 s watchdog alarm; reconnect + reconcile; Container fallback (ADR-001)                                                                                                                          |
| R5  | SmartThings treating Cloudflare egress as abusive (418)                                                                                                                                                                                                                      | Descriptive `User-Agent`; strict pacing; if it ever happens, support ticket + Container egress                                                                                                    |
| R6  | Locally executable operations are undocumented                                                                                                                                                                                                                               | The probe suite measures them                                                                                                                                                                     |
| R7  | **Hub v2 (2015) specifics:** still gets firmware and runs Edge; excluded from automatic hub backup; carries end-of-life risk                                                                                                                                                 | `whoami` records model and firmware; the matrix is keyed by hub model, so a future hub swap re-probes cleanly; Matter is out of scope by choice; rules in git make a hub replacement a re-`apply` |
| R8  | PocketID outage blocks UI/CLI login                                                                                                                                                                                                                                          | OTP break-glass IdP; service tokens keep CI working; hub rules are unaffected                                                                                                                     |
| R9  | Scene action in rules; scope for setting mode; `w:devices` for virtual devices. **Observed 2026-11-05:** requesting `r:scenes:*` and `x:scenes:*` _together_ at authorize fails with `server_error`; each one alone installs fine. Both are dropped from `ST_SCOPES` for now | M0/M2 spikes; create virtual devices with the CLI; re-test the scene scopes (and ask SmartThings) in the M2 scene spike                                                                           |
| R10 | Non-commercial plan terms                                                                                                                                                                                                                                                    | Single-tenant; code can be open source                                                                                                                                                            |

## 12. Decisions (resolved 2026-11-04)

1. **DNS:** the `baltar.media` zone is on Cloudflare, so the Worker custom domain and Access work directly.
2. **Identity:** PocketID is public with trusted TLS. It's the Access IdP, with OTP as break-glass.
3. **Hub:** Samsung SmartThings Hub 2015 (v2), named "Bur Oak". Matter and Thread aren't priorities, and the probe matrix covers Zigbee, Z-Wave, LAN, and virtual devices.
4. **Repos:** a public `sebastian` repo (the tool) plus a private `home` repo (device IDs and automations).
5. **Fail-safe device selection:** decided in the first code session, from what `seb whoami` shows is already on Bur Oak.

## 13. First code session checklist

1. **Cloudflare:**
   - Zero Trust: create the team; add PocketID as a generic OIDC IdP (redirect `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`); enable OTP.
   - Create the Access app for `sebastian.baltar.media` with policies for you, `seb-cli`, and `seb-ci`.
   - Create D1 `sebastian`. R2, KV, Queues, and Analytics Engine wait until §4 says they've earned it.
2. **SmartThings Developer Center:**
   - Register the API Access App with redirect `https://sebastian.baltar.media/oauth/callback` and CORS domain `sebastian.baltar.media`.
   - Scopes: `r:devices:* x:devices:* r:locations:* w:locations:* x:locations:* r:scenes:* x:scenes:* r:rules:* w:rules:* r:hubs:* r:installedapps:* sse`.
   - Store the client ID and secret as Worker secrets (or in Secrets Store).
3. **Scaffold** the pnpm monorepo, `wrangler.jsonc` (DO classes with SQLite migrations, Workflows, D1, crons, secrets), GitHub Actions.
4. **Implement:** Access JWT middleware → InstallDO (vault, `stFetch`, ledger) → `/oauth/callback` with signed `state`. Install to the Bur Oak location.
5. **`seb whoami`:** location, rooms, hub model/firmware, devices by integration type, ledger summary.
6. **R3 spike:** hand-written rule → `executionLocation` → check the mobile app → re-auth → observe.
7. **ADRs:**
   - ADR-001: Cloudflare-native; SSE in a Durable Object with a Container fallback; no webhooks.
   - ADR-002: automations-as-code; client-side compile; private `home` repo; GitOps.
   - ADR-003: InstallDO as single token owner; restore runbook.
   - ADR-004: Access + PocketID + OTP break-glass + service tokens.
