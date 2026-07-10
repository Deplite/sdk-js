/** Non-secret identity of a registered agent. */
export interface AgentIdentity {
  agentId: string;
  organizationId: string;
  baseUrl: string;
  serverPublicKeyPem: string;
}

/** Outcome of {@link Deplite.register}: identity + freshly generated private key. */
export interface Registration {
  identity: AgentIdentity;
  privateKey: Uint8Array;
}

/** Typed event from the agent SSE stream. */
export type AgentEvent =
  | { type: 'deploy'; payload: DeployPayload; signature: string }
  // `superseded: true` means a newer release invalidated the job; abort its run.
  | { type: 'cancel'; jobId: string; reason: string | null; superseded: boolean; actor?: string }
  | { type: 'revoke' }
  | { type: 'sync_workflows' }
  | { type: 'ping' }
  | { type: 'unknown'; name: string; data: string };

/** Payload of an `AgentEvent` with `type: 'deploy'`. */
export interface DeployPayload {
  jobId: string;
  workflowName: string;
  debug: boolean;
  ref?: string;
  params?: unknown;
  issuedAt: number;
  nonce: string;
  force: boolean;
  forceReason?: string;
}

/** Result of a trigger invocation. */
export interface TriggerRunResult {
  jobId: string;
  status: string;
  idempotent: boolean;
  timedOut: boolean;
  exitCode?: number;
  errorMessage?: string;
  output?: unknown;
  statusUrl?: string;
}

/** Metadata for a stored file. */
export interface FileMeta {
  id: string;
  bindingId?: string;
  jobId?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  status?: string;
  cleanupRule?: string;
  expiresAt?: string;
  createdAt?: string;
}

/** Type of a workflow `params[]` declaration. */
export type WorkflowParamType = 'string' | 'number' | 'boolean' | 'enum';

/** Type of a workflow `outputs[]` declaration. */
export type WorkflowOutputType = 'string' | 'number' | 'boolean';

/** Backoff strategy for the optional `retry` block. */
export type WorkflowBackoff = 'fixed' | 'linear' | 'exponential';

/** Declaration of a single workflow input parameter. */
export interface WorkflowParam {
  name: string;
  type: WorkflowParamType;
  required?: boolean;
  description?: string;
  default?: unknown;
  pattern?: string;
  options?: string[];
  min?: number;
  max?: number;
}

/** Declaration of a single workflow output value. */
export interface WorkflowOutput {
  name: string;
  type: WorkflowOutputType;
  description?: string;
}

/** Declaration of a secret a workflow consumes. */
export interface WorkflowSecret {
  name: string;
  required?: boolean;
  description?: string;
}

/** Retry policy. */
export interface WorkflowRetry {
  maxAttempts: number;
  backoff?: WorkflowBackoff;
  initialDelaySeconds?: number;
  maxDelaySeconds?: number;
}

/** Catalog projection of a single step. Execution body (run, env values,
 * working-directory, shell) stays on the agent. */
export interface WorkflowStepReport {
  id?: string;
  name: string;
  timeoutMinutes?: number;
  verbose?: boolean;
  continueOnError?: boolean;
  retry?: WorkflowRetry;
}

/** A workflow definition reported by an embedded agent to the backend.
 *  Execution body and secret values never appear here. */
export interface WorkflowReport {
  name: string;
  description?: string;
  version?: string;
  schemaVersion?: number;
  verboseSteps?: string[];
  secretsKeys?: string[];
  secrets?: WorkflowSecret[];
  params?: WorkflowParam[];
  outputs?: WorkflowOutput[];
  retry?: WorkflowRetry;
  steps?: WorkflowStepReport[];
}

/** Permission carried by a `storage` grant. */
export type StoragePermission = 'read' | 'write' | 'delete';

/** A single grant on an API token. */
export type TokenScope =
  | { type: 'agent'; agentIds: string[] }
  | { type: 'trigger'; triggerIds: string[] }
  | { type: 'storage'; bindingIds: string[] | null; permissions: StoragePermission[] };

/** Per-token rate limit. `null` means no limit for that window. */
export interface TokenRateLimit {
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}

/** Self-description of the API token in use. */
export interface TokenInfo {
  organizationId: string;
  name: string;
  scopes: TokenScope[];
  rateLimit: TokenRateLimit;
  expiresAt: string | null;
}

/** Lifecycle state of an agent. */
export type AgentStatus = 'pending' | 'connected' | 'disconnected' | 'revoked';

/** An agent (device) the current API token can reach. */
export interface AgentSummary {
  id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  agentVersion: string | null;
  status: AgentStatus;
  lastSeenAt: string | null;
  registeredAt: string;
}

/** A workflow the current API token can run. */
export interface WorkflowSummary {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  version: string | null;
  paramsSchema: WorkflowParam[] | null;
}

/** Cleanup policy applied to a file after upload. */
export type CleanupRule =
  | { kind: 'ttl'; ttlSeconds: number }
  | { kind: 'persistent' }
  | { kind: 'on_job_end' };

export type LogStream = 'raw' | 'system';
export type LogLevel = 'info' | 'warn' | 'error';

/** A single log line shipped by an embedded agent. */
export interface LogItem {
  seq: number;
  stream: LogStream;
  content: string;
  stepName?: string;
  level?: LogLevel;
}

export type JobStatus = 'running' | 'success' | 'failed' | 'timeout' | 'rejected';

/** Reason supplied when a job is rejected by guard rails. */
export interface Rejection {
  reason: string;
  limitType?: string;
  retryAfterSeconds?: number;
  bypassedLimits?: string[];
}

/** Final outcome of a job run. Construct via the `JobResult` factory object. */
export interface JobResult {
  status: JobStatus;
  exitCode?: number;
  errorMessage?: string;
  output?: unknown;
  rejection?: Rejection;
}

/** Factories for {@link JobResult}. */
export const JobResult = {
  running(): JobResult {
    return { status: 'running' };
  },
  success(opts?: { exitCode?: number; output?: unknown }): JobResult {
    return { status: 'success', exitCode: opts?.exitCode ?? 0, output: opts?.output };
  },
  failed(opts?: { exitCode?: number; errorMessage?: string }): JobResult {
    return { status: 'failed', exitCode: opts?.exitCode, errorMessage: opts?.errorMessage };
  },
  timeout(opts?: { errorMessage?: string }): JobResult {
    return { status: 'timeout', errorMessage: opts?.errorMessage };
  },
  rejected(rejection: Rejection): JobResult {
    return { status: 'rejected', rejection };
  },
} as const;

/** Response shape of `presignUpload`. */
export interface PresignedUpload {
  fileId: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresInSeconds?: number;
}

/** Upload source accepted by `Files.upload` / `AgentFiles.upload`. */
export type UploadInput =
  | { path: string }
  | { stream: ReadableStream<Uint8Array>; size?: number }
  | { buffer: Uint8Array };

/** Reported lifecycle state of an app on this device. */
export type AppDeviceState = 'idle' | 'pending' | 'updating' | 'failed';

/** The release currently installed on this device for an app. */
export interface DesiredCurrent {
  releaseId: string;
  version: string;
  sequence: number;
}

/** The release this device should converge to. */
export interface DesiredRelease {
  releaseId: string;
  version: string;
  sequence: number;
  channel: string;
  workflowName: string;
  checksumSha256: string;
  size: number;
  downloadUrl: string;
  downloadExpiresIn: number;
}

/** One app's signed desired-state manifest. Order releases by `sequence`
 *  (integer); `version` is display-only. */
export interface DesiredApp {
  applicationId: string;
  slug: string;
  channel: string;
  updateWorkflow: string;
  current: DesiredCurrent | null;
  desired: DesiredRelease | null;
  minVersion: string | null;
  minSequence: number;
  forced: boolean;
  issuedAt: number;
  nonce: string;
}

/** Device-state report sent by `DepliteAgent.deploy.report`. */
export interface DeviceReportInput {
  applicationId: string;
  currentVersion?: string;
  currentReleaseId?: string;
  currentSequence?: number;
  state?: AppDeviceState;
  error?: string;
}
