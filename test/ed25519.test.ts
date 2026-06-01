import { describe, expect, it } from 'vitest';
import {
  ed25519FromRawPrivate,
  generateEd25519,
  sha256Hex,
  verifyEd25519Pem,
} from '../src/internal/ed25519.js';

describe('ed25519', () => {
  it('generate -> sign -> verify via PEM', async () => {
    const { key } = await generateEd25519();
    const msg = new TextEncoder().encode('hello');
    const sig = await key.sign(msg);
    expect(sig.byteLength).toBe(64);
    expect(await verifyEd25519Pem(key.publicKeyPem, msg, sig)).toBe(true);
  });

  it('tampered message fails verification', async () => {
    const { key } = await generateEd25519();
    const sig = await key.sign(new TextEncoder().encode('hello'));
    expect(await verifyEd25519Pem(key.publicKeyPem, new TextEncoder().encode('hellp'), sig)).toBe(
      false,
    );
  });

  it('raw 32-byte private key round-trips', async () => {
    const { privateKeyRaw, key: original } = await generateEd25519();
    expect(privateKeyRaw.length).toBe(32);
    const { key: rehydrated } = await ed25519FromRawPrivate(privateKeyRaw);
    expect(rehydrated.publicKeyPem).toBe(original.publicKeyPem);
    const msg = new TextEncoder().encode('roundtrip');
    const sig = await rehydrated.sign(msg);
    expect(await verifyEd25519Pem(original.publicKeyPem, msg, sig)).toBe(true);
  });

  it('rejects PEM without a public-key block', async () => {
    expect(
      await verifyEd25519Pem('not a pem', new Uint8Array(), new Uint8Array(64)),
    ).toBe(false);
  });

  it('sha256Hex matches the empty-body constant', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('rejects a private key with wrong length', async () => {
    await expect(ed25519FromRawPrivate(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});
