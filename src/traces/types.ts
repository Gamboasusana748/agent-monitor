import type { Agent, AgentEvent } from '../shared/types';
import type { TraceRecord } from './codex';

/** Common surface for provider adapters used by the monitor. */
export interface TraceProviderAdapter<Observation = unknown> {
  detect(records: Array<TraceRecord | unknown>): boolean;
  inspect(records: Array<TraceRecord | unknown>, options?: unknown): Observation | null;
  processUpdate(
    previous: Agent | null,
    records: Array<TraceRecord | unknown>,
    options?: unknown,
  ): AgentEvent[];
}
