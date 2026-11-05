# SmartThings platform facts (researched 2026-11-04)

Sources: blog.smartthings.com (Oct 30 2026 "API Additional Details" post), developer.smartthings.com/docs/service-integrations/*, community.smartthings.com.

## Developer Plan (launched Nov 4 2026; announced as $4.99/mo, non-commercial)

- Flat monthly per developer account; covers "API Access Apps" using OAuth.
- Quota: up to 100,000 cloud API calls / month; up to 10 active app installs across locations.
- Includes SSE event streaming, webhooks, API Dashboard (per-app usage).
- Rules via OAuth requires paid plan (included). Rules still usable via CLI/PAT/AWA/app.
- Free: mobile app, routines, local Edge drivers + profiles, CLI for drivers/profiles, WWST cert.
- PATs: 24h lifetime; intended for testing/light scripts only.
- Timeline: Nov 4–Dec 15 apps without a plan can't be created/edited; after Dec 15 unpaid keys deactivated.
- Not published: per-minute limits for plan, whether SSE events count against quota.

## API Access App

- Register in Developer Center Console (Service Integrations) or CLI. Creds: App ID, Client ID, Client Secret.
- Endpoints: GET /oauth/callback (required), POST / webhook target (optional; requires CONFIRMATION handshake).
- Scopes: r/w/x:devices:_, r:hubs:_, r/w/x:locations:_, r/x:scenes:_, r/w:rules:_, r:security:locations:_:armstate, sse, r:installedapps:*.
- Tokens: access ~24h; refresh 30 days, single-use, rotates on every refresh. Single in-flight refresh per installed app. Key by installed_app_id. Encrypt at rest.
- Subscriptions persist regardless of token validity; must unsubscribe explicitly.

## SSE

- POST /v1/sse/subscriptions {name, subscriptionFilters[{type: LOCATIONIDS|DEVICEIDS, value[], eventType[]}]} -> {subscriptionId, registrationUrl}
- GET registrationUrl with Accept: text/event-stream within 1 minute or it's deleted.
- PUT to update filters (only when active), DELETE to stop.
- Event types: DEVICE_EVENT, DEVICE_LIFECYCLE_EVENT, DEVICE_HEALTH_EVENT, INSTALLED_APP_LIFECYCLE_EVENT, LOCATION_LIFECYCLE_EVENT, MODE_EVENT, SCENE_LIFECYCLE_EVENT.
- First message CONTROL_EVENT "welcome"; periodic welcome keepalive; "goodbye" before TTL expiry/delete -> create new subscription.
- TTL server-assigned, variable, undocumented. No Last-Event-ID / replay. Gaps are lost -> reconcile via REST.
- At-least-once & ordered "normally" but not guaranteed; dupes/misses near create/update.
- Limits: 10 filters/sub, 10 IDs/filter, 2 active subs/integration, 1 active connection/token, 20 calls/min (SSE API).
- Errors: 403 -> recreate; 409 PUT on inactive; 418 client flagged; 429 backoff w/ jitter.
- User-Agent header required.

## REST rate limits (observed, per principal unless noted)

- GET /v1/locations/{id} 250/60s; GET /v1/installedapps/{id} 200/60s; GET /v1/devices 1000/900s;
- GET /v1/devices/{id} 400/900s per device; GET .../status 350/60s per device; POST /devices/{id}/commands 120/60s per device.
- Headers: x-ratelimit-limit / -remaining / -reset (api-overview says ms; rate-limits/troubleshoot pages say seconds — parse defensively). Pagination via _links.next, max page 200.
- 402: do not retry; halt calls (troubleshoot page).
- GET /devices supports includeStatus=true and includeHealth=true, and deviceId filters (query-and-list-devices).
- Guardrail: 50 rules per installed app.
- HUB_HEALTH is a webhook subscription type, not an SSE event type.
- Public RuleAction union (core-sdk): if, sleep, command, every, location. No scene action found. `every` = interval | specific (time + daysOfWeek). `remains`/`was` exist with duration. LocationAction requires locationId.
- Virtual standard create takes hubId/driverId — hub-local virtual devices need a hub in that location.

## Rules

- Rules API: POST/GET/PUT/DELETE /rules?locationId=, POST /rules/execute/{id}.
- Rule response carries executionLocation "Local" | "Cloud". Local only if every device and every operation in the rule supports local execution (e.g. historically `remains` was not local). Supported local actions historically: command, every, group, if, sleep, toggle.
- Rules belong to a principal (PAT user or installed app); principals can't see each other's rules.
- Automatic routines in app are Rules; local ones show a house icon. Local "manually run routines" (scenes) can be invoked from local rules.
- Scenes API also has executionLocation.

## Virtual devices

- /virtualdevices API + CLI `virtualdevices:create-standard --local --prototype=VIRTUAL_SWITCH` creates hub-local virtual switch/dimmer via stock Virtual Switch Edge driver (local -> keeps rules local). Cloud virtual devices also exist; events via POST /virtualdevices/{id}/events.
- Community Edge drivers exist for richer local virtual devices.

## Observed during M0 install (2026-11-05)

- `API_ONLY` app without `apiOnly.targetUrl`: create succeeds, but reads log `ApiOnly app not found`, uninstalls fail `417 TargetUnconfirmed`, and broad authorizations fail with `server_error`. Give it a target and confirm it (`smartapps:confirm` → CONFIRMATION → GET `confirmationUrl`).
- `smartapps:confirm` returns 202 even when delivery fails. Check `targetStatus` (`PENDING` → `CONFIRMED`).
- Authorize `scope` is space-separated. A literal `+` gives `invalid_scope: unable to build scope from a+b`.
- Scope combinations failing with `server_error` (each scope alone works): `r:scenes:*`+`x:scenes:*`; the 9 working scopes + `r:installedapps`. Home Assistant requests those same combinations successfully, so this is likely specific to the app.
- Each successful authorization creates a new installed app (`singleInstance` not enforced for `API_ONLY`). The CLI `installedapps` list omits `API_ONLY` installs; `installedapps <id>` and `installedapps:delete <id>` work.
- An app can read its own installed app (`GET /installedapps/{id}`) without `r:installedapps`.
- CLI 3.0.0 scope picker has no `sse` and spells `r:installedapps` without `:*`; platform tokens use `r:installedapps:*`.
- Location "Bur Oak" has two hubs: SmartThings v2 Hub (fw 000.063.00001; 11 Zigbee, 5 Z-Wave, 5 LAN devices) and a SmartThings Station (fw 000.054.00013; 1 Zigbee, 1 LAN). A rule mixing devices from both hubs can't run locally.

## Hub v2 (2015)

- Still receiving firmware in 2026 (0.59.9 Jan 2026; included in 0.60.12 Mar 2026 and 0.62.7 Sep 2026 rollouts). Supports Edge. No Thread radio; excluded from automatic hub backup.

## Cloudflare constraints relevant to Sebastian (docs as of Nov 2026)

- Durable Objects: pending outbound fetch / TCP / outbound WebSocket prevents eviction, but each operation only for up to 15 minutes from start; afterward standard eviction (70–140 s idle) resumes. Incoming events (requests, alarms) reset idleness. Duration charges apply while resident.
- Alarm handlers, cron triggers, queue consumers: 15-minute wall-time limit per invocation.
- Containers: no fixed max runtime; default sleepAfter 10 min; host restarts can stop instances (SIGTERM, 15 min grace). Billed per 10 ms active; included usage on Workers Paid.
- Access: generic OIDC IdP (PocketID) — redirect https://<team>.cloudflareaccess.com/cdn-cgi/access/callback; IdP must be publicly reachable with trusted TLS. Apps deny by default. Service tokens for non-browser clients. Validate Cf-Access-Jwt-Assertion in the Worker.

## Edge drivers

- Lua, run on hub, free to build/package/share via channels. Custom capabilities possible.
