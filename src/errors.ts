/** Base class for all errors thrown by the Deplite SDK. */
export class DepliteError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DepliteError';
    this.cause = cause;
  }
}

/** Non-2xx HTTP response from the Deplite API. */
export class DepliteApiError extends DepliteError {
  readonly statusCode: number;
  readonly body: string;
  constructor(statusCode: number, body: string) {
    super(`Deplite API error ${statusCode}: ${body}`);
    this.name = 'DepliteApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** 401/403 from the Deplite API. */
export class DepliteAuthError extends DepliteApiError {
  constructor(statusCode: number, body: string) {
    super(statusCode, body);
    this.name = 'DepliteAuthError';
  }
}
