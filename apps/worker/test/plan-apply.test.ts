import {
  createExecutionContext,
  env,
  introspectWorkflow,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { ruleHash } from '@sebastian/protocol';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { json, stubFor, tokens, wire } from './helpers';

const IAID = 'ia-m1';
const LOC = 'loc-m1';
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  app = createApp({ accessKeys: createLocalJWKSet({ keys: [jwk] }) });
  token = await new SignJWT({ common_name: 'seb-cli.access' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://test.cloudflareaccess.com')
    .setAudience('test-aud')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(kp.privateKey as CryptoKey);
});

async function call(path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://sebastian.baltar.media${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'cf-access-jwt-assertion': token,
        'x-seb-install': IAID,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function item(sourcePath: string, label: string) {
  const rule = {
    name: `[seb] ${label}`,
    timeZoneId: 'America/Chicago',
    actions: [{ sleep: { duration: { value: { integer: 1 }, unit: 'Second' } } }],
  };
  return {
    sourcePath,
    sourceHash: 'a'.repeat(64),
    name: label,
    rule,
    compiledHash: await ruleHash(rule),
    predicted: 'Local' as const,
    reasons: [],
  };
}

/** A fake Rules API: rules live in a Map, executionLocation is always Local. */
let forbidExecute = false;

async function installWithFakeRules() {
  const stub = stubFor(IAID);
  await stub.completeAuth(IAID, tokens(1));
  await stub.setLocationId(LOC);
  const rules = new Map<string, unknown>();
  let n = 0;
  const calls = await wire(stub, async (url, init) => {
    const m = init.method ?? 'GET';
    expect(url.searchParams.get('locationId')).toBe(LOC);
    if (m === 'POST' && url.pathname === '/v1/rules') {
      const id = `rule-${++n}`;
      rules.set(id, JSON.parse(String(init.body)));
      return json({ id });
    }
    const id = url.pathname.split('/').at(-1) ?? '';
    if (url.pathname.startsWith('/v1/rules/execute/')) {
      return forbidExecute
        ? json(
            { error: { code: 'ForbiddenError', message: 'execute-behavior-fail-invalid-scopes' } },
            403,
          )
        : json({ result: 'Success' });
    }
    if (!rules.has(id)) return json({ error: 'not found' }, 404);
    if (m === 'GET') return json({ id, executionLocation: 'Local' });
    if (m === 'PUT') {
      rules.set(id, JSON.parse(String(init.body)));
      return json({ id });
    }
    if (m === 'DELETE') {
      rules.delete(id);
      return new Response(null, { status: 204 });
    }
    return json({}, 400);
  });
  return { rules, calls };
}

async function applyAndWait(body: unknown) {
  await using wf = await introspectWorkflow(env.APPLY);
  await wf.modifyAll(async (m) => m.disableSleeps());
  const res = await call('/api/apply', body);
  const out = (await res.json()) as { instanceId: string | null; ops: { op: string }[] };
  if (out.instanceId) {
    const [instance] = await wf.get();
    await instance!.waitForStatus('complete');
    const status = (await (await call(`/api/apply/${out.instanceId}`)).json()) as {
      status: string;
      results: { op: string; actual?: string }[];
    };
    return { res, out, status };
  }
  return { res, out, status: undefined };
}

describe('plan and apply', () => {
  it('rejects a rule whose hash does not match', async () => {
    await installWithFakeRules();
    const it1 = await item('automations/a.ts', 'A');
    const res = await call('/api/plan', { items: [{ ...it1, compiledHash: 'b'.repeat(64) }] });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/compiledHash does not match/);
  });

  it('creates, reads back locality, records, then no-ops, updates and prunes', async () => {
    const { rules } = await installWithFakeRules();
    const a = await item('automations/a.ts', 'A');
    const b = await item('automations/b.ts', 'B');

    const plan = (await (await call('/api/plan', { items: [a, b] })).json()) as {
      ops: { op: string }[];
    };
    expect(plan.ops.map((o) => o.op)).toEqual(['create', 'create']);

    const first = await applyAndWait({ items: [a, b] });
    expect(first.res.status).toBe(202);
    expect(first.status?.status).toBe('complete');
    expect(first.status?.results.map((r) => [r.op, r.actual])).toEqual([
      ['create', 'Local'],
      ['create', 'Local'],
    ]);
    expect(rules.size).toBe(2);

    const listed = (await (await call('/api/rules')).json()) as {
      sourcePath: string;
      actual: string;
    }[];
    expect(listed.map((r) => [r.sourcePath, r.actual])).toEqual([
      ['automations/a.ts', 'Local'],
      ['automations/b.ts', 'Local'],
    ]);

    // Unchanged source → nothing to do, no workflow.
    const again = await applyAndWait({ items: [a, b] });
    expect(again.out.instanceId).toBeNull();
    expect(again.out.ops.map((o) => o.op)).toEqual(['noop', 'noop']);

    // Change A, drop B → update + delete.
    const a2 = await item('automations/a.ts', 'A renamed');
    const second = await applyAndWait({ items: [a2] });
    expect(second.out.ops.map((o) => o.op)).toEqual(['update', 'delete']);
    expect(second.status?.results.map((r) => r.op)).toEqual(['update', 'delete']);
    expect(rules.size).toBe(1);
    expect([...rules.values()][0]).toMatchObject({ name: '[seb] A renamed' });

    // destroy --all
    const gone = await applyAndWait({ items: [], prune: true });
    expect(gone.out.ops.map((o) => o.op)).toEqual(['delete']);
    expect(rules.size).toBe(0);
    expect(await (await call('/api/rules')).json()).toEqual([]);
  });

  it('recreates a rule that was deleted out-of-band during update', async () => {
    const { rules } = await installWithFakeRules();
    const a = await item('automations/c.ts', 'C');
    await applyAndWait({ items: [a] });
    rules.clear(); // someone deleted it in the app
    const a2 = await item('automations/c.ts', 'C v2');
    const r = await applyAndWait({ items: [a2] });
    expect(r.status?.results[0]).toMatchObject({ op: 'update', actual: 'Local' });
    expect(rules.size).toBe(1);
    const listed = (await (await call('/api/rules')).json()) as { ruleId: string }[];
    expect(listed).toHaveLength(1);
    expect(rules.has(listed[0]!.ruleId)).toBe(true);
  });

  it('runs only managed rules', async () => {
    await installWithFakeRules();
    expect((await call('/api/rules/not-mine/execute', {})).status).toBe(404);
    const a = await item('automations/d.ts', 'D');
    await applyAndWait({ items: [a] });
    const [r] = (await (await call('/api/rules')).json()) as { ruleId: string }[];
    const res = await call(`/api/rules/${r!.ruleId}/execute`, {});
    expect(await res.json()).toEqual({ result: 'Success' });

    // A SmartThings refusal (e.g. missing x:rules:*) is a 502 with its message, not a 500.
    forbidExecute = true;
    const denied = await call(`/api/rules/${r!.ruleId}/execute`, {});
    forbidExecute = false;
    expect(denied.status).toBe(502);
    expect(await denied.json()).toMatchObject({
      error: 'smartthings_rejected',
      detail: expect.stringMatching(/403.*execute-behavior-fail-invalid-scopes/),
    });
  });
});
