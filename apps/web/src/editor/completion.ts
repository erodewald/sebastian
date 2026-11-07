import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Handle } from '@sebastian/codegen';
import type { AttrSpec, CapSpec } from '@sebastian/dsl';

/**
 * Completions for automation code, from the location's devices (the same handles `seb pull`
 * generates): device names (auto-imported), then capabilities, attributes, commands, the
 * comparison methods, and enum values inside `is(` / `changesTo(` / commands.
 */

export const GENERATED = '../generated/home.generated.ts';

const DSL: Completion[] = [
  ['automation', "automation('Name')", 'start an automation'],
  ['sleep', 'sleep(seconds)', 'wait, on the hub'],
  ['at', "at('HH:MM')", 'a time of day'],
  ['sunrise', 'sunrise(offsetMinutes?)', 'sunrise time'],
  ['sunset', 'sunset(offsetMinutes?)', 'sunset time'],
  ['noon', 'noon(offsetMinutes?)', 'noon'],
  ['between', 'between(start, end)', 'time window'],
  ['every', 'every.day(at(…)) / every.on([…], at(…))', 'schedule trigger'],
  ['all', 'all(...conds)', 'and'],
  ['any', 'any(...conds)', 'or'],
  ['not', 'not(cond)', 'negate'],
  ['ifThen', 'ifThen(cond, [then], [else])', 'branch'],
].map(([label, detail, info]) => ({
  label: label as string,
  detail,
  info,
  type: 'function',
  boost: -1,
}));

const BUILDER: Completion[] = [
  ['when', '.when(condition | schedule)', 'what starts it'],
  ['onlyIf', '.onlyIf(...conditions)', 'checked when it starts'],
  ['do', '.do(...actions)', 'what it does'],
  ['otherwise', '.otherwise(...actions)', 'when an onlyIf fails'],
  ['allowDangerous', ".allowDangerous('reason')", 'permit unlock/open/disarm'],
].map(([label, detail, info]) => ({ label: label as string, detail, info, type: 'method' }));

function attrMethods(spec: AttrSpec): Completion[] {
  const eq: Completion[] = [
    { label: 'changesTo', type: 'method', detail: 'trigger: becomes value' },
    { label: 'is', type: 'method', detail: 'condition: equals' },
    { label: 'isNot', type: 'method', detail: 'condition: not equal' },
  ];
  const num: Completion[] = [
    { label: 'risesAbove', type: 'method', detail: 'trigger: crosses up' },
    { label: 'fallsBelow', type: 'method', detail: 'trigger: crosses down' },
    { label: 'isAbove', type: 'method', detail: 'condition: >' },
    { label: 'isBelow', type: 'method', detail: 'condition: <' },
  ];
  return spec.type === 'number' ? [...num, ...eq] : eq;
}

function describe(spec: AttrSpec): string {
  if (spec.type === 'enum') return spec.values.join(' | ');
  if (spec.type === 'number') return `number${spec.unit ? ` (${spec.unit})` : ''}`;
  return spec.type;
}

/** Add `name` to the generated-handles import, creating the import if needed. */
function importChange(
  doc: string,
  name: string,
): { from: number; to?: number; insert: string } | undefined {
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/generated\/home\.generated(?:\.ts)?['"];?/;
  const m = re.exec(doc);
  if (m) {
    const names =
      m[1]
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    if (names.includes(name)) return undefined;
    const open = m.index + m[0].indexOf('{') + 1;
    const close = m.index + m[0].indexOf('}');
    return { from: open, to: close, insert: ` ${[...names, name].sort().join(', ')} ` };
  }
  const dsl = /import[^;]*from\s*['"]@sebastian\/dsl['"];?\n?/.exec(doc);
  const at = dsl ? dsl.index + dsl[0].length : 0;
  return { from: at, insert: `import { ${name} } from '${GENERATED}';\n` };
}

export function completionSource(handles: Handle[], modes: string[]) {
  const byName = new Map(handles.map((h) => [h.name, h]));
  const caps = (h: Handle, component = 'main'): Record<string, CapSpec> =>
    (h.spec.components as Record<string, Record<string, CapSpec>>)[component] ?? {};

  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    // Inside a call that takes a value: is(' / changesTo(' / isNot(' / a command with an enum arg.
    const call = /(\w+)\.(\w+)\.(\w+)\.(is|isNot|changesTo)\(\s*(['"]?)([\w-]*)$/.exec(before);
    if (call) {
      const [, dev, cap, attr, , quote, partial] = call;
      const spec =
        byName.get(dev ?? '') &&
        caps(byName.get(dev ?? '') as Handle)[cap ?? '']?.attributes[attr ?? ''];
      if (spec && spec.type === 'enum') {
        const q = quote || "'";
        return {
          from: ctx.pos - (partial?.length ?? 0) - (quote ? 0 : 0),
          options: spec.values.map((v) => ({
            label: v,
            apply: quote ? v : `${q}${v}${q}`,
            type: 'constant',
          })),
        };
      }
      return null;
    }
    const modeCall = /Home\.mode\.(is|set)\(\s*(['"]?)([\w -]*)$/.exec(before);
    if (modeCall) {
      const quote = modeCall[2];
      return {
        from: ctx.pos - (modeCall[3]?.length ?? 0),
        options: modes.map((m) => ({ label: m, apply: quote ? m : `'${m}'`, type: 'constant' })),
      };
    }

    // a.b.c.<partial>
    const chain = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([\w$]*)$/.exec(before);
    if (chain) {
      const parts = (chain[1] ?? '').split('.');
      const partial = chain[2] ?? '';
      const from = ctx.pos - partial.length;
      const h = byName.get(parts[0] ?? '');
      if (parts[0] === 'Home') {
        if (parts.length === 1) return { from, options: [{ label: 'mode', type: 'property' }] };
        if (parts[1] === 'mode' && parts.length === 2)
          return {
            from,
            options: [
              { label: 'is', type: 'method', detail: `condition: one of ${modes.join(', ')}` },
              { label: 'set', type: 'method', detail: 'action: change mode' },
            ],
          };
        return null;
      }
      if (parts[0] === 'every' && parts.length === 1)
        return {
          from,
          options: [
            { label: 'day', type: 'method', detail: "every.day(at('07:00'))" },
            { label: 'on', type: 'method', detail: "every.on(['Mon','Fri'], at('07:00'))" },
          ],
        };
      if (h) {
        const c = caps(h);
        if (parts.length === 1)
          return {
            from,
            options: Object.entries(c).map(([name, spec]) => ({
              label: name,
              type: 'property',
              detail: [
                ...Object.keys(spec.attributes),
                ...Object.keys(spec.commands).map((x) => `${x}()`),
              ].join(' '),
            })),
          };
        const cap = c[parts[1] ?? ''];
        if (cap && parts.length === 2)
          return {
            from,
            options: [
              ...Object.entries(cap.attributes).map(([name, spec]) => ({
                label: name,
                type: 'property',
                detail: describe(spec),
              })),
              ...Object.entries(cap.commands).map(([name, args]) => ({
                label: name,
                type: 'method',
                detail: `(${args.map((a) => `${a.name}${a.optional ? '?' : ''}: ${a.type === 'enum' ? (a.values ?? []).join('|') : a.type}`).join(', ')})`,
                apply: args.length ? undefined : `${name}()`,
              })),
            ],
          };
        const attr = cap?.attributes[parts[2] ?? ''];
        if (attr && parts.length === 3) return { from, options: attrMethods(attr) };
        return null;
      }
      // .when / .do on a builder chain
      if (
        /\)\s*$/.test(chain[1] ?? '') ||
        /automation/.test(before) ||
        /^\s*$/.test(before.slice(0, before.lastIndexOf('.')))
      )
        return { from, options: BUILDER };
      return null;
    }
    if (/^\s*\.([\w]*)$/.test(before)) {
      const partial = /\.([\w]*)$/.exec(before)?.[1] ?? '';
      return { from: ctx.pos - partial.length, options: BUILDER };
    }

    // a bare identifier: devices (auto-imported), Home, DSL helpers
    const word = ctx.matchBefore(/[A-Za-z_$][\w$]*/);
    if (!word && !ctx.explicit) return null;
    const from = word?.from ?? ctx.pos;
    return {
      from,
      options: [
        ...handles.map(
          (h): Completion => ({
            label: h.name,
            type: 'variable',
            detail: h.label,
            info: h.where,
            apply: (view, _c, f, t) => {
              const doc = view.state.doc.toString();
              const imp = importChange(doc, h.name);
              const changes = [{ from: f, to: t, insert: h.name }, ...(imp ? [imp] : [])];
              view.dispatch({
                changes,
                selection: {
                  anchor:
                    f +
                    h.name.length +
                    (imp && imp.from < f
                      ? imp.insert.length - ((imp.to ?? imp.from) - imp.from)
                      : 0),
                },
              });
            },
          }),
        ),
        { label: 'Home', type: 'variable', detail: 'location: modes' },
        ...DSL,
      ],
    };
  };
}
