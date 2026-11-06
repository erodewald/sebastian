import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, predictLocality } from '@sebastian/compiler';
import type { AutomationAST } from '@sebastian/dsl';
import { type PlanItem, ruleHash } from '@sebastian/protocol';
import { build } from 'esbuild';

/**
 * Loads a home repo (`automations/*.ts` + `generated/home.generated.ts`), compiles each
 * automation to Rules JSON and predicts its locality. Compilation happens here, client-side:
 * the Worker never runs automation code (ADR-002).
 */

const DSL_ENTRY = fileURLToPath(import.meta.resolve('@sebastian/dsl'));

async function importTs(file: string): Promise<Record<string, unknown>> {
  const out = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    alias: { '@sebastian/dsl': DSL_ENTRY },
    logLevel: 'silent',
  });
  const code = out.outputFiles[0]!.text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

export interface Compiled {
  item: PlanItem;
  ast: AutomationAST;
}

export interface LoadResult {
  location: { id: string; name: string; timeZoneId: string };
  compiled: Compiled[];
  errors: { file: string; message: string }[];
}

export async function loadHome(home: string): Promise<LoadResult> {
  const generated = join(home, 'generated', 'home.generated.ts');
  let gen: Record<string, unknown>;
  try {
    gen = await importTs(generated);
  } catch (e) {
    throw new Error(
      `can't load ${generated}: run \`seb pull\` first (${(e as Error).message.split('\n')[0]})`,
    );
  }
  const location = gen.Home as LoadResult['location'] | undefined;
  if (!location?.id) throw new Error(`${generated} has no Home export: re-run \`seb pull\``);

  const dir = join(home, 'automations');
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();

  const compiled: Compiled[] = [];
  const errors: LoadResult['errors'] = [];
  for (const f of files) {
    const file = join(dir, f);
    const sourcePath = relative(home, file).split(sep).join('/');
    try {
      const mod = await importTs(file);
      const a = mod.default as { toAST?: () => AutomationAST } | undefined;
      if (!a || typeof a.toAST !== 'function') {
        throw new Error('default export must be an automation(...) builder');
      }
      const ast = a.toAST();
      const rule = compile(ast, { locationId: location.id, timeZoneId: location.timeZoneId });
      const prediction = predictLocality(ast);
      const sourceText = await readFile(file, 'utf8');
      const sourceHash = createHash('sha256').update(sourceText).digest('hex');
      compiled.push({
        ast,
        item: {
          sourcePath,
          sourceHash,
          name: ast.name,
          rule: rule as unknown as Record<string, unknown>,
          compiledHash: await ruleHash(rule),
          predicted: prediction.locality,
          reasons: prediction.reasons,
          source: sourceText,
        },
      });
    } catch (e) {
      errors.push({ file: sourcePath, message: (e as Error).message.split('\n')[0] ?? String(e) });
    }
  }
  const names = new Map<string, string>();
  for (const c of compiled) {
    const prev = names.get(c.item.name);
    if (prev)
      errors.push({ file: c.item.sourcePath, message: `same name as ${prev}: "${c.item.name}"` });
    names.set(c.item.name, c.item.sourcePath);
  }
  return { location, compiled, errors };
}
