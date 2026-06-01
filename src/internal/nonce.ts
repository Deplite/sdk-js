const isNode =
  typeof process !== 'undefined' &&
  typeof (process as { versions?: { node?: string } }).versions?.node === 'string';

/** 16 random bytes hex-encoded (32 chars, lowercase). */
export async function nextNonce(): Promise<string> {
  const bytes = new Uint8Array(16);
  if (isNode) {
    const c = await import('node:crypto');
    c.randomFillSync(bytes);
  } else {
    globalThis.crypto.getRandomValues(bytes);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}
