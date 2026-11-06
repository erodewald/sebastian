import { sha256Hex } from '@sebastian/protocol';
import type { AccessIdentity } from './access.js';
import type { Env } from './env.js';

/**
 * Who is calling, and what they may do at which location (ADR-005).
 *
 * - People sign in through Access (PocketID). The first person ever to sign in becomes the
 *   admin and owns every install that has no owner yet; admins can do anything everywhere.
 * - Everyone else sees only the locations they're a member of, with a role:
 *   viewer (read, live view) < editor (plan, apply, run) < owner (manage members).
 * - Only admins connect new SmartThings locations (the app's 10-install, 100K-call limits are
 *   shared by everyone).
 * - The CLI authenticates to Access with the shared `seb-cli` service token and names the
 *   person with a personal API token (`x-seb-token`), minted in the web UI.
 */

export type Role = 'viewer' | 'editor' | 'owner';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const atLeast = (have: Role, need: Role) => RANK[have] >= RANK[need];
export const isRole = (r: unknown): r is Role => r === 'viewer' || r === 'editor' || r === 'owner';

export interface User {
  email: string;
  isAdmin: boolean;
  /** How this request was authenticated. */
  via: 'access' | 'token';
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 404,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

const SEEN_EVERY_MS = 5 * 60_000;
export const TOKEN_PREFIX = 'seb_';

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `${TOKEN_PREFIX}${btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
}

/** Resolve the Access identity (plus a personal token for service identities) to a user. */
export async function resolveUser(
  env: Env,
  identity: AccessIdentity,
  token: string | undefined,
  now = Date.now(),
): Promise<User> {
  if (identity.kind === 'service') {
    if (!token?.startsWith(TOKEN_PREFIX))
      throw new AuthError(
        401,
        'token_required',
        'set SEB_TOKEN: mint a personal token in the web UI (Tokens)',
      );
    const row = await env.DB.prepare(
      `SELECT t.id, t.email, u.is_admin FROM api_tokens t JOIN users u ON u.email = t.email
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
      .bind(await hashToken(token))
      .first<{ id: string; email: string; is_admin: number }>();
    if (!row) throw new AuthError(401, 'bad_token', 'unknown or revoked token');
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .bind(now, row.id)
      .run();
    return { email: row.email, isAdmin: row.is_admin === 1, via: 'token' };
  }

  const email = identity.email.trim().toLowerCase();
  const existing = await env.DB.prepare('SELECT is_admin, last_seen_at FROM users WHERE email = ?')
    .bind(email)
    .first<{ is_admin: number; last_seen_at: number }>();
  if (existing) {
    if (now - existing.last_seen_at > SEEN_EVERY_MS)
      await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE email = ?')
        .bind(now, email)
        .run();
    if (existing.is_admin === 1) await claimOrphans(env, email, now);
    return { email, isAdmin: existing.is_admin === 1, via: 'access' };
  }
  // First sign-in. The very first user becomes admin (atomic: only if no admin exists yet).
  await env.DB.prepare(
    `INSERT INTO users (email, sub, is_admin, created_at, last_seen_at)
     VALUES (?, ?, CASE WHEN EXISTS (SELECT 1 FROM users WHERE is_admin = 1) THEN 0 ELSE 1 END, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  )
    .bind(email, identity.sub || null, now, now)
    .run();
  const made = await env.DB.prepare('SELECT is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<{ is_admin: number }>();
  const isAdmin = made?.is_admin === 1;
  if (isAdmin) await claimOrphans(env, email, now);
  return { email, isAdmin, via: 'access' };
}

/** Installs connected before tenancy existed belong to the admin. */
async function claimOrphans(env: Env, email: string, now: number) {
  const { results } = await env.DB.prepare(
    'SELECT installed_app_id FROM installs WHERE owner_email IS NULL',
  ).all<{ installed_app_id: string }>();
  for (const r of results) await setOwner(env, r.installed_app_id, email, now);
}

export async function setOwner(env: Env, installedAppId: string, email: string, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare('UPDATE installs SET owner_email = ? WHERE installed_app_id = ?').bind(
      email,
      installedAppId,
    ),
    env.DB.prepare(
      `INSERT INTO install_members (installed_app_id, email, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)
       ON CONFLICT (installed_app_id, email) DO UPDATE SET role = 'owner'`,
    ).bind(installedAppId, email, email, now),
  ]);
}

export interface InstallSummary {
  installedAppId: string;
  locationId: string;
  locationName: string | null;
  role: Role;
  deletedAt: number | null;
}

/** The locations a user can see, with their role (admins: all, as owner). */
export async function installsFor(env: Env, user: User): Promise<InstallSummary[]> {
  const q = user.isAdmin
    ? env.DB.prepare(
        `SELECT installed_app_id, location_id, location_name, deleted_at, 'owner' AS role
         FROM installs ORDER BY updated_at DESC`,
      )
    : env.DB.prepare(
        `SELECT i.installed_app_id, i.location_id, i.location_name, i.deleted_at, m.role
         FROM install_members m JOIN installs i ON i.installed_app_id = m.installed_app_id
         WHERE m.email = ? ORDER BY i.updated_at DESC`,
      ).bind(user.email);
  const { results } = await q.all<{
    installed_app_id: string;
    location_id: string;
    location_name: string | null;
    deleted_at: number | null;
    role: string;
  }>();
  return results
    .filter((r) => isRole(r.role))
    .map((r) => ({
      installedAppId: r.installed_app_id,
      locationId: r.location_id,
      locationName: r.location_name,
      role: r.role as Role,
      deletedAt: r.deleted_at,
    }));
}

/**
 * The install a request acts on, and the caller's role there. With no explicit choice, the
 * user's most recently updated location. Unknown and not-yours are the same 404, so install
 * ids can't be probed.
 */
export async function installAccess(
  env: Env,
  user: User,
  requested: string | undefined,
): Promise<{ installedAppId: string; role: Role }> {
  const mine = await installsFor(env, user);
  const pick = requested ? mine.find((i) => i.installedAppId === requested) : mine[0];
  if (!pick) {
    if (requested) throw new AuthError(404, 'no_such_location', 'no location with that id for you');
    throw new AuthError(
      404,
      'no_locations',
      user.isAdmin
        ? 'no SmartThings location connected yet: visit /oauth/start'
        : 'no locations shared with you yet',
    );
  }
  return { installedAppId: pick.installedAppId, role: pick.role };
}
