import { Check, Copy, KeyRound, MapPin, Plus, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type LocationSummary, type Me, pickLocation, type Role, type Source } from '../source.ts';
import { ago } from '../util.ts';

type Tab = 'locations' | 'members' | 'tokens';

interface Token {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}
interface Member {
  email: string;
  role: Role;
  addedBy: string | null;
  addedAt: number;
  lastSeenAt: number | null;
}

/** Account and sharing: locations you can reach, who can reach this one, your CLI tokens. */
export function Settings({
  source,
  me,
  current,
  initial = 'locations',
  onClose,
}: {
  source: Source;
  me: Me;
  current?: LocationSummary | undefined;
  initial?: Tab;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initial);
  const canManage = current?.role === 'owner';
  return (
    <div className="settings" role="dialog" aria-label="Settings">
      <div className="st-head">
        <div className="st-tabs" role="tablist">
          <TabButton
            on={tab === 'locations'}
            onClick={() => setTab('locations')}
            icon={<MapPin size={13} />}
          >
            Locations
          </TabButton>
          {canManage && (
            <TabButton
              on={tab === 'members'}
              onClick={() => setTab('members')}
              icon={<Users size={13} />}
            >
              People
            </TabButton>
          )}
          <TabButton
            on={tab === 'tokens'}
            onClick={() => setTab('tokens')}
            icon={<KeyRound size={13} />}
          >
            CLI tokens
          </TabButton>
        </div>
        <span className="muted small">
          {me.email}
          {me.isAdmin ? ' · admin' : ''}
        </span>
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="st-body">
        {tab === 'locations' && <Locations me={me} current={current} />}
        {tab === 'members' && current && canManage && (
          <Members source={source} me={me} location={current} />
        )}
        {tab === 'tokens' && <Tokens source={source} />}
      </div>
    </div>
  );
}

function TabButton({
  on,
  onClick,
  icon,
  children,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={`st-tab ${on ? 'is-on' : ''}`}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function Locations({ me, current }: { me: Me; current?: LocationSummary | undefined }) {
  return (
    <>
      <p className="muted small">
        Each location is one SmartThings install.{' '}
        {me.isAdmin
          ? 'As admin you see all of them and can connect more (every location shares the app’s 10 installs and 100K calls a month).'
          : 'These were shared with you; ask the owner for a different role.'}
      </p>
      <ul className="st-list">
        {me.locations.map((l) => (
          <li
            key={l.installedAppId}
            className={l.installedAppId === current?.installedAppId ? 'is-current' : ''}
          >
            <div className="st-main">
              <b>{l.locationName ?? 'Unnamed location'}</b>
              <span className="mono muted small">{l.installedAppId}</span>
            </div>
            <span className={`role role-${l.role}`}>{l.role}</span>
            {l.deletedAt && <span className="tag tag-bad">disconnected</span>}
            {l.installedAppId === current?.installedAppId ? (
              <span className="muted small">showing</span>
            ) : (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => pickLocation(l.installedAppId)}
              >
                Open
              </button>
            )}
          </li>
        ))}
        {me.locations.length === 0 && <li className="muted small">No locations yet.</li>}
      </ul>
      {me.isAdmin && (
        <a className="btn" href="/oauth/start">
          <Plus size={14} /> Connect a SmartThings location
        </a>
      )}
    </>
  );
}

function Members({ source, me, location }: { source: Source; me: Me; location: LocationSummary }) {
  const [members, setMembers] = useState<Member[]>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [err, setErr] = useState<string>();
  const base = `/api/locations/${encodeURIComponent(location.installedAppId)}/members`;
  const load = useCallback(
    () => source.api<Member[]>(base).then(setMembers, (e: Error) => setErr(e.message)),
    [source, base],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const put = async (who: string, r: Role) => {
    setErr(undefined);
    try {
      await source.api(`${base}/${encodeURIComponent(who)}`, { method: 'PUT', body: { role: r } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async (who: string) => {
    setErr(undefined);
    try {
      await source.api(`${base}/${encodeURIComponent(who)}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const roles: Role[] = me.isAdmin ? ['viewer', 'editor', 'owner'] : ['viewer', 'editor'];
  return (
    <>
      <p className="muted small">
        People who can see <b>{location.locationName ?? 'this location'}</b>. They sign in through
        PocketID (add them to the Access policy too). <b>Viewer</b>: rules, code and the live view.{' '}
        <b>Editor</b>: also plan, apply and run. <b>Owner</b>: also manage people.
      </p>
      <form
        className="st-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) void put(email.trim().toLowerCase(), role).then(() => setEmail(''));
        }}
      >
        <input
          type="email"
          required
          placeholder="email they sign in with"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email"
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          {roles.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary btn-small">
          <Plus size={13} /> Share
        </button>
      </form>
      {err && <p className="st-err small">{err}</p>}
      <ul className="st-list">
        {members?.map((m) => (
          <li key={m.email}>
            <div className="st-main">
              <b>{m.email}</b>
              <span className="muted small">
                {m.lastSeenAt ? `last seen ${ago(m.lastSeenAt)}` : 'hasn’t signed in yet'}
              </span>
            </div>
            {m.email === me.email ? (
              <span className={`role role-${m.role}`}>{m.role}</span>
            ) : (
              <>
                <select
                  value={m.role}
                  onChange={(e) => void put(m.email, e.target.value as Role)}
                  aria-label={`Role for ${m.email}`}
                  disabled={m.role === 'owner' && !me.isAdmin}
                >
                  {(m.role === 'owner' && !me.isAdmin ? ['owner' as Role] : roles).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void remove(m.email)}
                  aria-label={`Remove ${m.email}`}
                  title="Remove access"
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Tokens({ source }: { source: Source }) {
  const [tokens, setTokens] = useState<Token[]>();
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string>();
  const load = useCallback(
    () => source.api<Token[]>('/api/tokens').then(setTokens, (e: Error) => setErr(e.message)),
    [source],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const create = async () => {
    setErr(undefined);
    try {
      const t = await source.api<{ token: string }>('/api/tokens', {
        body: { name: name.trim() || 'cli' },
      });
      setFresh(t.token);
      setName('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const snippet = fresh ? `export SEB_TOKEN=${fresh}` : '';
  return (
    <>
      <p className="muted small">
        The <code>seb</code> CLI gets through Access with the shared service token, and says who you
        are with a personal token. It acts with your role at each location.
      </p>
      <form
        className="st-add"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          placeholder="name, e.g. laptop"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Token name"
        />
        <button type="submit" className="btn btn-primary btn-small">
          <Plus size={13} /> New token
        </button>
      </form>
      {fresh && (
        <div className="st-fresh">
          <span className="small">Copy it now: it won’t be shown again.</span>
          <pre className="sp-pre">{snippet}</pre>
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              void navigator.clipboard.writeText(snippet).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {err && <p className="st-err small">{err}</p>}
      <ul className="st-list">
        {tokens?.map((t) => (
          <li key={t.id}>
            <div className="st-main">
              <b>{t.name}</b>
              <span className="muted small">
                created {ago(t.createdAt)} ·{' '}
                {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-small"
              onClick={() =>
                void source
                  .api(`/api/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
                  .then(load)
              }
            >
              Revoke
            </button>
          </li>
        ))}
        {tokens?.length === 0 && <li className="muted small">No tokens yet.</li>}
      </ul>
    </>
  );
}
