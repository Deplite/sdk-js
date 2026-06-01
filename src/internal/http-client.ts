import { DepliteApiError, DepliteAuthError, DepliteError } from '../errors.js';
import { buildCanonical } from './canonical-message.js';
import type { Ed25519Key } from './ed25519.js';
import { nextNonce } from './nonce.js';

const isNode =
  typeof process !== 'undefined' &&
  typeof (process as { versions?: { node?: string } }).versions?.node === 'string';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    if (!this.fetchFn) {
      throw new DepliteError('global fetch is unavailable; pass `fetch` explicitly');
    }
  }

  async bearer<T>(options: {
    bearer: string;
    method: string;
    path: string;
    body?: unknown;
    extraHeaders?: Record<string, string>;
  }): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.bearer}`,
    };
    if (options.extraHeaders) {
      for (const [k, v] of Object.entries(options.extraHeaders)) headers[k] = v;
    }
    return this.execute<T>({
      method: options.method,
      path: options.path,
      body: options.body,
      headers,
    });
  }

  async signed<T>(options: {
    agentId: string;
    key: Ed25519Key;
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T> {
    const bytes = encodeJsonBody(options.body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = await nextNonce();
    const canonical = await buildCanonical(timestamp, nonce, options.method, options.path, bytes);
    const signature = toBase64(await options.key.sign(canonical));
    const headers: Record<string, string> = {
      'x-agent-id': options.agentId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    };
    return this.executeRaw<T>({
      method: options.method,
      path: options.path,
      bodyBytes: options.body == null ? null : bytes,
      headers,
    });
  }

  /** Plain GET to an arbitrary external URL. */
  async fetchExternal(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchFn(url, this.withTimeout(init));
  }

  private async execute<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    headers: Record<string, string>;
  }): Promise<T> {
    const bytes = opts.body === undefined ? null : encodeJsonBody(opts.body);
    return this.executeRaw<T>({
      method: opts.method,
      path: opts.path,
      bodyBytes: bytes,
      headers: opts.headers,
    });
  }

  private async executeRaw<T>(opts: {
    method: string;
    path: string;
    bodyBytes: Uint8Array | null;
    headers: Record<string, string>;
  }): Promise<T> {
    const url = this.baseUrl + opts.path;
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.bodyBytes !== null && opts.bodyBytes.length > 0 && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const init: RequestInit = {
      method: opts.method.toUpperCase(),
      headers,
      body: opts.bodyBytes === null ? undefined : (opts.bodyBytes as BodyInit),
    };

    let response: Response;
    try {
      response = await this.fetchFn(url, this.withTimeout(init));
    } catch (e) {
      throw new DepliteError(`HTTP ${opts.method} ${opts.path} failed`, e);
    }
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new DepliteAuthError(response.status, text);
      }
      throw new DepliteApiError(response.status, text);
    }
    if (response.status === 204 || text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new DepliteError(`response is not JSON: ${text.slice(0, 200)}`, e);
    }
  }

  private withTimeout(init?: RequestInit): RequestInit {
    const out: RequestInit = { ...(init ?? {}) };
    if (out.signal) return out;
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      out.signal = (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(
        this.timeoutMs,
      );
    }
    return out;
  }
}

/** JSON-stringify with `undefined` fields omitted (default behaviour). */
export function encodeJsonBody(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  const text = JSON.stringify(body);
  return new TextEncoder().encode(text);
}

function toBase64(bytes: Uint8Array): string {
  if (isNode) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (globalThis as unknown as { Buffer: typeof import('buffer').Buffer }).Buffer.from(
      bytes,
    ).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
