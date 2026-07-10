import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src/deplite-agent.js';
import { canonicalJson } from '../src/internal/canonical-json.js';
import { generateEd25519 } from '../src/internal/ed25519.js';

describe('parseEvent', () => {
  it('returns the matching type for revoke/sync_workflows/ping', async () => {
    expect((await parseEvent('revoke', '', '')).type).toBe('revoke');
    expect((await parseEvent('sync_workflows', '', '')).type).toBe('sync_workflows');
    expect((await parseEvent('workflows-refresh', '', '')).type).toBe('sync_workflows');
    expect((await parseEvent('ping', '', '')).type).toBe('ping');
  });

  it('returns unknown for an unrecognized event name', async () => {
    const ev = await parseEvent('something-new', 'raw', '');
    expect(ev).toEqual({ type: 'unknown', name: 'something-new', data: 'raw' });
  });

  it('verifies a deploy signature and maps snake_case fields', async () => {
    const { key } = await generateEd25519();
    const payload = {
      job_id: 'j-1',
      workflow_name: 'deploy.yml',
      debug: false,
      ref: 'main',
      issued_at: 1700000000,
      nonce: 'abcdef',
      force: false,
    };
    const canonical = new TextEncoder().encode(canonicalJson(payload));
    const sig = await key.sign(canonical);
    const signature = Buffer.from(sig).toString('base64');
    const envelope = JSON.stringify({ payload, signature });
    const ev = await parseEvent('deploy', envelope, key.publicKeyPem);
    if (ev.type !== 'deploy') throw new Error('expected deploy');
    expect(ev.payload.jobId).toBe('j-1');
    expect(ev.payload.workflowName).toBe('deploy.yml');
    expect(ev.payload.issuedAt).toBe(1700000000);
  });

  it('returns unknown on tampered deploy payload', async () => {
    const { key } = await generateEd25519();
    const payload = { job_id: 'j-1', workflow_name: 'deploy.yml', issued_at: 1 };
    const sig = await key.sign(new TextEncoder().encode(canonicalJson(payload)));
    const signature = Buffer.from(sig).toString('base64');
    const envelope = JSON.stringify({ payload: { ...payload, job_id: 'j-2' }, signature });
    const ev = await parseEvent('deploy', envelope, key.publicKeyPem);
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown on malformed envelope JSON', async () => {
    const ev = await parseEvent('deploy', '{not json', 'irrelevant');
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown when the envelope is not an object', async () => {
    const ev = await parseEvent('deploy', '"just a string"', 'irrelevant');
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown when the envelope has no signature', async () => {
    const ev = await parseEvent('deploy', JSON.stringify({ payload: { job_id: 'j' } }), 'pem');
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown when the signature does not decode to a valid one', async () => {
    const { key } = await generateEd25519();
    const envelope = JSON.stringify({
      payload: { job_id: 'j', workflow_name: 'w' },
      signature: '%%%not-base64%%%',
    });
    const ev = await parseEvent('deploy', envelope, key.publicKeyPem);
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown for a validly signed payload missing workflow_name', async () => {
    const { key } = await generateEd25519();
    const payload = { job_id: 'j-1', issued_at: 1 };
    const sig = await key.sign(new TextEncoder().encode(canonicalJson(payload)));
    const envelope = JSON.stringify({ payload, signature: Buffer.from(sig).toString('base64') });
    const ev = await parseEvent('deploy', envelope, key.publicKeyPem);
    expect(ev.type).toBe('unknown');
  });

  it('accepts camelCase deploy payload fields', async () => {
    const { key } = await generateEd25519();
    const payload = {
      jobId: 'j-1',
      workflowName: 'w',
      issuedAt: 5,
      nonce: 'n',
      force: true,
      forceReason: 'ops',
    };
    const sig = await key.sign(new TextEncoder().encode(canonicalJson(payload)));
    const envelope = JSON.stringify({ payload, signature: Buffer.from(sig).toString('base64') });
    const ev = await parseEvent('deploy', envelope, key.publicKeyPem);
    if (ev.type !== 'deploy') throw new Error('expected deploy');
    expect(ev.payload.jobId).toBe('j-1');
    expect(ev.payload.workflowName).toBe('w');
    expect(ev.payload.issuedAt).toBe(5);
    expect(ev.payload.forceReason).toBe('ops');
  });

  it('parses a user cancel event', async () => {
    const data = JSON.stringify({ job_id: 'j-1', reason: 'user requested', actor: 'u-9' });
    const ev = await parseEvent('cancel', data, '');
    expect(ev).toEqual({
      type: 'cancel',
      jobId: 'j-1',
      reason: 'user requested',
      superseded: false,
      actor: 'u-9',
    });
  });

  it('parses a superseded cancel event', async () => {
    const data = JSON.stringify({
      job_id: 'j-1',
      reason: 'superseded by release 1.3.0',
      superseded: true,
    });
    const ev = await parseEvent('cancel', data, '');
    if (ev.type !== 'cancel') throw new Error('expected cancel');
    expect(ev.superseded).toBe(true);
    expect(ev.reason).toBe('superseded by release 1.3.0');
    expect(ev.actor).toBeUndefined();
  });

  it('parses a cancel event with null reason', async () => {
    const data = JSON.stringify({ job_id: 'j-1', reason: null, actor: 'u-9' });
    const ev = await parseEvent('cancel', data, '');
    if (ev.type !== 'cancel') throw new Error('expected cancel');
    expect(ev.reason).toBeNull();
    expect(ev.superseded).toBe(false);
  });

  it('returns unknown on cancel without a job_id', async () => {
    const ev = await parseEvent('cancel', JSON.stringify({ reason: 'x' }), '');
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown on cancel with malformed JSON', async () => {
    const ev = await parseEvent('cancel', '{nope', '');
    expect(ev.type).toBe('unknown');
  });

  it('returns unknown on cancel with a non-string job_id', async () => {
    const ev = await parseEvent('cancel', JSON.stringify({ job_id: 7 }), '');
    expect(ev.type).toBe('unknown');
  });

  it('accepts a camelCase cancel jobId', async () => {
    const ev = await parseEvent('cancel', JSON.stringify({ jobId: 'j-2' }), '');
    expect(ev).toEqual({ type: 'cancel', jobId: 'j-2', reason: null, superseded: false });
  });
});
