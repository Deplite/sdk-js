import { sha256Hex } from './ed25519.js';

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Build the canonical message bytes for an Ed25519-signed request. */
export async function buildCanonical(
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  if (path.includes('?')) {
    throw new Error(`signing: path must not contain a query string: ${path}`);
  }
  const bodyHash = body.length === 0 ? EMPTY_BODY_SHA256 : await sha256Hex(body);
  const text = `${timestamp}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
  return new TextEncoder().encode(text);
}

export { EMPTY_BODY_SHA256 };
