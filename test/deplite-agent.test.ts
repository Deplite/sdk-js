import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DepliteAgent } from '../src/index.js';
import { canonicalJson } from '../src/internal/canonical-json.js';
import { generateEd25519 } from '../src/internal/ed25519.js';
import { startMockServer, type MockServer } from './_server.js';

async function newAgent(server: MockServer): Promise<{
  agent: DepliteAgent;
  serverKey: { publicKeyPem: string; sign: (m: Uint8Array) => Promise<Uint8Array> };
}> {
  const { key, privateKeyRaw } = await generateEd25519();
  const server2 = await generateEd25519();
  const agent = new DepliteAgent({
    identity: {
      agentId: 'a-1',
      organizationId: 'org-1',
      baseUrl: server.url,
      serverPublicKeyPem: server2.key.publicKeyPem,
    },
    privateKey: privateKeyRaw,
  });
  // Reference the agent key implicitly so test sees signed headers exist.
  void key;
  return { agent, serverKey: server2.key };
}

describe('DepliteAgent (Embedded)', () => {
  let server: MockServer;

  beforeEach(async () => {
    server = await startMockServer(() => {});
  });

  afterEach(async () => {
    await server.close();
  });

  it('throws if private key length is not 32', () => {
    expect(
      () =>
        new DepliteAgent({
          identity: {
            agentId: 'a-1',
            organizationId: 'o',
            baseUrl: server.url,
            serverPublicKeyPem: '',
          },
          privateKey: new Uint8Array(16),
        }),
    ).toThrow(/32 bytes/);
  });

  it('heartbeat sends the four signed headers', async () => {
    const { agent } = await newAgent(server);
    server.setHandler((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/agent/heartbeat');
      expect(req.headers['x-agent-id']).toBe('a-1');
      expect(typeof req.headers['x-timestamp']).toBe('string');
      expect(typeof req.headers['x-nonce']).toBe('string');
      expect(typeof req.headers['x-signature']).toBe('string');
      res.statusCode = 204;
      res.end();
    });
    await agent.heartbeat();
  });

  it('workflows.report parses {count}', async () => {
    const { agent } = await newAgent(server);
    server.setHandler((req, res) => {
      expect(req.url).toBe('/agent/workflows/report');
      const body = JSON.parse(req.body.toString());
      expect(body.workflows[0].name).toBe('w-1');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ count: 7 }));
    });
    const count = await agent.workflows.report([{ name: 'w-1', verboseSteps: ['step-a'] }]);
    expect(count).toBe(7);
  });

  it('updateIdentity sends a PATCH', async () => {
    const { agent } = await newAgent(server);
    server.setHandler((req, res) => {
      expect(req.method).toBe('PATCH');
      expect(req.url).toBe('/agent/identity');
      const body = JSON.parse(req.body.toString());
      expect(body).toEqual({ hostname: 'h1', agentVersion: 'v1' });
      res.statusCode = 204;
      res.end();
    });
    await agent.updateIdentity({ hostname: 'h1', agentVersion: 'v1' });
  });

  it('appendLogs with empty array returns 0 without a network call', async () => {
    const { agent } = await newAgent(server);
    server.setHandler(() => {
      throw new Error('should not be called');
    });
    const accepted = await agent.jobs.appendLogs({ jobId: 'j-1', items: [] });
    expect(accepted).toBe(0);
    expect(server.requests.length).toBe(0);
  });

  it('events() parses chunked SSE responses', async () => {
    const { agent, serverKey } = await newAgent(server);
    const payload = {
      job_id: 'j-1',
      workflow_name: 'wf',
      issued_at: 1,
      nonce: 'n',
      force: false,
      debug: false,
    };
    const sig = await serverKey.sign(new TextEncoder().encode(canonicalJson(payload)));
    const signatureB64 = Buffer.from(sig).toString('base64');
    const envelope = JSON.stringify({ payload, signature: signatureB64 });

    server.setHandler((req, res) => {
      expect(req.url).toBe('/agent/stream');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`event: ping\ndata: \n\n`);
      res.write(`event: deploy\ndata: ${envelope}\n\n`);
      res.end();
    });

    const events = agent.events();
    const collected: string[] = [];
    try {
      for await (const ev of events) {
        collected.push(ev.type);
        if (collected.length >= 2) break;
      }
    } catch (e) {
      // sse closed at the end -> tolerated
      void e;
    }
    expect(collected).toEqual(['ping', 'deploy']);
  });

  it('deploy.desired verifies and maps signed manifests', async () => {
    const { agent, serverKey } = await newAgent(server);
    const payload = {
      application_id: 'app-1',
      slug: 'my-app',
      channel: 'stable',
      update_workflow: 'ota.yml',
      current: { release_id: 'r-1', version: '1.0.0', sequence: 10 },
      desired: {
        release_id: 'r-2',
        version: '1.1.0',
        sequence: 11,
        channel: 'stable',
        workflow_name: 'ota.yml',
        checksum_sha256: 'deadbeef',
        size: 1234,
        // `&` in the presigned URL exercises the Go-compatible canonical escaping.
        download_url: 'https://s3.example.com/o?a=1&b=2',
        download_expires_in: 3600,
      },
      min_version: '1.0.0',
      min_sequence: 5,
      forced: false,
      issued_at: 1700000000,
      nonce: 'n-1',
    };
    const sig = await serverKey.sign(new TextEncoder().encode(canonicalJson(payload)));
    const signature = Buffer.from(sig).toString('base64');
    server.setHandler((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/agent/deploy/desired');
      expect(typeof req.headers['x-signature']).toBe('string');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ apps: [{ payload, signature }] }));
    });
    const apps = await agent.deploy.desired();
    expect(apps.length).toBe(1);
    expect(apps[0]!.applicationId).toBe('app-1');
    expect(apps[0]!.current?.sequence).toBe(10);
    expect(apps[0]!.desired?.workflowName).toBe('ota.yml');
    expect(apps[0]!.desired?.downloadUrl).toBe('https://s3.example.com/o?a=1&b=2');
    expect(apps[0]!.minSequence).toBe(5);
  });

  it('deploy.desired rejects a tampered manifest', async () => {
    const { agent, serverKey } = await newAgent(server);
    const payload = {
      application_id: 'app-1',
      slug: 'my-app',
      current: null,
      desired: null,
      min_version: null,
      min_sequence: 0,
      forced: false,
      issued_at: 1,
      nonce: 'n',
    };
    const sig = await serverKey.sign(new TextEncoder().encode(canonicalJson(payload)));
    const signature = Buffer.from(sig).toString('base64');
    server.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ apps: [{ payload: { ...payload, slug: 'evil' }, signature }] }));
    });
    await expect(agent.deploy.desired()).rejects.toThrow(/verification failed for evil/);
  });

  it('deploy.desired rejects an empty signature', async () => {
    const { agent } = await newAgent(server);
    const payload = { application_id: 'app-1', slug: 'my-app' };
    server.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ apps: [{ payload, signature: '' }] }));
    });
    await expect(agent.deploy.desired()).rejects.toThrow(/verification failed/);
  });

  it('deploy.report sends a camelCase body and omits undefined fields', async () => {
    const { agent } = await newAgent(server);
    server.setHandler((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/agent/deploy/report');
      expect(typeof req.headers['x-signature']).toBe('string');
      const body = JSON.parse(req.body.toString());
      expect(body).toEqual({
        applicationId: 'app-1',
        currentVersion: '1.0.0',
        state: 'idle',
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await agent.deploy.report({
      applicationId: 'app-1',
      currentVersion: '1.0.0',
      state: 'idle',
    });
  });

  it('events({signal}) terminates when aborted', async () => {
    const { agent } = await newAgent(server);
    server.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      // Keep open without writing any events; we'll abort below.
      res.write(': keepalive\n\n');
    });
    const controller = new AbortController();
    const events = agent.events({ signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    let count = 0;
    try {
      for await (const _ev of events) {
        count++;
      }
    } catch (e) {
      void e;
    }
    expect(count).toBe(0);
  });
});
