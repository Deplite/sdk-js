import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Deplite,
  DepliteAgent,
  DepliteAuthError,
  JobResult,
  type AgentEvent,
  type Registration,
} from '../src/index.js';
import { startMockBackend, type MockBackend } from './_backend.js';

describe('e2e: register -> signed requests -> SSE -> deploy -> files', () => {
  let backend: MockBackend;
  let registration: Registration;
  let agent: DepliteAgent;

  beforeAll(async () => {
    backend = await startMockBackend();
    registration = await Deplite.register({
      installCode: backend.installCode,
      name: 'kiosk-e2e',
      hostname: 'host-e2e',
      os: 'linux',
      agentVersion: '0.1.0',
      baseUrl: backend.url,
    });
    agent = new DepliteAgent({
      identity: registration.identity,
      privateKey: registration.privateKey,
    });
  });

  afterAll(async () => {
    await backend.close();
  });

  it('register submits the generated public key and returns the identity', () => {
    expect(registration.privateKey.length).toBe(32);
    expect(registration.identity.organizationId).toBe(backend.organizationId);
    expect(registration.identity.baseUrl).toBe(backend.url);
    expect(registration.identity.serverPublicKeyPem).toBe(backend.serverPublicKeyPem);
    const record = backend.agents.get(registration.identity.agentId);
    expect(record?.name).toBe('kiosk-e2e');
    expect(record?.hostname).toBe('host-e2e');
    expect(record?.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('rejects reuse of the one-time install code', async () => {
    await expect(
      Deplite.register({
        installCode: backend.installCode,
        name: 'second',
        baseUrl: backend.url,
      }),
    ).rejects.toBeInstanceOf(DepliteAuthError);
  });

  it('heartbeat passes real server-side signature verification', async () => {
    await agent.heartbeat();
    expect(backend.heartbeats).toBe(1);
  });

  it('rejects requests signed with a key that was never registered', async () => {
    const impostor = new DepliteAgent({
      identity: registration.identity,
      privateKey: new Uint8Array(randomBytes(32)),
    });
    await expect(impostor.heartbeat()).rejects.toBeInstanceOf(DepliteAuthError);
    expect(backend.heartbeats).toBe(1);
  });

  it('rejects a replayed nonce', async () => {
    await agent.heartbeat();
    const last = backend.lastSigned!;
    const res = await fetch(backend.url + last.path, {
      method: last.method,
      headers: last.headers,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/nonce/);
  });

  it('updateIdentity sends a signed PATCH whose body hash verifies', async () => {
    await agent.updateIdentity({ hostname: 'host-e2e-2', agentVersion: '0.1.1' });
    expect(backend.identityPatches).toEqual([{ hostname: 'host-e2e-2', agentVersion: '0.1.1' }]);
  });

  it('workflows.report round-trips and shows up in the external listing', async () => {
    const count = await agent.workflows.report([
      { name: 'ota.yml', verboseSteps: ['download'] },
      { name: 'diag.yml' },
    ]);
    expect(count).toBe(2);

    const client = new Deplite({ apiToken: backend.apiToken, baseUrl: backend.url });
    const workflows = await client.workflows.list();
    expect(workflows.map((w) => w.name).sort()).toEqual(['diag.yml', 'ota.yml']);
    expect(workflows[0]!.agentId).toBe(registration.identity.agentId);
  });

  it('events() consumes a real SSE stream with a server-signed deploy', async () => {
    const deployPayload = {
      job_id: 'j-sse-1',
      workflow_name: 'ota.yml',
      debug: false,
      ref: 'main',
      // `&` exercises Go-compatible canonical escaping across the wire.
      params: { image: 'registry.example.com/app?tag=2.0.0&arch=arm64' },
      issued_at: 1751980000,
      nonce: 'sse-n-1',
      force: true,
      force_reason: 'operator override',
    };
    const signature = backend.signPayload(deployPayload);
    const envelope = JSON.stringify({ payload: deployPayload, signature });
    backend.streamChunks = [
      ': keepalive\n\n',
      'event: ping\r\ndata:\r\n\r\n',
      `event: deploy\ndata: ${envelope.slice(0, 25)}`,
      `${envelope.slice(25)}\n\n`,
      'event: cancel\ndata: {"job_id":"j-sse-1","reason":"superseded by release 2.1.0","superseded":true}\n\n',
      'data: plain message\n\n',
      'event: note\ndata: line1\ndata: line2\n\n',
    ];

    const collected: AgentEvent[] = [];
    for await (const ev of agent.events()) {
      collected.push(ev);
      if (collected.length >= 5) break;
    }

    expect(collected.map((e) => e.type)).toEqual(['ping', 'deploy', 'cancel', 'unknown', 'unknown']);
    const deploy = collected[1]!;
    if (deploy.type !== 'deploy') throw new Error('expected deploy');
    expect(deploy.payload.jobId).toBe('j-sse-1');
    expect(deploy.payload.workflowName).toBe('ota.yml');
    expect(deploy.payload.params).toEqual({
      image: 'registry.example.com/app?tag=2.0.0&arch=arm64',
    });
    expect(deploy.payload.force).toBe(true);
    expect(deploy.payload.forceReason).toBe('operator override');
    expect(deploy.signature).toBe(signature);
    const cancel = collected[2]!;
    if (cancel.type !== 'cancel') throw new Error('expected cancel');
    expect(cancel.jobId).toBe('j-sse-1');
    expect(cancel.superseded).toBe(true);
    const plain = collected[3]!;
    if (plain.type !== 'unknown') throw new Error('expected unknown');
    expect(plain.name).toBe('message');
    expect(plain.data).toBe('plain message');
    const note = collected[4]!;
    if (note.type !== 'unknown') throw new Error('expected unknown');
    expect(note.data).toBe('line1\nline2');
  });

  it('ships job logs and the final result over signed requests', async () => {
    const accepted = await agent.jobs.appendLogs({
      jobId: 'j-sse-1',
      items: [
        { seq: 1, stream: 'raw', content: 'downloading' },
        { seq: 2, stream: 'system', content: 'installed', level: 'info', stepName: 'install' },
      ],
    });
    expect(accepted).toBe(2);
    expect(backend.logs[0]!.jobId).toBe('j-sse-1');
    expect(backend.logs[0]!.items).toHaveLength(2);

    await agent.jobs.reportResult({
      jobId: 'j-sse-1',
      result: JobResult.success({ output: { installedVersion: '2.0.0' } }),
    });
    expect(backend.results[0]!.jobId).toBe('j-sse-1');
    expect(backend.results[0]!.body).toEqual({
      status: 'success',
      exitCode: 0,
      output: { installedVersion: '2.0.0' },
    });
  });

  it('deploy.desired verifies server-signed manifests fetched over the wire', async () => {
    const manifest = {
      application_id: 'app-e2e',
      slug: 'kiosk-app',
      channel: 'stable',
      update_workflow: 'ota.yml',
      current: { release_id: 'rel-1', version: '1.0.0', sequence: 4 },
      desired: {
        release_id: 'rel-2',
        version: '2.0.0',
        sequence: 7,
        channel: 'stable',
        workflow_name: 'ota.yml',
        checksum_sha256: 'ab'.repeat(32),
        size: 1048576,
        download_url: `${backend.url}/_blob/rel-2?sig=aa&expires=99`,
        download_expires_in: 600,
      },
      min_version: '1.5.0',
      min_sequence: 5,
      forced: false,
      issued_at: 1751980100,
      nonce: 'manifest-n-1',
    };
    backend.desiredApps = [manifest];

    const apps = await agent.deploy.desired();
    expect(apps).toHaveLength(1);
    const app = apps[0]!;
    expect(app.applicationId).toBe('app-e2e');
    expect(app.current?.sequence).toBe(4);
    expect(app.desired?.downloadUrl).toBe(`${backend.url}/_blob/rel-2?sig=aa&expires=99`);
    expect(app.desired?.checksumSha256).toBe('ab'.repeat(32));
    expect(app.minSequence).toBe(5);
  });

  it('deploy.report round-trips the device state', async () => {
    await agent.deploy.report({
      applicationId: 'app-e2e',
      currentVersion: '2.0.0',
      currentReleaseId: 'rel-2',
      currentSequence: 7,
      state: 'idle',
    });
    expect(backend.deployReports).toEqual([
      {
        applicationId: 'app-e2e',
        currentVersion: '2.0.0',
        currentReleaseId: 'rel-2',
        currentSequence: 7,
        state: 'idle',
      },
    ]);
  });

  it('agent files: presign -> PUT with upload headers -> complete -> download round-trip', async () => {
    const bytes = new Uint8Array(randomBytes(64 * 1024));
    const meta = await agent.files.upload({
      jobId: 'j-sse-1',
      file: { buffer: bytes },
      filename: 'artifact.bin',
      contentType: 'application/octet-stream',
    });
    expect(meta.status).toBe('stored');
    expect(meta.size).toBe(bytes.length);
    expect(meta.filename).toBe('artifact.bin');

    const to = join(mkdtempSync(join(tmpdir(), 'deplite-e2e-')), 'artifact.bin');
    await agent.files.download({ fileId: meta.id, to });
    expect(readFileSync(to).equals(Buffer.from(bytes))).toBe(true);
  });

  it('external client reaches the same backend with bearer auth', async () => {
    const client = new Deplite({ apiToken: backend.apiToken, baseUrl: backend.url });

    const info = await client.token.info();
    expect(info.organizationId).toBe(backend.organizationId);
    expect(info.scopes[0]).toEqual({
      type: 'agent',
      agentIds: [registration.identity.agentId],
    });

    const agents = await client.agents.list();
    expect(agents.map((a) => a.id)).toContain(registration.identity.agentId);
    expect(agents[0]!.status).toBe('connected');
    expect(agents[0]!.registeredAt).toBe('2026-07-09T00:00:00.000Z');

    const run = await client.triggers.run({
      triggerId: 'trg-1',
      workflowName: 'ota.yml',
      idempotencyKey: 'idem-e2e',
    });
    expect(run.status).toBe('queued');
    expect(run.jobId).toMatch(/^j_/);

    const bad = new Deplite({ apiToken: 'wrong-token', baseUrl: backend.url });
    await expect(bad.token.info()).rejects.toBeInstanceOf(DepliteAuthError);
  });
});
