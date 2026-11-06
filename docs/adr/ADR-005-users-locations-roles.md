# ADR-005: Users, locations and roles

**Status:** accepted 2026-11-06 · **Supersedes:** the single-user assumption in PLAN R10 (partly)

## Context

Sebastian could hold one SmartThings install and assumed one person. The owner wants to manage
several locations, and to let others sign in through PocketID to evaluate it.

The SmartThings app is one API Access app on the owner's Developer Plan, so every install shares
its limits: 10 installs and 100K calls a month. The plan is non-commercial.

## Decision

- **People are Access identities.** Users are keyed by the lowercased email in the Access JWT
  (PocketID). The first person ever to sign in becomes the **admin**. Admins see and own every
  location, and installs that predate this change are claimed by the admin.
- **Locations are installs.** Each connected SmartThings location is one install, with its own
  InstallDO, StreamDO and rules. Only admins connect locations (`/oauth/start`), because installs
  and API calls are shared app-wide.
- **Sharing is per location, by role.** Owners add people by email (before or after they first
  sign in): **viewer** can read and watch live, **editor** can also plan, apply and run, **owner**
  can also manage people. Only admins make owners. Evaluators get roles on the owner's locations;
  they don't connect their own.
- **Every `/api` call is scoped.** The location comes from `x-seb-install` (CLI, fetch) or
  `?install=` (WebSocket); without one, the user's most recently updated location. A location the
  user isn't a member of answers 404, the same as an unknown one. Reads need viewer, writes need
  editor, `/api/resume` needs owner.
- **The CLI uses personal tokens.** It still passes Access with the shared `seb-cli` service
  token, and names the person with `SEB_TOKEN` (`x-seb-token`), minted in the web UI and stored
  as a SHA-256 hash. A service identity without a valid token is refused.

## Consequences

- To let someone in: add their email to the Access application's policy (PocketID group or
  email), then share a location with them under People. Access gates the hostname; Sebastian's
  roles gate the data.
- The call budget stays per install. With evaluators running applies at the owner's locations,
  usage still lands on those installs' ledgers.
- `SEB_TOKEN` is now required for the CLI. Mint one under the avatar → CLI tokens.
