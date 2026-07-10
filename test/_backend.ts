import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EnrolledAgentRecord {
  agentId: string;
  name: string;
  publicKeyPem: string;
  hostname?: string;
  os?: string;
  agentVersion?: string;
}

export interface SignedRequestRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface MockBackend {
  url: string;
  apiToken: string;
  installCode: string;
  organizationId: string;
  serverPublicKeyPem: string;
  agents: Map<string, EnrolledAgentRecord>;
  reportedWorkflows: { name: string; agentId: string }[];
  identityPatches: Record<string, unknown>[];
  heartbeats: number;
  logs: { jobId: string; items: unknown[] }[];
  results: { jobId: string; body: Record<string, unknown> }[];
  deployReports: Record<string, unknown>[];
  desiredApps: Record<string, unknown>[];
  streamChunks: string[];
  lastSigned: SignedRequestRecord | null;
  signPayload(payload: unknown): string;
  close(): Promise<void>;
}

// Independent re-implementation of the server's canonical JSON (Go
// encoding/json semantics) so signatures cross-check the SDK encoder
// instead of round-tripping through it.
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return v;
}

function goCanonicalJson(v: unknown): string {
  return JSON.stringify(sortDeep(v)).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function single(h: string | string[] | undefined): string | null {
  return typeof h === 'string' ? h : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.end(message);
}

interface Blob {
  bytes: Buffer;
  filename?: string;
  contentType?: string;
  status: string;
  uploadToken: string;
}

export async function startMockBackend(): Promise<MockBackend> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const serverPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const seenNonces = new Set<string>();
  const blobs = new Map<string, Blob>();
  let installCodeUsed = false;

  const backend: MockBackend = {
    url: '',
    apiToken: 'dpl_e2e_token',
    installCode: 'install-code-e2e',
    organizationId: randomUUID(),
    serverPublicKeyPem,
    agents: new Map(),
    reportedWorkflows: [],
    identityPatches: [],
    heartbeats: 0,
    logs: [],
    results: [],
    deployReports: [],
    desiredApps: [],
    streamChunks: [],
    lastSigned: null,
    signPayload: (payload) =>
      ed25519Sign(null, Buffer.from(goCanonicalJson(payload)), privateKey).toString('base64'),
    close: async () => {},
  };

  function requireSigned(
    method: string,
    path: string,
    req: IncomingMessage,
    body: Buffer,
    res: ServerResponse,
  ): EnrolledAgentRecord | null {
    const agentId = single(req.headers['x-agent-id']);
    const timestamp = single(req.headers['x-timestamp']);
    const nonce = single(req.headers['x-nonce']);
    const signature = single(req.headers['x-signature']);
    if (!agentId || !timestamp || !nonce || !signature) {
      deny(res, 401, 'missing signature headers');
      return null;
    }
    const agent = backend.agents.get(agentId);
    if (!agent) {
      deny(res, 401, 'unknown agent');
      return null;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
      deny(res, 401, 'stale timestamp');
      return null;
    }
    if (seenNonces.has(nonce)) {
      deny(res, 401, 'nonce replay');
      return null;
    }
    const canonical = `${timestamp}\n${nonce}\n${method}\n${path}\n${sha256Hex(body)}`;
    let ok = false;
    try {
      ok = ed25519Verify(
        null,
        Buffer.from(canonical),
        createPublicKey(agent.publicKeyPem),
        Buffer.from(signature, 'base64'),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      deny(res, 401, 'bad signature');
      return null;
    }
    seenNonces.add(nonce);
    backend.lastSigned = {
      method,
      path,
      headers: {
        'x-agent-id': agentId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      body,
    };
    return agent;
  }

  function requireBearer(req: IncomingMessage, res: ServerResponse): boolean {
    if (single(req.headers.authorization) !== `Bearer ${backend.apiToken}`) {
      deny(res, 401, 'invalid api token');
      return false;
    }
    return true;
  }

  function handleEnroll(req: IncomingMessage, body: Buffer, res: ServerResponse): void {
    if (installCodeUsed || single(req.headers.authorization) !== `Bearer ${backend.installCode}`) {
      deny(res, 401, 'invalid install code');
      return;
    }
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    if (typeof parsed.name !== 'string' || typeof parsed.publicKey !== 'string') {
      deny(res, 400, 'name and publicKey are required');
      return;
    }
    let keyOk = false;
    try {
      keyOk = createPublicKey(parsed.publicKey).asymmetricKeyType === 'ed25519';
    } catch {
      keyOk = false;
    }
    if (!keyOk) {
      deny(res, 400, 'publicKey must be an ed25519 SPKI PEM');
      return;
    }
    installCodeUsed = true;
    const agentId = `agt_${randomUUID()}`;
    backend.agents.set(agentId, {
      agentId,
      name: parsed.name,
      publicKeyPem: parsed.publicKey,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : undefined,
      os: typeof parsed.os === 'string' ? parsed.os : undefined,
      agentVersion: typeof parsed.agentVersion === 'string' ? parsed.agentVersion : undefined,
    });
    json(res, 200, {
      agentId,
      organizationId: backend.organizationId,
      serverPublicKey: serverPublicKeyPem,
    });
  }

  function handleAgentRoute(
    method: string,
    path: string,
    agent: EnrolledAgentRecord,
    body: Buffer,
    res: ServerResponse,
  ): void {
    const parsedBody = (): Record<string, unknown> =>
      JSON.parse(body.toString()) as Record<string, unknown>;

    if (method === 'POST' && path === '/agent/heartbeat') {
      backend.heartbeats++;
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === 'PATCH' && path === '/agent/identity') {
      backend.identityPatches.push(parsedBody());
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === 'POST' && path === '/agent/workflows/report') {
      const workflows = parsedBody().workflows as { name: string }[];
      backend.reportedWorkflows = workflows.map((w) => ({ name: w.name, agentId: agent.agentId }));
      json(res, 200, { count: workflows.length });
      return;
    }
    if (method === 'GET' && path === '/agent/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pending = [...backend.streamChunks];
      const timer = setInterval(() => {
        const next = pending.shift();
        if (next === undefined) {
          clearInterval(timer);
          return;
        }
        res.write(next);
      }, 5);
      res.on('close', () => clearInterval(timer));
      return;
    }
    const logsMatch = path.match(/^\/agent\/jobs\/([^/]+)\/logs$/);
    if (method === 'POST' && logsMatch) {
      const items = parsedBody().items as unknown[];
      backend.logs.push({ jobId: decodeURIComponent(logsMatch[1]!), items });
      json(res, 200, { accepted: items.length });
      return;
    }
    const resultMatch = path.match(/^\/agent\/jobs\/([^/]+)\/result$/);
    if (method === 'POST' && resultMatch) {
      backend.results.push({ jobId: decodeURIComponent(resultMatch[1]!), body: parsedBody() });
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === 'GET' && path === '/agent/deploy/desired') {
      json(res, 200, {
        apps: backend.desiredApps.map((p) => ({ payload: p, signature: backend.signPayload(p) })),
      });
      return;
    }
    if (method === 'POST' && path === '/agent/deploy/report') {
      backend.deployReports.push(parsedBody());
      res.statusCode = 204;
      res.end();
      return;
    }
    const presignMatch = path.match(/^\/agent\/jobs\/([^/]+)\/files\/presign-upload$/);
    if (method === 'POST' && presignMatch) {
      const b = parsedBody();
      const fileId = `f_${randomUUID()}`;
      blobs.set(fileId, {
        bytes: Buffer.alloc(0),
        filename: typeof b.filename === 'string' ? b.filename : undefined,
        contentType: typeof b.contentType === 'string' ? b.contentType : undefined,
        status: 'pending',
        uploadToken: `up_${randomUUID()}`,
      });
      json(res, 200, {
        fileId,
        uploadUrl: `${backend.url}/_blob/${fileId}`,
        uploadHeaders: { 'x-upload-token': blobs.get(fileId)!.uploadToken },
      });
      return;
    }
    const fileMatch = path.match(/^\/agent\/files\/([^/]+)(?:\/([a-z-]+))?$/);
    if (fileMatch) {
      const blob = blobs.get(decodeURIComponent(fileMatch[1]!));
      if (!blob) {
        deny(res, 404, 'no such file');
        return;
      }
      const fileId = decodeURIComponent(fileMatch[1]!);
      if (method === 'POST' && fileMatch[2] === 'complete') {
        blob.status = 'stored';
        json(res, 200, {
          id: fileId,
          filename: blob.filename,
          contentType: blob.contentType,
          size: blob.bytes.length,
          status: blob.status,
        });
        return;
      }
      if (method === 'GET' && fileMatch[2] === 'download-url') {
        json(res, 200, { downloadUrl: `${backend.url}/_blob/${fileId}` });
        return;
      }
      if (method === 'GET' && fileMatch[2] === undefined) {
        json(res, 200, { id: fileId, filename: blob.filename, size: blob.bytes.length });
        return;
      }
    }
    deny(res, 404, `no signed route for ${method} ${path}`);
  }

  function handleBearerRoute(
    method: string,
    path: string,
    req: IncomingMessage,
    body: Buffer,
    res: ServerResponse,
  ): void {
    if (method === 'GET' && path === '/token') {
      json(res, 200, {
        organizationId: backend.organizationId,
        name: 'e2e',
        scopes: [{ type: 'agent', agentIds: [...backend.agents.keys()] }],
        rateLimit: { perMinute: null, perHour: null, perDay: null },
        expiresAt: null,
      });
      return;
    }
    if (method === 'GET' && path === '/agents') {
      json(
        res,
        200,
        [...backend.agents.values()].map((a) => ({
          id: a.agentId,
          name: a.name,
          hostname: a.hostname ?? null,
          os: a.os ?? null,
          agentVersion: a.agentVersion ?? null,
          status: 'connected',
          lastSeenAt: null,
          enrolledAt: '2026-07-09T00:00:00.000Z',
        })),
      );
      return;
    }
    if (method === 'GET' && path === '/workflows') {
      json(
        res,
        200,
        backend.reportedWorkflows.map((w, i) => ({
          id: `wf_${i}`,
          agentId: w.agentId,
          name: w.name,
          description: null,
          version: null,
          paramsSchema: null,
        })),
      );
      return;
    }
    const runMatch = path.match(/^\/triggers\/([^/]+)\/run$/);
    if (method === 'POST' && runMatch) {
      void body;
      json(res, 200, {
        jobId: `j_${randomUUID()}`,
        status: 'queued',
        idempotent: false,
        timedOut: false,
      });
      return;
    }
    void req;
    deny(res, 404, `no bearer route for ${method} ${path}`);
  }

  function handleBlob(method: string, path: string, req: IncomingMessage, body: Buffer, res: ServerResponse): void {
    const id = decodeURIComponent(path.slice('/_blob/'.length));
    const blob = blobs.get(id);
    if (!blob) {
      deny(res, 404, 'no such blob');
      return;
    }
    if (method === 'PUT') {
      if (single(req.headers['x-upload-token']) !== blob.uploadToken) {
        deny(res, 403, 'missing upload token');
        return;
      }
      blob.bytes = body;
      res.statusCode = 200;
      res.end();
      return;
    }
    if (method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', blob.contentType ?? 'application/octet-stream');
      res.end(blob.bytes);
      return;
    }
    deny(res, 405, 'unsupported blob method');
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const method = (req.method ?? 'GET').toUpperCase();
      const path = (req.url ?? '/').split('?')[0]!;
      const body = Buffer.concat(chunks);
      try {
        if (method === 'POST' && path === '/agent/enroll') {
          handleEnroll(req, body, res);
          return;
        }
        if (path.startsWith('/_blob/')) {
          handleBlob(method, path, req, body, res);
          return;
        }
        if (path.startsWith('/agent/')) {
          const agent = requireSigned(method, path, req, body, res);
          if (!agent) return;
          handleAgentRoute(method, path, agent, body, res);
          return;
        }
        if (!requireBearer(req, res)) return;
        handleBearerRoute(method, path, req, body, res);
      } catch (e) {
        if (!res.headersSent) deny(res, 500, String(e));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  backend.url = `http://127.0.0.1:${addr.port}`;
  backend.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return backend;
}
