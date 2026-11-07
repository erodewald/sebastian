import { generate } from '@sebastian/codegen';
import { compile, predictLocality } from '@sebastian/compiler';
import * as dsl from '@sebastian/dsl';
import type { ModelResponse } from '@sebastian/protocol';
import { transform } from 'sucrase';

/**
 * Compiles automations in the browser, the way `seb plan` does on your machine (ADR-002/006):
 * strip the TypeScript, run the module against the real DSL and the location's generated
 * device handles, then compile the AST to Rules JSON and predict locality.
 *
 * This runs user code, so it only ever runs inside the sandboxed iframe (sandbox.ts): an opaque
 * origin with no network, so code written by one editor can't act as whoever is viewing it.
 */

export interface CompileFile {
  sourcePath: string;
  source: string;
}

export type CompileResult =
  | {
      sourcePath: string;
      ok: true;
      name: string;
      rule: unknown;
      predicted: 'Local' | 'Cloud' | 'Unknown';
      reasons: string[];
    }
  | { sourcePath: string; ok: false; error: string; line?: number };

type Mod = Record<string, unknown>;

function run(code: string, require: (spec: string) => Mod): Mod {
  const module = { exports: {} as Mod };
  // biome-ignore lint/security/noGlobalEval: evaluating user automations is the point; see header
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  return module.exports;
}

const strip = (source: string, filePath: string) =>
  transform(source, { transforms: ['typescript', 'imports'], filePath, production: true }).code;

let cache: { key: string; home: Mod } | undefined;

function homeModule(model: ModelResponse): Mod {
  const key = `${model.location.locationId}:${model.devices.length}:${Object.keys(model.capabilities).length}`;
  if (cache?.key === key) return cache.home;
  const home = run(strip(generate(model, new Date(0)), 'home.generated.ts'), (spec) => {
    if (spec === '@sebastian/dsl') return dsl as unknown as Mod;
    throw new Error(`unexpected import ${spec}`);
  });
  cache = { key, home };
  return home;
}

function lineOf(e: unknown): number | undefined {
  const m = /\((\d+):(\d+)\)/.exec(String((e as Error)?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

/**
 * Where a runtime error happened in the user's file. `new Function` adds two lines of wrapper,
 * and sucrase keeps line numbers, so the first `<anonymous>:L:C` frame is line L − 2.
 */
function runtimeLine(e: unknown, source: string, name?: string): number | undefined {
  const m = /<anonymous>:(\d+):\d+/.exec(String((e as Error)?.stack ?? ''));
  if (m) {
    const l = Number(m[1]) - 2;
    if (l >= 1 && l <= source.split('\n').length) return l;
  }
  if (name) {
    const i = source
      .split('\n')
      .findIndex((line) => new RegExp(`\\b${name}\\b`).test(line) && !/^\s*import\b/.test(line));
    if (i >= 0) return i + 1;
  }
  return undefined;
}

export function compileAll(model: ModelResponse, files: CompileFile[]): CompileResult[] {
  const deviceNames = new Set(Object.keys(homeModuleSafe(model)));
  let home: Mod;
  try {
    home = homeModule(model);
  } catch (e) {
    const error = `generated device handles failed: ${(e as Error).message}`;
    return files.map((f) => ({ sourcePath: f.sourcePath, ok: false, error }));
  }
  const require = (spec: string): Mod => {
    if (spec === '@sebastian/dsl') return dsl as unknown as Mod;
    if (/(^|\/)home\.generated(\.ts)?$/.test(spec)) return home;
    throw new Error(
      `can't import "${spec}" here: only '@sebastian/dsl' and '../generated/home.generated.ts'`,
    );
  };
  return files.map((f): CompileResult => {
    let code: string;
    try {
      code = strip(f.source, f.sourcePath);
    } catch (e) {
      const line = lineOf(e);
      return {
        sourcePath: f.sourcePath,
        ok: false,
        error: (e as Error).message,
        ...(line ? { line } : {}),
      };
    }
    try {
      const mod = run(code, require);
      const a = mod.default as { toAST?: () => dsl.AutomationAST } | undefined;
      if (!a || typeof a.toAST !== 'function')
        throw new Error('default export must be an automation(...) builder');
      const ast = a.toAST();
      const rule = compile(ast, {
        locationId: model.location.locationId,
        timeZoneId: model.location.timeZoneId ?? 'UTC',
      });
      const p = predictLocality(ast);
      return {
        sourcePath: f.sourcePath,
        ok: true,
        name: ast.name,
        rule,
        predicted: p.locality,
        reasons: p.reasons,
      };
    } catch (e) {
      let error = (e as Error).message.split('\n')[0] ?? String(e);
      const undef = /^(\w+) is not defined$/.exec(error)?.[1];
      if (undef && deviceNames.has(undef))
        error += `: add it to the import from '../generated/home.generated.ts'`;
      const line = runtimeLine(e, f.source, undef);
      return { sourcePath: f.sourcePath, ok: false, error, ...(line ? { line } : {}) };
    }
  });
}

function homeModuleSafe(model: ModelResponse): Mod {
  try {
    return homeModule(model);
  } catch {
    return {};
  }
}
