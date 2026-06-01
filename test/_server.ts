import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface Handler {
  (req: RecordedRequest, res: ServerResponse): void | Promise<void>;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
  setHandler(h: Handler): void;
}

export async function startMockServer(initial: Handler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let handler = initial;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', async () => {
      const rec: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(rec);
      try {
        await handler(rec, res);
      } catch (e) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(e));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    setHandler: (h) => {
      handler = h;
    },
  };
}
