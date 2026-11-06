import { describe, expect, it } from 'vitest';
import { compileAll } from '../src/sandbox/compile.ts';
import { MODEL } from './fixtures.ts';

const good = `import { automation, sleep } from '@sebastian/dsl';
import { frontDoor, hallLight } from '../generated/home.generated.ts';

export default automation('Hall light')
  .when(frontDoor.contactSensor.contact.changesTo('open'))
  .do(hallLight.switch.on(), sleep(30), hallLight.switch.off());
`;

describe('compileAll (the browser compiler)', () => {
  it('compiles TypeScript against the generated handles, like seb plan', () => {
    const [r] = compileAll(MODEL, [{ sourcePath: 'automations/hall.ts', source: good }]);
    expect(r).toMatchObject({ ok: true, name: 'Hall light', predicted: 'Local' });
    expect(JSON.stringify(r && r.ok && r.rule)).toContain('dev-door');
  });

  it('reports syntax, type-shape and import errors per file without stopping the others', () => {
    const rs = compileAll(MODEL, [
      { sourcePath: 'automations/syntax.ts', source: 'export default automation(' },
      { sourcePath: 'automations/nodefault.ts', source: 'export const x = 1;' },
      {
        sourcePath: 'automations/import.ts',
        source: "import fs from 'node:fs';\nexport default fs;",
      },
      {
        sourcePath: 'automations/unknown-attr.ts',
        source: good.replace("changesTo('open')", "changesTo('ajar' as never)"),
      },
      { sourcePath: 'automations/hall.ts', source: good },
    ]);
    expect(rs.map((r) => r.ok)).toEqual([false, false, false, false, true]);
    expect(rs[1]).toMatchObject({ error: 'default export must be an automation(...) builder' });
    expect(rs[2] && !rs[2].ok && rs[2].error).toContain("can't import");
    expect(rs[3] && !rs[3].ok && rs[3].error).toMatch(/ajar/);
  });
});

describe('compile errors point at the line', () => {
  it('locates a runtime error and suggests importing a known device', () => {
    const src = good.replace('import { frontDoor, hallLight }', 'import { frontDoor }');
    const [r] = compileAll(MODEL, [{ sourcePath: 'automations/x.ts', source: src }]);
    expect(r).toMatchObject({ ok: false, line: 6 });
    expect(r && !r.ok && r.error).toBe(
      "hallLight is not defined: add it to the import from '../generated/home.generated.ts'",
    );
  });

  it('locates a DSL value error', () => {
    const src = good.replace("changesTo('open')", "changesTo('ajar' as never)");
    const [r] = compileAll(MODEL, [{ sourcePath: 'automations/x.ts', source: src }]);
    expect(r).toMatchObject({ ok: false, line: 5 });
  });
});
