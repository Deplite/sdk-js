import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deplite, DepliteApiError, DepliteAuthError, DepliteError } from '../src/index.js';
import { startMockServer, type MockServer } from './_server.js';

describe('Deplite (External)', () => {
  let server: MockServer;

  beforeEach(async () => {
    server = await startMockServer(() => {});
  });

  afterEach(async () => {
    await server.close();
  });

  it('runs a trigger with bearer auth and Idempotency-Key', async () => {
    server.setHandler((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/triggers/t-1/run');
      expect(req.headers.authorization).toBe('Bearer dpl_abc');
      expect(req.headers['idempotency-key']).toBe('idem-1');
      const body = JSON.parse(req.body.toString());
      expect(body).toEqual({
        workflowName: 'deploy.yml',
        ref: 'main',
        debug: true,
        params: { x: 1 },
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jobId: 'j-1', status: 'queued' }));
    });
    const deplite = new Deplite({ apiToken: 'dpl_abc', baseUrl: server.url });
    const r = await deplite.triggers.run({
      triggerId: 't-1',
      params: { x: 1 },
      workflowName: 'deploy.yml',
      ref: 'main',
      debug: true,
      idempotencyKey: 'idem-1',
    });
    expect(r).toEqual({
      jobId: 'j-1',
      status: 'queued',
      idempotent: false,
      timedOut: false,
      exitCode: undefined,
      errorMessage: undefined,
      output: undefined,
      statusUrl: undefined,
    });
  });

  it('throws DepliteAuthError on 401', async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 401;
      res.end('nope');
    });
    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    await expect(deplite.triggers.run({ triggerId: 't' })).rejects.toBeInstanceOf(DepliteAuthError);
  });

  it('throws DepliteApiError on 500', async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    await expect(deplite.triggers.run({ triggerId: 't' })).rejects.toBeInstanceOf(DepliteApiError);
  });

  it('uploads a file via the three-step flow (path input)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'deplite-test-'));
    const filePath = join(tmp, 'hello.txt');
    writeFileSync(filePath, 'hello-world');

    server.setHandler((req, res) => {
      if (req.url === '/storage/files/presign-upload' && req.method === 'POST') {
        const body = JSON.parse(req.body.toString());
        expect(body.cleanupRule).toBe('ttl');
        expect(body.ttlSeconds).toBe(60);
        expect(body.filename).toBe('hello.txt');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ fileId: 'f-1', uploadUrl: `${server.url}/_put/f-1` }),
        );
        return;
      }
      if (req.url === '/_put/f-1' && req.method === 'PUT') {
        expect(req.body.toString()).toBe('hello-world');
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.url === '/storage/files/f-1/complete' && req.method === 'POST') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'f-1', filename: 'hello.txt', size: 11 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    const meta = await deplite.files.upload({
      file: { path: filePath },
      cleanupRule: { kind: 'ttl', ttlSeconds: 60 },
    });
    expect(meta.id).toBe('f-1');
  });

  it('rejects on_job_end cleanup rule on External uploads', async () => {
    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    await expect(
      deplite.files.presignUpload({ cleanupRule: { kind: 'on_job_end' } }),
    ).rejects.toBeInstanceOf(DepliteError);
  });

  it('reads the token self-description', async () => {
    server.setHandler((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/token');
      expect(req.headers.authorization).toBe('Bearer dpl_abc');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          organizationId: '11111111-1111-1111-1111-111111111111',
          name: 'ci',
          scopes: [
            { type: 'agent', agentIds: ['a-1'] },
            { type: 'storage', bindingIds: null, permissions: ['read', 'write'] },
          ],
          rateLimit: { perMinute: 60, perHour: null, perDay: null },
          expiresAt: null,
        }),
      );
    });
    const deplite = new Deplite({ apiToken: 'dpl_abc', baseUrl: server.url });
    const info = await deplite.token.info();
    expect(info.organizationId).toBe('11111111-1111-1111-1111-111111111111');
    expect(info.name).toBe('ci');
    expect(info.scopes[0]).toEqual({ type: 'agent', agentIds: ['a-1'] });
    expect(info.rateLimit.perMinute).toBe(60);
    expect(info.expiresAt).toBeNull();
  });

  it('lists the agents the token can reach', async () => {
    server.setHandler((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/agents');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          {
            id: 'a-1',
            name: 'kiosk-1',
            hostname: null,
            os: 'linux',
            agentVersion: '0.1.0',
            status: 'connected',
            lastSeenAt: '2026-07-09T00:00:00.000Z',
            enrolledAt: '2026-07-01T00:00:00.000Z',
          },
        ]),
      );
    });
    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    const agents = await deplite.agents.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe('connected');
    expect(agents[0]!.hostname).toBeNull();
    expect(agents[0]!.registeredAt).toBe('2026-07-01T00:00:00.000Z');
    expect(agents[0]).not.toHaveProperty('enrolledAt');
  });

  it('lists the workflows the token can run', async () => {
    server.setHandler((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/workflows');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          {
            id: 'w-1',
            agentId: 'a-1',
            name: 'deploy',
            description: null,
            version: '1.2.0',
            paramsSchema: [{ name: 'ref', type: 'string', required: true }],
          },
        ]),
      );
    });
    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    const workflows = await deplite.workflows.list();
    expect(workflows[0]!.name).toBe('deploy');
    expect(workflows[0]!.paramsSchema?.[0]).toEqual({
      name: 'ref',
      type: 'string',
      required: true,
    });
  });

  it('surfaces a read rate limit as DepliteApiError with the token_read scope', async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded for api token reads (minute: 60/60)',
          scope: 'token_read',
          window: 'minute',
          limit: 60,
          observed: 60,
        }),
      );
    });
    const deplite = new Deplite({ apiToken: 'x', baseUrl: server.url });
    const err = await deplite.agents.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DepliteApiError);
    expect((err as DepliteApiError).statusCode).toBe(429);
    expect(JSON.parse((err as DepliteApiError).body).scope).toBe('token_read');
  });
});
