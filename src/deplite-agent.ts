import { AgentFiles } from './agent-files.js';
import { AgentJobs } from './agent-jobs.js';
import { AgentWorkflows } from './agent-workflows.js';
import { DepliteError } from './errors.js';
import { canonicalJson } from './internal/canonical-json.js';
import { ed25519FromRawPrivate, verifyEd25519Pem, type Ed25519Key } from './internal/ed25519.js';
import { HttpClient } from './internal/http-client.js';
import { signedSseStream } from './internal/sse.js';
import type { AgentEvent, AgentIdentity, DeployPayload } from './models.js';

/** Options accepted by the {@link DepliteAgent} constructor. */
export interface DepliteAgentOptions {
  identity: AgentIdentity;
  privateKey: Uint8Array;
  fetch?: typeof fetch;
}

/** Entry point for Embedded mode. */
export class DepliteAgent {
  readonly identity: AgentIdentity;
  readonly workflows: AgentWorkflows;
  readonly jobs: AgentJobs;
  readonly files: AgentFiles;
  private readonly http: HttpClient;
  private readonly keyPromise: Promise<Ed25519Key>;
  private readonly fetchFn: typeof fetch;
  private cachedKey: Ed25519Key | null = null;

  constructor(options: DepliteAgentOptions) {
    if (options.privateKey.length !== 32) {
      throw new DepliteError('privateKey must be 32 bytes');
    }
    this.identity = options.identity;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const baseUrl = options.identity.baseUrl.replace(/\/+$/, '');
    this.http = new HttpClient({ baseUrl, fetch: this.fetchFn });
    this.keyPromise = ed25519FromRawPrivate(options.privateKey).then(({ key }) => {
      this.cachedKey = key;
      return key;
    });
    this.workflows = new AgentWorkflows(this.http, options.identity.agentId, this.lazyKey());
    this.jobs = new AgentJobs(this.http, options.identity.agentId, this.lazyKey());
    this.files = new AgentFiles(
      this.http,
      options.identity.agentId,
      this.lazyKey(),
      this.fetchFn,
    );
  }

  /** Send a signed heartbeat. */
  async heartbeat(): Promise<void> {
    const key = await this.keyPromise;
    await this.http.signed<void>({
      agentId: this.identity.agentId,
      key,
      method: 'POST',
      path: '/agent/heartbeat',
    });
  }

  /** Patch the hostname/os/version reported to the backend. */
  async updateIdentity(patch: {
    hostname?: string;
    os?: string;
    agentVersion?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.hostname !== undefined) body.hostname = patch.hostname;
    if (patch.os !== undefined) body.os = patch.os;
    if (patch.agentVersion !== undefined) body.agentVersion = patch.agentVersion;
    const key = await this.keyPromise;
    await this.http.signed<void>({
      agentId: this.identity.agentId,
      key,
      method: 'PATCH',
      path: '/agent/identity',
      body,
    });
  }

  /** Subscribe to the SSE command stream. */
  events(options?: { signal?: AbortSignal }): AsyncIterable<AgentEvent> {
    const serverPub = this.identity.serverPublicKeyPem;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const key = await self.keyPromise;
        const raw = signedSseStream({
          fetch: self.fetchFn,
          baseUrl: self.http.baseUrl,
          path: '/agent/stream',
          agentId: self.identity.agentId,
          key,
          signal: options?.signal,
        });
        for await (const ev of raw) {
          yield await parseEvent(ev.name, ev.data, serverPub);
        }
      },
    };
  }

  private lazyKey(): Ed25519Key {
    // Proxy that defers to the resolved key. Internal classes only need
    // `sign`, `publicKeyPem`, `publicKeyRaw`; we expose them as async-aware
    // shims.
    const self = this;
    return {
      get publicKeyRaw(): Uint8Array {
        if (!self.cachedKey) throw new DepliteError('key not yet initialized');
        return self.cachedKey.publicKeyRaw;
      },
      get publicKeyPem(): string {
        if (!self.cachedKey) throw new DepliteError('key not yet initialized');
        return self.cachedKey.publicKeyPem;
      },
      sign: async (msg: Uint8Array) => {
        const k = await self.keyPromise;
        return k.sign(msg);
      },
    } as Ed25519Key;
  }
}

/** @internal exported for tests. */
export async function parseEvent(
  name: string,
  data: string,
  serverPublicKeyPem: string,
): Promise<AgentEvent> {
  switch (name) {
    case 'deploy':
      return await parseDeploy(data, serverPublicKeyPem);
    case 'revoke':
      return { type: 'revoke' };
    case 'sync_workflows':
    case 'workflows-refresh':
      return { type: 'sync_workflows' };
    case 'ping':
      return { type: 'ping' };
    default:
      return { type: 'unknown', name, data };
  }
}

async function parseDeploy(data: string, serverPublicKeyPem: string): Promise<AgentEvent> {
  let envelope: { payload: unknown; signature: unknown };
  try {
    envelope = JSON.parse(data);
  } catch {
    return { type: 'unknown', name: 'deploy', data };
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.signature !== 'string' ||
    envelope.payload === undefined
  ) {
    return { type: 'unknown', name: 'deploy', data };
  }
  const canonical = new TextEncoder().encode(canonicalJson(envelope.payload));
  let sig: Uint8Array;
  try {
    sig = base64Decode(envelope.signature);
  } catch {
    return { type: 'unknown', name: 'deploy', data };
  }
  const ok = await verifyEd25519Pem(serverPublicKeyPem, canonical, sig);
  if (!ok) return { type: 'unknown', name: 'deploy', data };

  const payload = mapDeployPayload(envelope.payload);
  if (!payload) return { type: 'unknown', name: 'deploy', data };
  return { type: 'deploy', payload, signature: envelope.signature };
}

function mapDeployPayload(raw: unknown): DeployPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const jobId = r.job_id ?? r.jobId;
  const workflowName = r.workflow_name ?? r.workflowName;
  const issuedAt = r.issued_at ?? r.issuedAt;
  const forceReason = r.force_reason ?? r.forceReason;
  if (typeof jobId !== 'string' || typeof workflowName !== 'string') return null;
  return {
    jobId,
    workflowName,
    debug: r.debug === true,
    ref: typeof r.ref === 'string' ? r.ref : undefined,
    params: r.params,
    issuedAt: typeof issuedAt === 'number' ? issuedAt : 0,
    nonce: typeof r.nonce === 'string' ? r.nonce : '',
    force: r.force === true,
    forceReason: typeof forceReason === 'string' ? forceReason : undefined,
  };
}

function base64Decode(s: string): Uint8Array {
  const isNode =
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: string } }).versions?.node === 'string';
  if (isNode) return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
