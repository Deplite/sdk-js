import type { HttpClient } from './internal/http-client.js';
import type { WorkflowSummary } from './models.js';

/** Workflow discovery exposed by `Deplite.workflows`. */
export class Workflows {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly apiToken: string,
  ) {}

  /**
   * Workflows the token can run: `GET /workflows`.
   *
   * An `agent` grant, or a trigger granted over a whole agent, contributes
   * every active workflow of that agent; a trigger granted over a single
   * workflow contributes only that one. Removed workflows never appear, and a
   * storage-only token gets an empty list.
   * Rate-limited per token; a 429 body carries `scope: "token_read"`.
   */
  async list(): Promise<WorkflowSummary[]> {
    return this.http.bearer<WorkflowSummary[]>({
      bearer: this.apiToken,
      method: 'GET',
      path: '/workflows',
    });
  }
}
