import { Cloud, Cpu, HelpCircle } from 'lucide-react';

const ICON = { Local: Cpu, Cloud: Cloud, Unknown: HelpCircle } as const;

function norm(v: string | null | undefined): keyof typeof ICON {
  return v === 'Local' || v === 'Cloud' ? v : 'Unknown';
}

/**
 * Where the rule runs. `actual` is SmartThings' executionLocation, read back after deploy;
 * `predicted` is the locality linter's guess. A mismatch is worth seeing, so it's shown.
 */
export function Locality({
  predicted,
  actual,
  compact,
}: {
  predicted: string | null;
  actual: string | null;
  compact?: boolean;
}) {
  const a = norm(actual ?? predicted);
  const p = norm(predicted);
  const Icon = ICON[a];
  const mismatch = actual && predicted && p !== 'Unknown' && norm(actual) !== p;
  const unmeasured = actual && p === 'Unknown';
  return (
    <span
      className={`loc loc-${a.toLowerCase()} ${mismatch ? 'loc-mismatch' : ''}`}
      title={`SmartThings reports: ${actual ?? 'not read back'} · locality linter predicted: ${predicted ?? '—'}`}
    >
      <Icon size={12} />
      {!compact && <span>{a === 'Local' ? 'hub-local' : a === 'Cloud' ? 'cloud' : 'unknown'}</span>}
      {mismatch && !compact && <span className="loc-pred">· predicted {p.toLowerCase()}</span>}
      {unmeasured && !compact && <span className="loc-pred">· unverified</span>}
    </span>
  );
}
