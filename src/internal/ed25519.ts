// Crypto abstraction. Prefers node:crypto; falls back to Web Crypto for
// browsers / Deno where node APIs are unavailable.

export interface Ed25519Key {
  publicKeyRaw: Uint8Array;
  publicKeyPem: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const isNode =
  typeof process !== 'undefined' &&
  typeof (process as { versions?: { node?: string } }).versions?.node === 'string';

// SPKI prefix for Ed25519 public keys (RFC 8410).
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function rawToSpkiDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  const out = new Uint8Array(SPKI_PREFIX.length + 32);
  out.set(SPKI_PREFIX, 0);
  out.set(raw, SPKI_PREFIX.length);
  return out;
}

function spkiDerToRaw(der: Uint8Array): Uint8Array {
  if (der.length !== SPKI_PREFIX.length + 32) {
    throw new Error('ed25519 SPKI: unexpected length');
  }
  for (let i = 0; i < SPKI_PREFIX.length; i++) {
    if (der[i] !== SPKI_PREFIX[i]) throw new Error('ed25519 SPKI: prefix mismatch');
  }
  return der.slice(SPKI_PREFIX.length);
}

function toBase64(bytes: Uint8Array): string {
  if (isNode) {
    return Buffer.from(bytes).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  if (isNode) {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemFromSpkiDer(der: Uint8Array): string {
  const b64 = toBase64(der);
  const wrapped = (b64.match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

function spkiDerFromPem(pem: string): Uint8Array {
  const m = pem.match(/-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/);
  if (!m) throw new Error('ed25519 PEM: header not found');
  const b64 = m[1]!.replace(/\s+/g, '');
  return fromBase64(b64);
}

async function nodeMod(): Promise<typeof import('node:crypto')> {
  return await import('node:crypto');
}

/** Generate a fresh Ed25519 key pair. */
export async function generateEd25519(): Promise<{
  key: Ed25519Key;
  privateKeyRaw: Uint8Array;
}> {
  const raw = new Uint8Array(32);
  if (isNode) {
    const crypto = await nodeMod();
    crypto.randomFillSync(raw);
  } else {
    globalThis.crypto.getRandomValues(raw);
  }
  const { key } = await ed25519FromRawPrivate(raw);
  return { key, privateKeyRaw: raw };
}

/** Hydrate an Ed25519 key from the raw 32-byte private seed. */
export async function ed25519FromRawPrivate(
  privateKey: Uint8Array,
): Promise<{ key: Ed25519Key }> {
  if (privateKey.length !== 32) {
    throw new Error('ed25519 private key must be 32 bytes');
  }
  if (isNode) {
    const crypto = await nodeMod();
    const pkcs8Prefix = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
      0x20,
    ]);
    const pkcs8 = new Uint8Array(pkcs8Prefix.length + 32);
    pkcs8.set(pkcs8Prefix, 0);
    pkcs8.set(privateKey, pkcs8Prefix.length);
    const keyObj = crypto.createPrivateKey({
      key: Buffer.from(pkcs8),
      format: 'der',
      type: 'pkcs8',
    });
    const pubObj = crypto.createPublicKey(keyObj);
    const spkiDer = new Uint8Array(pubObj.export({ format: 'der', type: 'spki' }) as Buffer);
    const publicKeyRaw = spkiDerToRaw(spkiDer);
    const publicKeyPem = pemFromSpkiDer(spkiDer);
    const sign = async (message: Uint8Array): Promise<Uint8Array> => {
      const sig = crypto.sign(null, Buffer.from(message), keyObj);
      return new Uint8Array(sig);
    };
    return { key: { publicKeyRaw, publicKeyPem, sign } };
  }
  // Web Crypto path: import the raw seed via PKCS#8.
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + 32);
  pkcs8.set(pkcs8Prefix, 0);
  pkcs8.set(privateKey, pkcs8Prefix.length);
  const subtle = globalThis.crypto.subtle;
  const privKey = await subtle.importKey(
    'pkcs8',
    pkcs8 as unknown as ArrayBuffer,
    { name: 'Ed25519' } as AlgorithmIdentifier,
    true,
    ['sign'],
  );
  // Derive the public key by re-exporting as JWK and re-importing as 'raw' public.
  const jwk = (await subtle.exportKey('jwk', privKey)) as JsonWebKey & { x: string };
  const publicKeyRaw = fromBase64(jwk.x.replace(/-/g, '+').replace(/_/g, '/'));
  const publicKeyPem = pemFromSpkiDer(rawToSpkiDer(publicKeyRaw));
  const sign = async (message: Uint8Array): Promise<Uint8Array> => {
    const sig = await subtle.sign(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      privKey,
      message as unknown as ArrayBuffer,
    );
    return new Uint8Array(sig);
  };
  return { key: { publicKeyRaw, publicKeyPem, sign } };
}

/** Verify an Ed25519 signature against a PEM-encoded public key. */
export async function verifyEd25519Pem(
  pem: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  let der: Uint8Array;
  try {
    der = spkiDerFromPem(pem);
  } catch {
    return false;
  }
  if (isNode) {
    const crypto = await nodeMod();
    try {
      const pubObj = crypto.createPublicKey({
        key: Buffer.from(der),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, Buffer.from(message), pubObj, Buffer.from(signature));
    } catch {
      return false;
    }
  }
  try {
    const raw = spkiDerToRaw(der);
    const subtle = globalThis.crypto.subtle;
    const pub = await subtle.importKey(
      'raw',
      raw as unknown as ArrayBuffer,
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false,
      ['verify'],
    );
    return await subtle.verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      pub,
      signature as unknown as ArrayBuffer,
      message as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** SHA-256 of `bytes`, lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (isNode) {
    const crypto = await nodeMod();
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i]!.toString(16).padStart(2, '0');
  return s;
}

/** Low-level helpers shared with sibling internal modules and tests. */
export const _internal = { isNode, toBase64, fromBase64, spkiDerFromPem, rawToSpkiDer };
