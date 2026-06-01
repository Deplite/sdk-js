import { DepliteError } from './errors.js';
import { putUpload, inferFilename } from './files.js';
import type { Ed25519Key } from './internal/ed25519.js';
import type { HttpClient } from './internal/http-client.js';
import type { CleanupRule, FileMeta, PresignedUpload, UploadInput } from './models.js';

interface PresignWire {
  filename?: string;
  contentType?: string;
  cleanupRule: string;
  ttlSeconds?: number;
}

function buildPresignBody(opts: {
  cleanupRule: CleanupRule;
  filename?: string;
  contentType?: string;
}): PresignWire {
  const body: PresignWire = { cleanupRule: opts.cleanupRule.kind };
  if (opts.cleanupRule.kind === 'ttl') body.ttlSeconds = opts.cleanupRule.ttlSeconds;
  if (opts.filename !== undefined) body.filename = opts.filename;
  if (opts.contentType !== undefined) body.contentType = opts.contentType;
  return body;
}

/** Agent-scope file operations exposed by `DepliteAgent.files`. */
export class AgentFiles {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly agentId: string,
    private readonly key: Ed25519Key,
    private readonly fetchFn: typeof fetch,
  ) {}

  async upload(options: {
    jobId: string;
    file: UploadInput;
    cleanupRule?: CleanupRule;
    filename?: string;
    contentType?: string;
  }): Promise<FileMeta> {
    const rule: CleanupRule = options.cleanupRule ?? { kind: 'on_job_end' };
    const filename = options.filename ?? inferFilename(options.file);
    const presign = await this.presignUpload({
      jobId: options.jobId,
      cleanupRule: rule,
      filename,
      contentType: options.contentType,
    });
    await putUpload(this.fetchFn, presign, options.file, options.contentType);
    return await this.complete({ fileId: presign.fileId });
  }

  async presignUpload(options: {
    jobId: string;
    cleanupRule?: CleanupRule;
    filename?: string;
    contentType?: string;
  }): Promise<PresignedUpload> {
    const rule: CleanupRule = options.cleanupRule ?? { kind: 'on_job_end' };
    return this.http.signed<PresignedUpload>({
      agentId: this.agentId,
      key: this.key,
      method: 'POST',
      path: `/agent/jobs/${encodeURIComponent(options.jobId)}/files/presign-upload`,
      body: buildPresignBody({
        cleanupRule: rule,
        filename: options.filename,
        contentType: options.contentType,
      }),
    });
  }

  async complete(options: { fileId: string }): Promise<FileMeta> {
    return this.http.signed<FileMeta>({
      agentId: this.agentId,
      key: this.key,
      method: 'POST',
      path: `/agent/files/${encodeURIComponent(options.fileId)}/complete`,
    });
  }

  async downloadUrl(options: { fileId: string }): Promise<string> {
    const res = await this.http.signed<{ downloadUrl: string }>({
      agentId: this.agentId,
      key: this.key,
      method: 'GET',
      path: `/agent/files/${encodeURIComponent(options.fileId)}/download-url`,
    });
    return res.downloadUrl;
  }

  async download(options: { fileId: string; to: string }): Promise<string> {
    const url = await this.downloadUrl(options);
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.dirname(options.to), { recursive: true });
    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch (e) {
      throw new DepliteError('download GET failed', e);
    }
    if (!res.ok || !res.body) {
      throw new DepliteError(`download GET failed: HTTP ${res.status}`);
    }
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const out = fs.createWriteStream(options.to);
    const nodeStream = Readable.fromWeb(
      res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
    );
    await pipeline(nodeStream, out);
    return options.to;
  }

  async get(options: { fileId: string }): Promise<FileMeta> {
    return this.http.signed<FileMeta>({
      agentId: this.agentId,
      key: this.key,
      method: 'GET',
      path: `/agent/files/${encodeURIComponent(options.fileId)}`,
    });
  }

  async delete(options: { fileId: string }): Promise<void> {
    await this.http.signed<void>({
      agentId: this.agentId,
      key: this.key,
      method: 'DELETE',
      path: `/agent/files/${encodeURIComponent(options.fileId)}`,
    });
  }
}
