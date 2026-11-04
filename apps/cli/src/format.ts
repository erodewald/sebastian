import type { BudgetResponse, WhoamiResponse } from '@sebastian/protocol';

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
