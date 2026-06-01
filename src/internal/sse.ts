import { DepliteError } from '../errors.js';
import { buildCanonical } from './canonical-message.js';
import type { Ed25519Key } from './ed25519.js';
import { nextNonce } from './nonce.js';

export interface RawSseEvent {
  name: string;
  data: string;
}

const isNode =
  typeof process !== 'undefined' &&
  typeof (process as { versions?: { node?: string } }).versions?.node === 'string';

function toBase64(bytes: Uint8Array): string {
  if (isNode) {
    return Buffer.from(bytes).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Open a signed SSE stream and yield `{name, data}` per event. */
export async function* signedSseStream(opts: {
  fetch: typeof fetch;
  baseUrl: string;
  path: string;
  agentId: string;
  key: Ed25519Key;
  signal?: AbortSignal;
}): AsyncGenerator<RawSseEvent> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = await nextNonce();
  const canonical = await buildCanonical(timestamp, nonce, 'GET', opts.path, new Uint8Array(0));
  const signature = toBase64(await opts.key.sign(canonical));
  const url = opts.baseUrl.replace(/\/+$/, '') + opts.path;

  let response: Response;
  try {
    response = await opts.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'x-agent-id': opts.agentId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return;
    throw new DepliteError('sse: connection failed', e);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DepliteError(`sse: HTTP ${response.status}: ${text}`);
  }
  if (!response.body) {
    throw new DepliteError('sse: response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let eventName = '';
  const dataLines: string[] = [];

  const flush = (): RawSseEvent | null => {
    if (dataLines.length === 0 && eventName === '') return null;
    const out: RawSseEvent = {
      name: eventName || 'message',
      data: dataLines.join('\n'),
    };
    eventName = '';
    dataLines.length = 0;
    return out;
  };

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        throw new DepliteError('sse: stream read failed', e);
      }
      if (chunk.done) {
        const ev = flush();
        if (ev) yield ev;
        throw new DepliteError('sse: closed');
      }
      buf += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        let field: string;
        let value: string;
        if (colon < 0) {
          field = line;
          value = '';
        } else {
          field = line.slice(0, colon);
          value = line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
        }
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
        // id, retry, unknown -> ignore
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}
