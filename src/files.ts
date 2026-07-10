import { DepliteError } from './errors.js';
import type { HttpClient } from './internal/http-client.js';
import type { CleanupRule, FileMeta, PresignedUpload, UploadInput } from './models.js';

interface PresignRequestWire {
  bindingId?: string;
  filename?: string;
  contentType?: string;
  cleanupRule: string;
  ttlSeconds?: number;
}

function buildPresignBody(opts: {
  cleanupRule: CleanupRule;
  filename?: string;
  contentType?: string;
  bindingId?: string;
}): PresignRequestWire {
  const body: PresignRequestWire = { cleanupRule: opts.cleanupRule.kind };
  if (opts.cleanupRule.kind === 'ttl') body.ttlSeconds = opts.cleanupRule.ttlSeconds;
  if (opts.filename !== undefined) body.filename = opts.filename;
  if (opts.contentType !== undefined) body.contentType = opts.contentType;
  if (opts.bindingId !== undefined) body.bindingId = opts.bindingId;
  return body;
}

/** File operations exposed by `Deplite.files`. */
export class Files {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly apiToken: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  /** Upload a file in one call (presign + PUT + complete). */
  async upload(options: {
    file: UploadInput;
    cleanupRule?: CleanupRule;
    filename?: string;
    contentType?: string;
    bindingId?: string;
  }): Promise<FileMeta> {
    const rule: CleanupRule = options.cleanupRule ?? { kind: 'ttl', ttlSeconds: 24 * 60 * 60 };
    const filename = options.filename ?? inferFilename(options.file);
    const presign = await this.presignUpload({
      cleanupRule: rule,
      filename,
      contentType: options.contentType,
      bindingId: options.bindingId,
    });
    await putUpload(this.fetchFn, presign, options.file, options.contentType);
    return await this.completeUpload({ fileId: presign.fileId });
  }

  /** Request a presigned upload URL. */
  async presignUpload(options: {
    cleanupRule: CleanupRule;
    filename?: string;
    contentType?: string;
    bindingId?: string;
  }): Promise<PresignedUpload> {
    if (options.cleanupRule.kind === 'on_job_end') {
      throw new DepliteError('OnJobEnd is only valid for embedded agent uploads');
    }
    return this.http.bearer<PresignedUpload>({
      bearer: this.apiToken,
      method: 'POST',
      path: '/storage/files/presign-upload',
      body: buildPresignBody(options),
    });
  }

  /** Confirm that bytes have been PUT to the upload URL. */
  async completeUpload(options: { fileId: string }): Promise<FileMeta> {
    return this.http.bearer<FileMeta>({
      bearer: this.apiToken,
      method: 'POST',
      path: `/storage/files/${encodeURIComponent(options.fileId)}/complete`,
    });
  }

  /** Resolve a short-lived presigned download URL. */
  async downloadUrl(options: { fileId: string }): Promise<string> {
    const res = await this.http.bearer<{ downloadUrl: string }>({
      bearer: this.apiToken,
      method: 'GET',
      path: `/storage/files/${encodeURIComponent(options.fileId)}/download-url`,
    });
    return res.downloadUrl;
  }

  /** Download a file to a local path (Node only). */
  async download(options: { fileId: string; to: string }): Promise<string> {
    const url = await this.downloadUrl(options);
    await downloadToPath(this.fetchFn, url, options.to);
    return options.to;
  }

  async get(options: { fileId: string }): Promise<FileMeta> {
    return this.http.bearer<FileMeta>({
      bearer: this.apiToken,
      method: 'GET',
      path: `/storage/files/${encodeURIComponent(options.fileId)}`,
    });
  }

  async list(options?: { bindingId?: string; status?: string }): Promise<FileMeta[]> {
    const parts: string[] = [];
    if (options?.bindingId) parts.push(`bindingId=${encodeURIComponent(options.bindingId)}`);
    if (options?.status) parts.push(`status=${encodeURIComponent(options.status)}`);
    const query = parts.length > 0 ? `?${parts.join('&')}` : '';
    return this.http.bearer<FileMeta[]>({
      bearer: this.apiToken,
      method: 'GET',
      path: `/storage/files${query}`,
    });
  }

  async delete(options: { fileId: string }): Promise<void> {
    await this.http.bearer<void>({
      bearer: this.apiToken,
      method: 'DELETE',
      path: `/storage/files/${encodeURIComponent(options.fileId)}`,
    });
  }
}

/** Best-effort filename derived from an upload source (path inputs only). */
export function inferFilename(input: UploadInput): string | undefined {
  if ('path' in input) {
    const sep = Math.max(input.path.lastIndexOf('/'), input.path.lastIndexOf('\\'));
    return sep >= 0 ? input.path.slice(sep + 1) : input.path;
  }
  return undefined;
}

/** PUT the upload body to a presigned URL. */
export async function putUpload(
  fetchFn: typeof fetch,
  presign: PresignedUpload,
  file: UploadInput,
  contentType?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (presign.uploadHeaders) {
    for (const [k, v] of Object.entries(presign.uploadHeaders)) headers[k] = v;
  }
  const { body, size } = await materializeBody(file);
  if (size !== undefined && !headers['Content-Length']) {
    headers['Content-Length'] = String(size);
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'PUT',
    headers,
    body: body as BodyInit,
  };
  if (body instanceof ReadableStream) init.duplex = 'half';
  let res: Response;
  try {
    res = await fetchFn(presign.uploadUrl, init);
  } catch (e) {
    throw new DepliteError('upload PUT failed', e);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DepliteError(`upload PUT failed: HTTP ${res.status} ${text}`);
  }
}

async function materializeBody(
  input: UploadInput,
): Promise<{ body: ReadableStream<Uint8Array> | Uint8Array; size?: number }> {
  if ('buffer' in input) return { body: input.buffer, size: input.buffer.byteLength };
  if ('stream' in input) return { body: input.stream, size: input.size };
  const { createReadStream, statSync } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const size = statSync(input.path).size;
  const nodeStream = createReadStream(input.path);
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  return { body: web, size };
}

async function downloadToPath(
  fetchFn: typeof fetch,
  url: string,
  destination: string,
): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new DepliteError('download GET failed', e);
  }
  if (!res.ok || !res.body) {
    throw new DepliteError(`download GET failed: HTTP ${res.status}`);
  }
  const { Writable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const out = fs.createWriteStream(destination);
  const { Readable } = await import('node:stream');
  const nodeStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
  await pipeline(nodeStream, out as unknown as InstanceType<typeof Writable>);
}
