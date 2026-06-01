import type { Ed25519Key } from './internal/ed25519.js';
import type { HttpClient } from './internal/http-client.js';
import type { WorkflowReport } from './models.js';

/** Workflow operations exposed by `DepliteAgent.workflows`. */
export class AgentWorkflows {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly agentId: string,
    private readonly key: Ed25519Key,
  ) {}

  /** Replace the workflow inventory on the backend with `workflows`. */
  async report(workflows: WorkflowReport[]): Promise<number> {
    const wire = workflows.map((w) => ({
      name: w.name,
      ...(w.verboseSteps && w.verboseSteps.length > 0 ? { verboseSteps: w.verboseSteps } : {}),
      ...(w.secretsKeys && w.secretsKeys.length > 0 ? { secretsKeys: w.secretsKeys } : {}),
    }));
    const res = await this.http.signed<{ count: number }>({
      agentId: this.agentId,
      key: this.key,
      method: 'POST',
      path: '/agent/workflows/report',
      body: { workflows: wire },
    });
    return res.count;
  }
}
