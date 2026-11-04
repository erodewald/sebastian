const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function rawKey(dataKeyB64: string): Uint8Array<ArrayBuffer> {
  const raw = unb64(dataKeyB64);
  if (raw.length !== 32) throw new Error('DATA_KEY must be base64 of exactly 32 bytes');
  return raw;
}

/** Separate subkeys for encryption and MAC, derived from DATA_KEY with HKDF. */
async function subkey(dataKeyB64: string, info: string, usage: 'enc' | 'mac'): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', rawKey(dataKeyB64), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
    ikm,
    usage === 'enc'
      ? { name: 'AES-GCM', length: 256 }
      : { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    usage === 'enc' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
  );
}

/** AES-256-GCM; output is `iv.ciphertext` (base64). `aad` binds the ciphertext to its owner. */
export async function seal(dataKeyB64: string, plaintext: string, aad: string): Promise<string> {
  const key = await subkey(dataKeyB64, 'sebastian/token-vault/v1', 'enc');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function open(dataKeyB64: string, sealed: string, aad: string): Promise<string> {
  const [ivB64, ctB64] = sealed.split('.');
  if (!ivB64 || !ctB64) throw new Error('malformed ciphertext');
  const key = await subkey(dataKeyB64, 'sebastian/token-vault/v1', 'enc');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64), additionalData: enc.encode(aad) },
    key,
    unb64(ctB64),
  );
  return dec.decode(pt);
}

export async function sign(dataKeyB64: string, msg: string): Promise<string> {
  const key = await subkey(dataKeyB64, 'sebastian/oauth-state/v1', 'mac');
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg))));
}

export async function verify(dataKeyB64: string, msg: string, sig: string): Promise<boolean> {
  const expected = await sign(dataKeyB64, msg);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
