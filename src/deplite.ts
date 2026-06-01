import { ed25519FromRawPrivate, generateEd25519 } from './internal/ed25519.js';
import { HttpClient } from './internal/http-client.js';
import type { Enrollment } from './models.js';
import { Files } from './files.js';
import { Triggers } from './triggers.js';

/** Options accepted by the {@link Deplite} constructor. */
export interface DepliteOptions {
  apiToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Entry point for External mode. */
export class Deplite {
  /** Default Deplite cloud base URL. */
  static readonly DEFAULT_BASE_URL = 'https://api.deplite.io/v1';

  readonly apiToken: string;
  readonly baseUrl: string;
  readonly triggers: Triggers;
  readonly files: Files;

  constructor(options: DepliteOptions) {
    this.apiToken = options.apiToken;
    this.baseUrl = (options.baseUrl ?? Deplite.DEFAULT_BASE_URL).replace(/\/+$/, '');
    const fetchFn = options.fetch ?? globalThis.fetch;
    const http = new HttpClient({ baseUrl: this.baseUrl, fetch: fetchFn });
    this.triggers = new Triggers(http, this.apiToken);
    this.files = new Files(http, this.apiToken, fetchFn);
  }

  /** Register a new agent and return its identity + private key. */
  static async enroll(options: {
    installCode: string;
    name: string;
    hostname?: string;
    os?: string;
    agentVersion?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
  }): Promise<Enrollment> {
    const baseUrl = (options.baseUrl ?? Deplite.DEFAULT_BASE_URL).replace(/\/+$/, '');
    const fetchFn = options.fetch ?? globalThis.fetch;
    const http = new HttpClient({ baseUrl, fetch: fetchFn });
    const { key, privateKeyRaw } = await generateEd25519();
    const body: Record<string, unknown> = {
      name: options.name,
      publicKey: key.publicKeyPem,
    };
    if (options.hostname !== undefined) body.hostname = options.hostname;
    if (options.os !== undefined) body.os = options.os;
    if (options.agentVersion !== undefined) body.agentVersion = options.agentVersion;
    const res = await http.bearer<{
      agentId: string;
      organizationId: string;
      serverPublicKey: string;
    }>({
      bearer: options.installCode,
      method: 'POST',
      path: '/agent/enroll',
      body,
    });
    // Roundtrip to ensure the key bytes the caller persists actually
    // reproduce the same public key (guards against silent corruption).
    await ed25519FromRawPrivate(privateKeyRaw);
    return {
      identity: {
        agentId: res.agentId,
        organizationId: res.organizationId,
        baseUrl,
        serverPublicKeyPem: res.serverPublicKey,
      },
      privateKey: privateKeyRaw,
    };
  }
}
