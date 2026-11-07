import { describe, expect, it } from 'vitest';
import { EXAMPLES, GUIDE } from '../src/editor/guide.ts';
import { compileAll } from '../src/sandbox/compile.ts';
import { MODEL } from './fixtures.ts';

describe('editor guide', () => {
  it('every example compiles against a location with the example devices', () => {
    const rs = compileAll(
      MODEL,
      EXAMPLES.map((e) => ({ sourcePath: `automations/${e.id}.ts`, source: e.source })),
    );
    for (const r of rs) expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  });

  it('has unique example ids and says the language is TypeScript', () => {
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect(GUIDE[0]?.title).toMatch(/TypeScript/);
  });
});
