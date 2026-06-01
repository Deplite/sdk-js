import type { HttpClient } from './internal/http-client.js';
import type { TriggerRunResult } from './models.js';

/** Options accepted by {@link Triggers.run}. */
export interface TriggerRunOptions {
  triggerId: string;
  params?: unknown;
  workflowName?: string;
  ref?: string;
  debug?: boolean;
  idempotencyKey?: string;
}

/** Trigger operations exposed by `Deplite.triggers`. */
export class Triggers {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly apiToken: string,
  ) {}

  /** Invoke a trigger: `POST /triggers/{triggerId}/run`. */
  async run(options: TriggerRunOptions): Promise<TriggerRunResult> {
    const body: Record<string, unknown> = {};
    if (options.workflowName !== undefined) body.workflowName = options.workflowName;
    if (options.ref !== undefined) body.ref = options.ref;
    if (options.debug === true) body.debug = true;
    if (options.params !== undefined) body.params = options.params;

    const extra: Record<string, string> | undefined = options.idempotencyKey
      ? { 'Idempotency-Key': options.idempotencyKey }
      : undefined;

    const raw = await this.http.bearer<Partial<TriggerRunResult>>({
      bearer: this.apiToken,
      method: 'POST',
      path: `/triggers/${encodeURIComponent(options.triggerId)}/run`,
      body,
      extraHeaders: extra,
    });
    return {
      jobId: raw.jobId ?? '',
      status: raw.status ?? '',
      idempotent: raw.idempotent ?? false,
      timedOut: raw.timedOut ?? false,
      exitCode: raw.exitCode,
      errorMessage: raw.errorMessage,
      output: raw.output,
      statusUrl: raw.statusUrl,
    };
  }
}
