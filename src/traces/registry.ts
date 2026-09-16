import type { AgentHarness } from '../shared/types';
import {
  CodexAdapter,
  type CodexObservation,
  type CodexAdapterOptions,
  type TraceRecord,
} from './codex';
import { createClaudeSession } from './claude';
import { createPiSession } from './pi';
import type { ProviderSession } from './provider-common';

/** The provider names that can be represented by a canonical session header. */
export type CanonicalProviderHarness = Exclude<AgentHarness, 'codex' | 'unknown'>;

export interface CanonicalInspectOptions extends CodexAdapterOptions {
  /** A trusted path used only by the Codex adapter to identify path-only files. */
  tracePath?: string;
}

const PROVIDER_HARNESSES = new Set<CanonicalProviderHarness>(['claude', 'pi', 'hermes']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerHarness(value: unknown): CanonicalProviderHarness | undefined {
  if (!isObject(value) || !PROVIDER_HARNESSES.has(value.harness as CanonicalProviderHarness)) return undefined;
  const harness = value.harness as CanonicalProviderHarness;
  // Provider sessions stamp a namespaced id into the canonical header. This
  // keeps an arbitrary `harness` field on a raw Codex payload from changing
  // Codex's established adapter behavior.
  return typeof value.id === 'string' && value.id.startsWith(`${harness}:`) ? harness : undefined;
}

function canonicalHeader(records: Array<TraceRecord | unknown>): Record<string, unknown> | undefined {
  for (const record of records) {
    const value = isObject(record) && 'value' in record && ('index' in record || 'raw' in record)
      ? record.value
      : record;
    if (!isObject(value) || value.type !== 'session_meta' || !isObject(value.payload)) continue;
    return value;
  }
  return undefined;
}

function isHermesPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replaceAll('\\', '/');
  return normalized.includes('/.hermes/')
    || normalized.includes('/hermes/')
    || normalized.includes('/session-exports/traces/');
}

function retagHermesSession(session: ProviderSession): ProviderSession {
  const rewrite = (value: unknown): unknown => {
    if (!isObject(value) || value.type !== 'session_meta' || !isObject(value.payload)) return value;
    const payload = { ...value.payload };
    const id = typeof payload.id === 'string'
      ? payload.id.replace(/^claude:/, 'hermes:')
      : payload.id;
    const parent = typeof payload.parent_thread_id === 'string'
      ? payload.parent_thread_id.replace(/^claude:/, 'hermes:')
      : payload.parent_thread_id;
    return {
      ...value,
      payload: {
        ...payload,
        harness: 'hermes',
        ...(id !== undefined ? { id } : {}),
        ...(parent !== undefined ? { parent_thread_id: parent } : {}),
      },
    };
  };
  return {
    harness: 'hermes',
    header: rewrite(session.header),
    normalize(value: unknown, index: number): unknown[] {
      return session.normalize(value, index).map(rewrite);
    },
  };
}

/**
 * Detect the first non-Codex provider record in a file.
 *
 * Codex deliberately remains a raw passthrough. Its `session_meta` record is
 * recognized by the monitor and sent directly to `CodexAdapter`, while these
 * factories create canonical provider sessions for the other harnesses.
 */
export function createProviderSession(value: unknown, filePath: string): ProviderSession | null {
  const harness = isHermesPath(filePath)
    || (isObject(value) && value.version === 'hermes-agent')
    ? 'hermes'
    : 'claude';

  const pi = createPiSession(value, filePath);
  if (pi) return pi;

  const claudeSession = createClaudeSession(value, filePath, harness);
  if (claudeSession) return claudeSession;
  // Custom fixture roots often omit the `.hermes` directory component while
  // retaining a Hermes-shaped envelope. Reuse the Claude envelope parser and
  // retag only its trusted canonical header for that path.
  if (harness === 'hermes') {
    const fallback = createClaudeSession(value, filePath, 'claude');
    if (fallback) return retagHermesSession(fallback);
  }
  return null;
}

/**
 * Inspect canonical records with the existing Codex adapter.
 *
 * Provider normalizers emit a canonical `session_meta` header whose
 * `payload.harness` is the only trusted source for changing the adapter's
 * default Codex harness. Raw Codex headers do not carry that field and retain
 * their existing behavior unchanged.
 */
export function inspectCanonical(
  records: Array<TraceRecord | unknown>,
  options: CanonicalInspectOptions = {},
): CodexObservation | null {
  const observation = new CodexAdapter().inspect(records, options);
  if (!observation) return null;
  const header = canonicalHeader(records);
  const harness = providerHarness(isObject(header?.payload) ? header.payload : undefined);
  if (harness) observation.agent.harness = harness;
  return observation;
}

export { CodexAdapter } from './codex';
export type { CodexObservation, CodexAdapterOptions, TraceRecord } from './codex';
export type { ProviderSession } from './provider-common';

export default createProviderSession;
