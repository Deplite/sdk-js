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
});
