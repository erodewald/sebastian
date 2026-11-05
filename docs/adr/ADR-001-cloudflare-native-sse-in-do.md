# ADR-001: Cloudflare-native hosting; SSE in a Durable Object with a Container fallback; no webhooks

**Status:** Accepted (2026-11-04). Revisit at M2 exit.

## Context

Sebastian is the fail-safe tier next to Home Assistant, so its tooling should survive a homelab outage. The runtime path (hub-local rules) doesn't depend on where the tooling runs. Verify mode needs one long-lived SSE connection to SmartThings.

## Decision

- Host on Cloudflare: Workers (Hono), Durable Objects, D1, Workflows, Access. Other products (Queues, R2, KV, Analytics Engine, AI Gateway, Containers) are added only when PLAN §4 names a trigger.
- Host the SSE consumer in `StreamDO`. A 60 s alarm acts as watchdog and keeps the object resident. Each pending outbound fetch only keeps the object alive for 15 minutes, so the alarm, not the stream, is what holds residency.
- No webhooks: nothing on the hostname accepts inbound calls from SmartThings.

## Consequences

- One always-resident DO is billed around the clock while verify mode is continuous. Windowed verify (`seb verify --for 2h`) avoids that.
- Every deploy or platform restart drops the stream. That counts as an unexpected drop (reconnect, then reconcile via REST); SSE has no replay anyway.
- **Fallback:** if DO-hosted SSE proves flaky in M2 (R4), move only the stream consumer into a Cloudflare Container bound to StreamDO. Nothing else changes.

## Amendment (2026-11-05): one inbound lifecycle endpoint

"No webhooks" turned out to be unworkable for installs. With `apiOnly` and no `targetUrl`:

- full-scope authorizations failed with `server_error: Unexpected server error.`;
- SmartThings logged `ApiOnly app not found for appId=…` for the app; and
- uninstalls failed with `417 TargetUnconfirmed` and an empty `target=`.

An `sse`-only authorization did succeed, so not every install path needs the target.

**Decision:**

- The app's `apiOnly.targetUrl` is `https://sebastian.baltar.media/st/lifecycle`, confirmed once with `smartthings smartapps:confirm <appId>`.
- That one path bypasses Cloudflare Access (a separate Access application with a Bypass policy) and is otherwise inert:
  - **CONFIRMATION:** fetch the `confirmationUrl`, only for `ST_APP_ID` and only on the SmartThings API host;
  - **PING:** echo the challenge;
  - **anything else:** log and acknowledge, with no side effects.
- Device events still come over SSE, not this endpoint.
- Before a lifecycle message is allowed to change state (e.g. UNINSTALL marking an install gone), the handler must verify SmartThings' HTTP signature.
