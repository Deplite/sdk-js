import type { Ed25519Key } from './internal/ed25519.js';
import type { HttpClient } from './internal/http-client.js';
import type { JobResult, LogItem } from './models.js';

/** Job lifecycle operations exposed by `DepliteAgent.jobs`. */
export class AgentJobs {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly agentId: string,
    private readonly key: Ed25519Key,
  ) {}

  /** Ship a batch of log lines for `jobId`. Returns accepted count. */
  async appendLogs(options: { jobId: string; items: LogItem[] }): Promise<number> {
    if (options.items.length === 0) return 0;
    const items = options.items.map((item) => {
      const out: Record<string, unknown> = {
        seq: item.seq,
        stream: item.stream,
        content: item.content,
      };
      if (item.stepName !== undefined) out.stepName = item.stepName;
      if (item.level !== undefined) out.level = item.level;
      return out;
    });
    const res = await this.http.signed<{ accepted: number }>({
      agentId: this.agentId,
      key: this.key,
      method: 'POST',
      path: `/agent/jobs/${encodeURIComponent(options.jobId)}/logs`,
      body: { items },
    });
    return res.accepted;
  }

  /** Report the final outcome of `jobId`. Call once. */
  async reportResult(options: { jobId: string; result: JobResult }): Promise<void> {
    const result = options.result;
    const body: Record<string, unknown> = { status: result.status };
    if (result.exitCode !== undefined) body.exitCode = result.exitCode;
    if (result.errorMessage !== undefined) body.errorMessage = result.errorMessage;
    if (result.output !== undefined) body.output = result.output;
    if (result.rejection) {
      body.reason = result.rejection.reason;
      if (result.rejection.limitType !== undefined) body.limitType = result.rejection.limitType;
      if (result.rejection.retryAfterSeconds !== undefined)
        body.retryAfterSeconds = result.rejection.retryAfterSeconds;
      if (result.rejection.bypassedLimits && result.rejection.bypassedLimits.length > 0)
        body.bypassedLimits = result.rejection.bypassedLimits;
    }
    await this.http.signed<void>({
      agentId: this.agentId,
      key: this.key,
      method: 'POST',
      path: `/agent/jobs/${encodeURIComponent(options.jobId)}/result`,
      body,
    });
  }
}
