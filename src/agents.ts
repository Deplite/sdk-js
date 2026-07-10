import type { HttpClient } from './internal/http-client.js';
import type { AgentSummary } from './models.js';

// Wire key kept as `enrolledAt` for backend compatibility.
type AgentSummaryWire = Omit<AgentSummary, 'registeredAt'> & { enrolledAt: string };

/** Agent discovery exposed by `Deplite.agents`. */
export class Agents {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly apiToken: string,
  ) {}

  /**
   * Agents (devices) the token can reach: `GET /agents`.
   *
   * The listing covers the token's grants only, never the whole organization:
   * an `agent` grant contributes its agents, a `trigger` grant contributes the
   * agent behind each trigger, and a storage-only token gets an empty list.
   * Rate-limited per token; a 429 body carries `scope: "token_read"`.
   */
  async list(): Promise<AgentSummary[]> {
    const rows = await this.http.bearer<AgentSummaryWire[]>({
      bearer: this.apiToken,
      method: 'GET',
      path: '/agents',
    });
    return rows.map(({ enrolledAt, ...rest }) => ({ ...rest, registeredAt: enrolledAt }));
  }
}
