import type {
  ApplyStatus,
  BudgetResponse,
  ManagedRule,
  PlanOp,
  WhoamiResponse,
} from '@sebastian/protocol';

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

export function formatBudget(b: BudgetResponse): string {
  const lines = [
    `Budget ${b.month}  ${b.monthSpent.toLocaleString()} / ${b.monthlyQuota.toLocaleString()} (${pct(b.monthSpent, b.monthlyQuota)})`,
    `Today  ${b.day}  ${b.todaySpent} calls · daily allowance ${b.dailyAllowance}`,
  ];
  const cats = Object.entries(b.byCategoryToday).filter(([, n]) => n > 0);
  if (cats.length) lines.push(`        ${cats.map(([c, n]) => `${c}=${n}`).join('  ')}`);
  for (const br of b.breakers) {
    lines.push(`⚠ breaker ${br.name} since ${new Date(br.trippedAt).toISOString()}: ${br.reason}`);
  }
  return lines.join('\n');
}

export function formatWhoami(w: WhoamiResponse): string {
  const lines = [
    `Location   ${w.location.name} (${w.location.locationId})${w.location.timeZoneId ? ` · ${w.location.timeZoneId}` : ''}`,
    `Install    ${w.installedAppId} · tokens ${w.tokenState}`,
  ];
  for (const h of w.hubs) {
    lines.push(
      `Hub        ${h.name} · ${h.model ?? 'unknown model'} · fw ${h.firmwareVersion ?? 'unknown'}`,
    );
  }
  lines.push(`Rooms      ${w.rooms.map((r) => r.name).join(', ') || '—'}`);
  lines.push(`Modes      ${w.modes.map((m) => m.name).join(', ') || '—'}`);
  const byType = Object.entries(w.devicesByIntegration)
    .sort(([, a], [, b]) => b - a)
    .map(([t, n]) => `${t} ${n}`)
    .join(' · ');
  lines.push(`Devices    ${w.deviceCount} (${byType || 'none'})`);
  lines.push('', formatBudget(w.ledger));
  return lines.join('\n');
}

const SYMBOL: Record<PlanOp['op'], string> = { create: '+', update: '~', delete: '-', noop: ' ' };
const loc = (l?: string | null) => (l === 'Local' ? 'Local' : l === 'Cloud' ? 'Cloud' : (l ?? '?'));

export function formatPlan(ops: PlanOp[], reasons: Map<string, string[]>): string {
  if (ops.length === 0) return 'No automations and nothing managed.';
  const lines = ops.map((o) => {
    const pred = o.predicted ? `predicted ${loc(o.predicted)}` : '';
    const last = o.lastActual ? `last ${loc(o.lastActual)}` : '';
    const meta = [pred, last].filter(Boolean).join(', ');
    const head = `${SYMBOL[o.op]} ${o.op.padEnd(6)} ${o.sourcePath}  "${o.name}"${meta ? `  (${meta})` : ''}`;
    const why = (reasons.get(o.sourcePath) ?? []).map((r) => `           · ${r}`);
    return [head, ...(o.op === 'delete' ? [] : why)].join('\n');
  });
  const n = (k: PlanOp['op']) => ops.filter((o) => o.op === k).length;
  lines.push(
    '',
    `Plan: ${n('create')} to create, ${n('update')} to update, ${n('delete')} to delete, ${n('noop')} unchanged.`,
  );
  return lines.join('\n');
}

export function formatApply(s: ApplyStatus): string {
  const lines = [`Apply ${s.instanceId}: ${s.status}`];
  for (const r of s.results ?? []) {
    if (r.op === 'delete') {
      lines.push(`  - deleted ${r.sourcePath}`);
      continue;
    }
    const mismatch =
      r.predicted && r.predicted !== 'Unknown' && r.actual && r.predicted !== r.actual;
    lines.push(
      `  ${r.op === 'create' ? '+' : '~'} ${r.sourcePath} → ${r.ruleId}  runs ${loc(r.actual)}` +
        (r.predicted ? ` (predicted ${r.predicted})` : '') +
        (mismatch ? '  ⚠ prediction wrong: update the locality matrix' : ''),
    );
  }
  if (s.error) lines.push(`  error: ${s.error}`);
  return lines.join('\n');
}

export function formatRules(rules: ManagedRule[]): string {
  if (rules.length === 0) return 'No managed rules.';
  return rules
    .map(
      (r) =>
        `${r.ruleId}  ${loc(r.actual).padEnd(5)}  ${r.sourcePath}  "${r.name}"  applied ${new Date(r.appliedAt).toISOString()}`,
    )
    .join('\n');
}
