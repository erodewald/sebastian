/**
 * Verifies SmartThings' HTTP Signatures on lifecycle requests, as the webhook docs describe
 * (developer.smartthings.com/docs/service-integrations/webhook-events, "Request Verification"): seb-allow-st-host (docs link)
 *
 *   Authorization: Signature keyId="/pl/…", signature="…", headers="(request-target) digest date",
 *                  algorithm="rsa-sha256"
 *   Digest: SHA256=<base64 sha256 of the body>
 *
 * 1. fetch the X.509 certificate for keyId (the caller supplies that, through InstallDO)
 * 2. rebuild the signing string from the listed headers
 * 3. verify it with RSA-SHA256 (RSASSA-PKCS1-v1_5)
 * 4. check the Digest against the body
 * Plus a freshness check on Date, so an old signed request can't be replayed later.
 */

export const MAX_SKEW_MS = 15 * 60_000;

export interface SignedRequest {
  method: string;
  /** Path plus query, as received. */
  target: string;
  headers: Headers;
  body: Uint8Array;
}

export type Verdict = { ok: true; keyId: string; date: number } | { ok: false; reason: string };

export function parseSignature(header: string | null): Record<string, string> | undefined {
  if (!header?.startsWith('Signature ')) return undefined;
  const out: Record<string, string> = {};
  for (const m of header.slice(10).matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    if (m[1] && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** One DER TLV: tag, where its content starts and ends. */
function tlv(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = der[at] ?? -1;
  let len = der[at + 1] ?? 0;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('bad DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | (der[start + i] ?? 0);
    start += n;
  }
  const end = start + len;
  if (end > der.length) throw new Error('DER overruns buffer');
  return { tag, start, end };
}

/** The SubjectPublicKeyInfo (DER) inside an X.509 certificate (DER). */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
  const cert = tlv(der, 0);
  const tbs = tlv(der, cert.start);
  if (cert.tag !== 0x30 || tbs.tag !== 0x30) throw new Error('not an X.509 certificate');
  let at = tbs.start;
  // version [0] EXPLICIT is optional
  if (der[at] === 0xa0) at = tlv(der, at).end;
  // serialNumber, signature, issuer, validity, subject — then subjectPublicKeyInfo
  for (let i = 0; i < 5; i++) at = tlv(der, at).end;
  const spki = tlv(der, at);
  if (spki.tag !== 0x30) throw new Error('no SubjectPublicKeyInfo');
  return der.slice(at, spki.end);
}

/** Import a PEM certificate (what the SmartThings key host serves) or a PEM public key. */
export async function importVerifyKey(pem: string): Promise<CryptoKey> {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(pem);
  if (!m?.[1] || !m[2]) throw new Error('no PEM block');
  const der = b64(m[2].replace(/\s+/g, ''));
  const spki =
    m[1] === 'CERTIFICATE' ? spkiFromCertificate(der) : m[1] === 'PUBLIC KEY' ? der : undefined;
  if (!spki) throw new Error(`unsupported PEM type ${m[1]}`);
  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export async function verifySignedRequest(
  req: SignedRequest,
  keyPem: (keyId: string) => Promise<string>,
  now = Date.now(),
): Promise<Verdict> {
  const sig = parseSignature(req.headers.get('authorization'));
  if (!sig?.keyId || !sig.signature) return { ok: false, reason: 'no signature' };
  if ((sig.algorithm ?? '').toLowerCase() !== 'rsa-sha256')
    return { ok: false, reason: `algorithm ${sig.algorithm ?? 'missing'}` };
  const names = (sig.headers ?? 'date').toLowerCase().split(/\s+/).filter(Boolean);
  for (const required of ['(request-target)', 'digest', 'date']) {
    if (!names.includes(required)) return { ok: false, reason: `${required} not signed` };
  }

  const dateHeader = req.headers.get('date');
  const date = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (!Number.isFinite(date) || Math.abs(now - date) > MAX_SKEW_MS)
    return { ok: false, reason: 'date missing or not fresh' };

  const digest = req.headers.get('digest') ?? '';
  const [alg, value] = [
    digest.slice(0, digest.indexOf('=')),
    digest.slice(digest.indexOf('=') + 1),
  ];
  if (!/^sha-?256$/i.test(alg)) return { ok: false, reason: 'digest missing or not SHA-256' };
  const actual = toB64(await crypto.subtle.digest('SHA-256', req.body));
  if (actual !== value) return { ok: false, reason: 'digest mismatch' };

  const lines: string[] = [];
  for (const h of names) {
    if (h === '(request-target)')
      lines.push(`(request-target): ${req.method.toLowerCase()} ${req.target}`);
    else {
      const v = req.headers.get(h);
      if (v === null) return { ok: false, reason: `header ${h} missing` };
      lines.push(`${h}: ${v.trim()}`);
    }
  }

  let key: CryptoKey;
  try {
    key = await importVerifyKey(await keyPem(sig.keyId));
  } catch (e) {
    return { ok: false, reason: `key: ${(e as Error).message}` };
  }
  let signature: Uint8Array;
  try {
    signature = b64(sig.signature);
  } catch {
    return { ok: false, reason: 'signature not base64' };
  }
  const good = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(lines.join('\n')),
  );
  return good ? { ok: true, keyId: sig.keyId, date } : { ok: false, reason: 'bad signature' };
}
