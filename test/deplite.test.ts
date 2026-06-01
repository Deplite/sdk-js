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
      expect(req.headers.authorization).toBe('Bearer dep_abc');
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
    const deplite = new Deplite({ apiToken: 'dep_abc', baseUrl: server.url });
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
});
