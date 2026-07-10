import { DepliteError } from './errors.js';
import { canonicalJson } from './internal/canonical-json.js';
import { verifyEd25519Pem, _internal, type Ed25519Key } from './internal/ed25519.js';
import type { HttpClient } from './internal/http-client.js';
import type {
  DesiredApp,
  DesiredCurrent,
  DesiredRelease,
  DeviceReportInput,
} from './models.js';

interface ManifestEnvelopeWire {
  payload?: unknown;
  signature?: unknown;
}

/** App deploy (OTA) operations exposed by `DepliteAgent.deploy`. */
export class AgentDeploy {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly agentId: string,
    private readonly key: Ed25519Key,
    private readonly serverPublicKeyPem: string,
  ) {}

  /** Fetch this device's desired-state manifests. Each manifest's ed25519
   *  signature is verified against the server key over its raw payload; an
   *  unverifiable manifest aborts the call so callers never see one. */
  async desired(): Promise<DesiredApp[]> {
    const res = await this.http.signed<{ apps?: ManifestEnvelopeWire[] }>({
      agentId: this.agentId,
      key: this.key,
      method: 'GET',
      path: '/agent/deploy/desired',
    });
    const out: DesiredApp[] = [];
    for (const env of res.apps ?? []) {
      const payload = env.payload;
      if (!payload || typeof payload !== 'object') {
        throw new DepliteError('deploy manifest missing payload');
      }
      const ok = await verifyManifest(payload, env.signature, this.serverPublicKeyPem);
      if (!ok) {
        const slug = (payload as Record<string, unknown>).slug;
        throw new DepliteError(
          `deploy manifest signature verification failed for ${
            typeof slug === 'string' ? slug : 'unknown app'
          }`,
        );
      }
      out.push(mapDesiredApp(payload as Record<string, unknown>));
    }
    return out;
  }

  /** Report this device's current app state to the backend. */
  async report(input: DeviceReportInput): Promise<void> {
    const body: Record<string, unknown> = { applicationId: input.applicationId };
    if (input.currentVersion !== undefined) body.currentVersion = input.currentVersion;
    if (input.currentReleaseId !== undefined) body.currentReleaseId = input.currentReleaseId;
    if (input.currentSequence !== undefined) body.currentSequence = input.currentSequence;
    if (input.state !== undefined) body.state = input.state;
    if (input.error !== undefined) body.error = input.error;
    await this.http.signed<void>({
      agentId: this.agentId,
      key: this.key,
      method: 'POST',
      path: '/agent/deploy/report',
      body,
    });
  }
}

async function verifyManifest(
  payload: unknown,
  signature: unknown,
  serverPublicKeyPem: string,
): Promise<boolean> {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  let sig: Uint8Array;
  try {
    sig = _internal.fromBase64(signature);
  } catch {
    return false;
  }
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return verifyEd25519Pem(serverPublicKeyPem, canonical, sig);
}

function mapDesiredApp(p: Record<string, unknown>): DesiredApp {
  return {
    applicationId: asString(p.application_id),
    slug: asString(p.slug),
    channel: asString(p.channel),
    updateWorkflow: asString(p.update_workflow),
    current: mapCurrent(p.current),
    desired: mapRelease(p.desired),
    minVersion: typeof p.min_version === 'string' ? p.min_version : null,
    minSequence: asNumber(p.min_sequence),
    forced: p.forced === true,
    issuedAt: asNumber(p.issued_at),
    nonce: asString(p.nonce),
  };
}

function mapCurrent(v: unknown): DesiredCurrent | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  return {
    releaseId: asString(c.release_id),
    version: asString(c.version),
    sequence: asNumber(c.sequence),
  };
}

function mapRelease(v: unknown): DesiredRelease | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  return {
    releaseId: asString(d.release_id),
    version: asString(d.version),
    sequence: asNumber(d.sequence),
    channel: asString(d.channel),
    workflowName: asString(d.workflow_name),
    checksumSha256: asString(d.checksum_sha256),
    size: asNumber(d.size),
    downloadUrl: asString(d.download_url),
    downloadExpiresIn: asNumber(d.download_expires_in),
  };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
