import type { DevicesResponse, ManagedRule } from '@sebastian/protocol';
import { Cloud, Router } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLive } from '../live.ts';
import { type DeviceIndex, valueText } from '../util.ts';

export function DeviceList({
  devices,
  rules,
}: {
  devices: DevicesResponse;
  rules: ManagedRule[];
  idx: DeviceIndex;
}) {
  const last = useLive((s) => s.lastByDevice);
  const [all, setAll] = useState(false);
  const used = useMemo(() => new Set(rules.flatMap((r) => r.deviceIds ?? [])), [rules]);
  const groups = useMemo(() => {
    const list = devices.devices.filter(
      (d) => d.integrationType !== 'HUB' && (all || used.has(d.deviceId)),
    );
    const out = new Map<string, typeof list>();
    for (const d of list) {
      const k = d.hubId ?? '';
      out.set(k, [...(out.get(k) ?? []), d]);
    }
    return [...out.entries()].sort(([a], [b]) =>
      a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
    );
  }, [devices, all, used]);
  const hubs = new Map(devices.hubs.map((h) => [h.hubId, h.label]));

  return (
    <section className="panel">
      <h3 className="panel-h">
        Devices
        <span className="count">{all ? devices.devices.length : used.size}</span>
        <button type="button" className="link small" onClick={() => setAll(!all)}>
          {all ? 'in rules' : 'all'}
        </button>
      </h3>
      {groups.map(([hub, list]) => (
        <div key={hub} className="dev-group">
          <div className="dev-hub">
            {hub ? <Router size={12} /> : <Cloud size={12} />}
            {hub ? (hubs.get(hub) ?? hub.slice(0, 8)) : 'Cloud-connected'}
          </div>
          <ul className="dev-list">
            {list.map((d) => {
              const ev = last[d.deviceId];
              return (
                <li key={d.deviceId} className="dev-item" title={d.deviceId}>
                  <span className="dev-flash" key={ev?.seq ?? -1} data-live={ev ? '1' : '0'} />
                  <span className="dev-label">{d.label}</span>
                  <span className="dev-int">{d.integrationType.toLowerCase()}</span>
                  {ev && (
                    <span className="dev-val mono" title={`${ev.capability}.${ev.attribute}`}>
                      {valueText(ev.value)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {groups.length === 0 && <p className="muted small pad">No devices in rules yet.</p>}
    </section>
  );
}
