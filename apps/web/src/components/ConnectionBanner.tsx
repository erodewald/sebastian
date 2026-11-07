import { Link2Off, RefreshCw } from 'lucide-react';

/**
 * Shown when the SmartThings connection is gone: removed by the user in the SmartThings app
 * (Settings → Linked services), or a refresh token SmartThings no longer accepts.
 */
export function ConnectionBanner({
  state,
  deletedAt,
}: {
  state: string;
  deletedAt: number | null | undefined;
}) {
  if (state !== 'DELETED' && state !== 'NEEDS_REAUTH') return null;
  const deleted = state === 'DELETED';
  return (
    <div className="conn-banner" role="alert">
      <Link2Off size={16} />
      <div className="cb-text">
        <b>
          {deleted ? 'Disconnected from SmartThings.' : 'SmartThings needs you to sign in again.'}
        </b>{' '}
        {deleted ? (
          <>
            Sebastian was removed in the SmartThings app (Settings → Linked services)
            {deletedAt ? ` on ${new Date(deletedAt).toLocaleString()}` : ''}. Its tokens were
            deleted and nothing here reaches your home until you reconnect. SmartThings may also
            have removed the rules it deployed: run <code>seb apply</code> after reconnecting.
          </>
        ) : (
          <>
            SmartThings rejected the stored refresh token. Reconnect to keep rules and the live view
            working.
          </>
        )}
      </div>
      <a className="btn btn-primary" href="/oauth/start">
        <RefreshCw size={14} /> Reconnect
      </a>
    </div>
  );
}
