/** Shared contracts and small helpers for non-Codex trace providers. */

export type ProviderHarness = 'claude' | 'pi' | 'hermes';

/**
 * A stateful normalizer for one provider trace file.
 *
 * `normalize` may return more than one Codex-compatible record for one input
 * line. The monitor assigns source indexes after expansion so the Codex
 * adapter can keep every emitted item distinct.
 */
export interface ProviderSession {
  harness: ProviderHarness;
  header: unknown;
  normalize(value: unknown, index: number): unknown[];
}

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result && result.trim() ? result : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function firstString(object: JsonObject | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = nonEmptyString(object[key]);
    if (value) return value;
  }
  return undefined;
}

export function firstNumber(object: JsonObject | undefined, keys: string[]): number | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = numberValue(object[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

/** A conservative text extractor used only for provider payload rendering. */
export function contentText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!isObject(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.thinking === 'string') return value.thinking;
  if (typeof value.summary_text === 'string') return value.summary_text;
  if (typeof value.summary === 'string') return value.summary;
  if (typeof value.content === 'string' || Array.isArray(value.content)) return contentText(value.content);
  if (typeof value.output === 'string' || Array.isArray(value.output)) return contentText(value.output);
  return '';
}

export interface UsageValues {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export function usageValues(value: unknown): UsageValues {
  if (!isObject(value)) return {};
  const input = firstNumber(value, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']);
  const output = firstNumber(value, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']);
  const cacheRead = firstNumber(value, [
    'cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens',
    'cachedInputTokens', 'cache_read', 'cacheRead',
  ]);
  const cacheCreation = isObject(value.cache_creation)
    ? value.cache_creation
    : isObject(value.cacheCreation) ? value.cacheCreation : undefined;
  const cacheWrite5m = firstNumber(value, [
    'cache_write_5m_input_tokens', 'cacheWrite5mInputTokens', 'cache_write_5m_tokens',
    'cacheWrite5mTokens', 'cache_creation_5m_input_tokens', 'cacheCreation5mInputTokens',
    'cache_creation_ephemeral_5m_input_tokens', 'cacheCreationEphemeral5mInputTokens',
  ]) ?? firstNumber(cacheCreation, [
    'ephemeral_5m_input_tokens', 'ephemeral5mInputTokens', 'cache_write_5m_input_tokens',
    'cacheWrite5mInputTokens',
  ]);
  const cacheWrite1h = firstNumber(value, [
    'cache_write_1h_input_tokens', 'cacheWrite1hInputTokens', 'cache_write_1h_tokens',
    'cacheWrite1hTokens', 'cache_creation_1h_input_tokens', 'cacheCreation1hInputTokens',
    'cache_creation_ephemeral_1h_input_tokens', 'cacheCreationEphemeral1hInputTokens',
  ]) ?? firstNumber(cacheCreation, [
    'ephemeral_1h_input_tokens', 'ephemeral1hInputTokens', 'cache_write_1h_input_tokens',
    'cacheWrite1hInputTokens',
  ]);
  const explicitCacheCreate = firstNumber(value, [
    'cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_write_tokens',
    'cacheWriteTokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens',
    'cache_create_input_tokens', 'cacheCreateInputTokens', 'cache_write', 'cacheWrite',
  ]) ?? firstNumber(cacheCreation, ['input_tokens', 'inputTokens', 'cache_write_input_tokens']);
  const cacheParts = [cacheWrite5m, cacheWrite1h].filter(
    (part): part is number => part !== undefined,
  );
  const cacheCreate = explicitCacheCreate
    ?? (cacheParts.length ? cacheParts.reduce((sum, part) => sum + part, 0) : undefined);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreate !== undefined ? { cacheCreate } : {}),
    ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
  };
}

/**
 * Claude's cache token fields are input tokens consumed by the request. Add
 * them to input_tokens when folding provider usage into Agent.stats; the
 * normalized Codex record intentionally keeps only the common input/output
 * fields.
 */
export function codexUsage(value: unknown): {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
} {
  const usage = usageValues(value);
  const inputParts = [usage.input, usage.cacheRead, usage.cacheCreate].filter(
    (part): part is number => part !== undefined,
  );
  const input = inputParts.length ? inputParts.reduce((sum, part) => sum + part, 0) : undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(usage.output !== undefined ? { output: usage.output } : {}),
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheCreate !== undefined ? { cacheCreate: usage.cacheCreate } : {}),
    ...(usage.cacheWrite5m !== undefined ? { cacheWrite5m: usage.cacheWrite5m } : {}),
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
  };
}

export function rawTimestamp(value: JsonObject, nested?: JsonObject): unknown {
  return value.timestamp ?? nested?.timestamp;
}

export function pathLower(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase();
}

export function namespacedId(prefix: ProviderHarness, id: string): string {
  return id.startsWith(`${prefix}:`) ? id : `${prefix}:${id}`;
}
