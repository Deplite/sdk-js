import { describe, expect, it } from 'vitest';
import { EMPTY_BODY_SHA256, buildCanonical } from '../src/internal/canonical-message.js';
import { sha256Hex } from '../src/internal/ed25519.js';

describe('canonical message', () => {
  it('formats the five-line message', async () => {
    const body = new TextEncoder().encode('{"a":1}');
    const bytes = await buildCanonical('100', 'abc', 'post', '/agent/heartbeat', body);
    const text = new TextDecoder().decode(bytes);
    const hash = await sha256Hex(body);
    expect(text).toBe(`100\nabc\nPOST\n/agent/heartbeat\n${hash}`);
  });

  it('uses the constant SHA-256 for empty body', async () => {
    const bytes = await buildCanonical('1', 'n', 'GET', '/p', new Uint8Array(0));
    expect(new TextDecoder().decode(bytes).endsWith(EMPTY_BODY_SHA256)).toBe(true);
  });

  it('normalizes method to upper case', async () => {
    const bytes = await buildCanonical('1', 'n', 'patch', '/p', new Uint8Array(0));
    expect(new TextDecoder().decode(bytes)).toContain('\nPATCH\n');
  });

  it('rejects a path that contains a query string', async () => {
    await expect(buildCanonical('1', 'n', 'GET', '/p?x=1', new Uint8Array(0))).rejects.toThrow(
      /query string/,
    );
  });
});
