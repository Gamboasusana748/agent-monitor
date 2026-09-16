import type { ModelTokenUsage } from '../shared/types';

/** A minute-binned sample used for the optional token-rate timeline. */
export interface TokenTimelineSample {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageAccountingSnapshot {
  tokenUsage: ModelTokenUsage[];
  tokenTimeline: TokenTimelineSample[];
}

type JsonObject = Record<string, unknown>;

interface UsageContext {
  model?: string;
  provider?: string;
  serviceTier?: string;
}

interface ParsedUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  inputIncludesCache?: boolean;
}

type NumericUsageField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h';

interface UsageContribution {
  context: UsageContext;
  usage: ParsedUsage;
  requestInputTokens?: number;
  timestamp?: number;
}

interface InternalBucket extends ModelTokenUsage {
  key: string;
  cacheWriteCategory: CacheWriteCategory;
  contributionCount: number;
}

type CacheWriteCategory = 'none' | 'unknown' | '5m' | '1h' | '5m+1h';

interface CumulativePoint extends ParsedUsage {}

interface CumulativeState {
  point: CumulativePoint;
}

const UNKNOWN_MODEL = 'unknown';
const DEFAULT_MAX_TIMELINE_MINUTES = 1_440;
const TOKEN_FIELDS: NumericUsageField[] = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h',
];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function firstString(object: JsonObject | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const result = stringValue(object[key]);
    if (result) return result;
  }
  return undefined;
}

function firstNumber(object: JsonObject | undefined, keys: string[]): number | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const result = numberValue(object[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

function firstBoolean(object: JsonObject | undefined, keys: string[]): boolean | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    if (typeof object[key] === 'boolean') return object[key] as boolean;
  }
  return undefined;
}

function timestampValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function recordTimestamp(value: JsonObject, payload: JsonObject | undefined): number | undefined {
  return timestampValue(value.timestamp) ?? timestampValue(payload?.timestamp);
}

function payloadOf(value: JsonObject): JsonObject {
  return isObject(value.payload) ? value.payload : value;
}

function usageObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

/**
 * Read token fields without filling absent cache metadata with zero. The
 * normalizers mark their inclusive input field explicitly; Codex input_tokens
 * are also treated as inclusive by default, while cache-only records still
 * contribute their separately reported cache fields.
 */
export function parseUsage(value: unknown): ParsedUsage {
  const object = usageObject(value);
  if (!object) return {};
  const cacheCreation = isObject(object.cache_creation)
    ? object.cache_creation
    : isObject(object.cacheCreation) ? object.cacheCreation : undefined;
  const input = firstNumber(object, [
    'input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens',
  ]);
  const output = firstNumber(object, [
    'output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens',
  ]);
  const cacheRead = firstNumber(object, [
    'cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens',
    'cachedInputTokens', 'cache_read', 'cacheRead',
  ]);
  const cacheWrite5m = firstNumber(object, [
    'cache_write_5m_input_tokens', 'cacheWrite5mInputTokens', 'cache_write_5m_tokens',
    'cacheWrite5mTokens', 'cache_creation_5m_input_tokens', 'cacheCreation5mInputTokens',
    'cache_creation_ephemeral_5m_input_tokens', 'cacheCreationEphemeral5mInputTokens',
  ]) ?? firstNumber(cacheCreation, [
    'ephemeral_5m_input_tokens', 'ephemeral5mInputTokens', 'cache_write_5m_input_tokens',
    'cacheWrite5mInputTokens',
  ]);
  const cacheWrite1h = firstNumber(object, [
    'cache_write_1h_input_tokens', 'cacheWrite1hInputTokens', 'cache_write_1h_tokens',
    'cacheWrite1hTokens', 'cache_creation_1h_input_tokens', 'cacheCreation1hInputTokens',
    'cache_creation_ephemeral_1h_input_tokens', 'cacheCreationEphemeral1hInputTokens',
  ]) ?? firstNumber(cacheCreation, [
    'ephemeral_1h_input_tokens', 'ephemeral1hInputTokens', 'cache_write_1h_input_tokens',
    'cacheWrite1hInputTokens',
  ]);
  const explicitCacheWrite = firstNumber(object, [
    'cache_write_input_tokens', 'cacheWriteInputTokens', 'cache_write_tokens',
    'cacheWriteTokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens',
    'cache_create_input_tokens', 'cacheCreateInputTokens', 'cache_write', 'cacheWrite',
  ]) ?? firstNumber(cacheCreation, ['input_tokens', 'inputTokens', 'cache_write_input_tokens']);
  const knownTtlWrite = [cacheWrite5m, cacheWrite1h]
    .filter((part): part is number => part !== undefined);
  const cacheWrite = explicitCacheWrite
    ?? (knownTtlWrite.length ? knownTtlWrite.reduce((sum, part) => sum + part, 0) : undefined);
  const explicitInputIncludesCache = firstBoolean(object, [
    'input_tokens_includes_cache', 'inputTokensIncludesCache', 'includes_cache', 'includesCache',
  ]);
  const inputIncludesCache = explicitInputIncludesCache ?? (input !== undefined ? true : undefined);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    ...(inputIncludesCache !== undefined ? { inputIncludesCache } : {}),
  };
}

function hasUsage(value: ParsedUsage): boolean {
  return TOKEN_FIELDS.some((field) => value[field] !== undefined);
}

function hasPositiveUsage(value: ParsedUsage): boolean {
  return TOKEN_FIELDS.some((field) => (value[field] ?? 0) > 0);
}

function inputTotal(value: ParsedUsage): number {
  const base = value.input ?? 0;
  if (value.inputIncludesCache === true) return base;
  return base + (value.cacheRead ?? 0) + (value.cacheWrite ?? 0);
}

function copyUsage(value: ParsedUsage): ParsedUsage {
  return { ...value };
}

function sameOptionalValues(left: ParsedUsage, right: ParsedUsage): boolean {
  return TOKEN_FIELDS.every((field) => left[field] === right[field])
    && left.inputIncludesCache === right.inputIncludesCache;
}

function maxUsage(left: ParsedUsage, right: ParsedUsage): ParsedUsage {
  const result: ParsedUsage = {};
  for (const field of TOKEN_FIELDS) {
    const a = left[field];
    const b = right[field];
    if (a !== undefined || b !== undefined) result[field] = Math.max(a ?? 0, b ?? 0);
  }
  // A normalized provider record is already inclusive. Preserve that marker
  // when a later split-message revision omits it.
  if (right.inputIncludesCache !== undefined) result.inputIncludesCache = right.inputIncludesCache;
  else if (left.inputIncludesCache !== undefined) result.inputIncludesCache = left.inputIncludesCache;
  return result;
}

function addUsageToBucket(bucket: InternalBucket, value: UsageContribution, sign: 1 | -1): void {
  bucket.inputTokens += sign * inputTotal(value.usage);
  bucket.outputTokens += sign * (value.usage.output ?? 0);
  if (value.usage.cacheRead !== undefined) {
    bucket.cacheReadTokens = (bucket.cacheReadTokens ?? 0) + sign * value.usage.cacheRead;
  }
  if (value.usage.cacheWrite !== undefined) {
    bucket.cacheWriteTokens = (bucket.cacheWriteTokens ?? 0) + sign * value.usage.cacheWrite;
  }
  if (value.usage.cacheWrite5m !== undefined) {
    bucket.cacheWrite5mTokens = (bucket.cacheWrite5mTokens ?? 0) + sign * value.usage.cacheWrite5m;
  }
  if (value.usage.cacheWrite1h !== undefined) {
    bucket.cacheWrite1hTokens = (bucket.cacheWrite1hTokens ?? 0) + sign * value.usage.cacheWrite1h;
  }
}

function cacheWriteCategory(value: ParsedUsage): CacheWriteCategory {
  const has5m = value.cacheWrite5m !== undefined;
  const has1h = value.cacheWrite1h !== undefined;
  if (has5m && has1h) return '5m+1h';
  if (has5m) return '5m';
  if (has1h) return '1h';
  if (value.cacheWrite !== undefined) return 'unknown';
  return 'none';
}

function contextKey(value: UsageContext): string {
  return JSON.stringify([
    value.model ?? UNKNOWN_MODEL,
    value.provider ?? null,
    value.serviceTier ?? null,
  ]);
}

function bucketKey(value: UsageContribution): { key: string; cacheWriteCategory: CacheWriteCategory } {
  const category = cacheWriteCategory(value.usage);
  const cacheReadCategory = value.usage.cacheRead === undefined ? 'unknown' : 'known';
  return {
    key: JSON.stringify([
      contextKey(value.context),
      value.requestInputTokens ?? null,
      cacheReadCategory,
      category,
    ]),
    cacheWriteCategory: category,
  };
}

function cloneContribution(value: UsageContribution): UsageContribution {
  return {
    context: { ...value.context },
    usage: copyUsage(value.usage),
    ...(value.requestInputTokens !== undefined ? { requestInputTokens: value.requestInputTokens } : {}),
    ...(value.timestamp !== undefined ? { timestamp: value.timestamp } : {}),
  };
}

function tokenUsageFromBucket(bucket: InternalBucket): ModelTokenUsage {
  const { key: _key, cacheWriteCategory: _category, contributionCount: _count, ...usage } = bucket;
  return usage;
}

/**
 * Stateful, bounded-memory usage accounting for one trace file. It receives
 * canonical records before TraceMonitor trims its timeline records, retaining
 * only numeric counters and stable request ids needed for split-message
 * revisions.
 */
export class UsageAccumulator {
  private readonly buckets = new Map<string, InternalBucket>();
  private readonly requestUsages = new Map<string, UsageContribution>();
  private readonly timeline = new Map<number, TokenTimelineSample>();
  private readonly maxTimelineMinutes: number;
  private context: UsageContext = {};
  private cumulative?: CumulativeState;
  private latestTimelineMinute?: number;
  private serial = 0;

  constructor(options: { maxTimelineMinutes?: number } = {}) {
    this.maxTimelineMinutes = Math.max(1, Math.floor(options.maxTimelineMinutes ?? DEFAULT_MAX_TIMELINE_MINUTES));
  }

  add(recordValue: unknown, recordIndex?: number): void {
    if (!isObject(recordValue)) return;
    const payload = payloadOf(recordValue);
    const outerType = firstString(recordValue, ['type'])?.toLowerCase();
    const innerType = firstString(payload, ['type'])?.toLowerCase();
    const type = innerType ?? outerType;
    if (outerType === 'session_meta' || outerType === 'turn_context') {
      this.updateContext(payload);
      return;
    }
    if (type !== 'token_count') return;

    const info = isObject(payload.info)
      ? payload.info
      : isObject(recordValue.info) ? recordValue.info : payload;
    // Some exporters attach context to the usage record itself. It is only a
    // fallback; the preceding turn_context remains authoritative when present.
    this.updateMissingContext(info);
    const totalObject = info.total_token_usage ?? info.totalTokenUsage;
    const lastObject = info.last_token_usage ?? info.lastTokenUsage;
    const total = parseUsage(totalObject);
    const last = parseUsage(lastObject);
    const timestamp = recordTimestamp(recordValue, payload);
    const requestInputTokens = last.input;
    if (hasUsage(total)) {
      const result = this.consumeCumulative(total);
      const usage = result.delta;
      if (result.baseline) {
        const split = this.splitBaseline(total, last);
        if (hasPositiveUsage(split.known)) {
          this.addContribution({
            context: { ...this.context },
            usage: split.known,
            ...(requestInputTokens !== undefined ? { requestInputTokens } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }, false);
        }
        if (hasPositiveUsage(split.unknown)) {
          this.addContribution({
            context: {},
            usage: split.unknown,
            ...(timestamp !== undefined ? { timestamp } : {}),
          }, false);
        }
      } else if (hasUsage(usage)) {
        const contributionUsage = this.mergeCumulativeCache(usage, last, total);
        if (hasPositiveUsage(contributionUsage)) {
          this.addContribution({
            context: { ...this.context },
            usage: contributionUsage,
            ...(requestInputTokens !== undefined ? { requestInputTokens } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }, false);
        }
      }
      // A cumulative counter's first observation is often historical. Do not
      // turn the entire baseline into a rate spike; the last request is the
      // only timeline sample known at that timestamp.
      if (result.baseline && hasPositiveUsage(last)) {
        this.addTimelineContribution({
          context: { ...this.context },
          usage: last,
          ...(requestInputTokens !== undefined ? { requestInputTokens } : {}),
          ...(timestamp !== undefined ? { timestamp } : {}),
        });
      } else if (!result.baseline && hasPositiveUsage(usage)) {
        this.addTimelineContribution({
          context: { ...this.context },
          usage,
          ...(timestamp !== undefined ? { timestamp } : {}),
        });
      }
      return;
    }
    if (!hasPositiveUsage(last)) return;
    const usageId = firstString(info, [
      'usage_id', 'usageId', 'request_id', 'requestId', 'message_id', 'messageId',
      'turn_id', 'turnId',
    ]) ?? `request:${recordIndex ?? this.serial++}`;
    this.upsertRequest(usageId, {
      context: { ...this.context },
      usage: last,
      ...(requestInputTokens !== undefined ? { requestInputTokens } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  }

  snapshot(): UsageAccountingSnapshot {
    const tokenUsage = Array.from(this.buckets.values())
      .filter((bucket) => bucket.inputTokens !== 0 || bucket.outputTokens !== 0
        || bucket.cacheReadTokens !== undefined || bucket.cacheWriteTokens !== undefined)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(tokenUsageFromBucket);
    const tokenTimeline = Array.from(this.timeline.values())
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((sample) => ({ ...sample }));
    return { tokenUsage, tokenTimeline };
  }

  tokenUsage(): ModelTokenUsage[] {
    return this.snapshot().tokenUsage;
  }

  tokenTimeline(): TokenTimelineSample[] {
    return this.snapshot().tokenTimeline;
  }

  totals(): { inputTokens: number; outputTokens: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const bucket of this.buckets.values()) {
      inputTokens += bucket.inputTokens;
      outputTokens += bucket.outputTokens;
    }
    return { inputTokens, outputTokens };
  }

  private updateContext(source: JsonObject): void {
    const model = firstString(source, ['model', 'model_id', 'modelId']);
    const provider = firstString(source, ['model_provider', 'provider', 'modelProvider']);
    const serviceTier = firstString(source, ['service_tier', 'serviceTier', 'tier']);
    if (model !== undefined) this.context.model = model;
    if (provider !== undefined) this.context.provider = provider;
    if (serviceTier !== undefined) this.context.serviceTier = serviceTier;
  }

  private updateMissingContext(source: JsonObject): void {
    const model = firstString(source, ['model', 'model_id', 'modelId']);
    const provider = firstString(source, ['model_provider', 'provider', 'modelProvider']);
    const serviceTier = firstString(source, ['service_tier', 'serviceTier', 'tier']);
    if (model !== undefined && this.context.model === undefined) this.context.model = model;
    if (provider !== undefined && this.context.provider === undefined) this.context.provider = provider;
    if (serviceTier !== undefined && this.context.serviceTier === undefined) this.context.serviceTier = serviceTier;
  }

  private consumeCumulative(total: ParsedUsage): { delta: ParsedUsage; baseline: boolean; segment: number } {
    const previous = this.cumulative?.point;
    if (!previous) {
      this.cumulative = { point: copyUsage(total) };
      return { delta: copyUsage(total), baseline: true, segment: 0 };
    }
    const reset = (['input', 'output'] as NumericUsageField[]).some((field) => {
      const before = previous[field];
      const after = total[field];
      return before !== undefined && after !== undefined && after < before;
    });
    if (reset) {
      this.cumulative = { point: copyUsage(total) };
      return { delta: copyUsage(total), baseline: true, segment: 1 };
    }
    const delta: ParsedUsage = {};
    let positiveDelta = false;
    for (const field of TOKEN_FIELDS) {
      const after = total[field];
      if (after === undefined) continue;
      const before = previous[field];
      const difference = before === undefined ? after : after - before;
      if (difference > 0) {
        delta[field] = difference;
        positiveDelta = true;
      }
    }
    // Preserve explicit zero cache fields on a real request delta. This lets
    // pricing distinguish a reported zero from an exporter that omitted the
    // cache field entirely without creating a bucket for duplicate totals.
    if (positiveDelta) {
      for (const field of TOKEN_FIELDS) {
        if (delta[field] !== undefined) continue;
        const after = total[field];
        const before = previous[field];
        if (after !== undefined && ((before !== undefined && after === before)
          || (before === undefined && after === 0))) delta[field] = 0;
      }
    }
    if (total.inputIncludesCache !== undefined) delta.inputIncludesCache = total.inputIncludesCache;
    this.cumulative = { point: { ...previous, ...total } };
    return { delta, baseline: false, segment: 0 };
  }

  private mergeCumulativeCache(delta: ParsedUsage, last: ParsedUsage, total: ParsedUsage): ParsedUsage {
    const result = copyUsage(delta);
    // Codex totals may omit cache detail while last_token_usage still carries
    // it. Attach that detail only when this total produced a real delta; a
    // duplicate total therefore cannot double-count cache tokens.
    if (result.cacheRead === undefined && total.cacheRead === undefined && last.cacheRead !== undefined) result.cacheRead = last.cacheRead;
    if (result.cacheWrite === undefined && total.cacheWrite === undefined && last.cacheWrite !== undefined) result.cacheWrite = last.cacheWrite;
    if (result.cacheWrite5m === undefined && total.cacheWrite5m === undefined && last.cacheWrite5m !== undefined) result.cacheWrite5m = last.cacheWrite5m;
    if (result.cacheWrite1h === undefined && total.cacheWrite1h === undefined && last.cacheWrite1h !== undefined) result.cacheWrite1h = last.cacheWrite1h;
    if (result.inputIncludesCache === undefined && last.inputIncludesCache !== undefined) {
      result.inputIncludesCache = last.inputIncludesCache;
    }
    return result;
  }

  private splitBaseline(total: ParsedUsage, last: ParsedUsage): { known: ParsedUsage; unknown: ParsedUsage } {
    const known: ParsedUsage = {};
    const unknown: ParsedUsage = {};
    for (const field of TOKEN_FIELDS) {
      const totalValue = total[field];
      const lastValue = last[field];
      if (lastValue !== undefined) {
        known[field] = totalValue === undefined ? lastValue : Math.min(lastValue, totalValue);
      }
      if (totalValue !== undefined) {
        const remainder = totalValue - (lastValue === undefined ? 0 : Math.min(lastValue, totalValue));
        if (remainder > 0) unknown[field] = remainder;
      }
    }
    if (last.inputIncludesCache !== undefined) known.inputIncludesCache = last.inputIncludesCache;
    else if (total.inputIncludesCache !== undefined) known.inputIncludesCache = total.inputIncludesCache;
    if (total.inputIncludesCache !== undefined) unknown.inputIncludesCache = total.inputIncludesCache;
    return { known, unknown };
  }

  private upsertRequest(key: string, next: UsageContribution): void {
    const previous = this.requestUsages.get(key);
    if (!previous) {
      this.requestUsages.set(key, cloneContribution(next));
      this.addBucketContribution(next, 1);
      this.addTimelineContribution(next);
      return;
    }
    const merged: UsageContribution = {
      context: { ...next.context },
      usage: maxUsage(previous.usage, next.usage),
      ...(Math.max(previous.requestInputTokens ?? 0, next.requestInputTokens ?? 0) > 0
        || previous.requestInputTokens === 0 || next.requestInputTokens === 0
        ? { requestInputTokens: Math.max(previous.requestInputTokens ?? 0, next.requestInputTokens ?? 0) }
        : {}),
      ...(next.timestamp !== undefined ? { timestamp: next.timestamp } : previous.timestamp !== undefined ? { timestamp: previous.timestamp } : {}),
    };
    if (sameOptionalValues(previous.usage, merged.usage)
      && previous.context.model === merged.context.model
      && previous.context.provider === merged.context.provider
      && previous.context.serviceTier === merged.context.serviceTier
      && previous.requestInputTokens === merged.requestInputTokens
      && previous.timestamp === merged.timestamp) return;
    this.addBucketContribution(previous, -1);
    this.addTimelineContribution(previous, -1);
    this.requestUsages.set(key, cloneContribution(merged));
    this.addBucketContribution(merged, 1);
    this.addTimelineContribution(merged, 1);
  }

  private addContribution(value: UsageContribution, timeline = true): void {
    this.addBucketContribution(value, 1);
    if (timeline) this.addTimelineContribution(value);
  }

  private addBucketContribution(value: UsageContribution, sign: 1 | -1): void {
    const { key, cacheWriteCategory } = bucketKey(value);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (sign < 0) return;
      bucket = {
        key,
        cacheWriteCategory,
        model: value.context.model ?? UNKNOWN_MODEL,
        ...(value.context.provider !== undefined ? { provider: value.context.provider } : {}),
        ...(value.context.serviceTier !== undefined ? { serviceTier: value.context.serviceTier } : {}),
        inputTokens: 0,
        outputTokens: 0,
        contributionCount: 0,
        ...(value.requestInputTokens !== undefined ? { requestInputTokens: value.requestInputTokens } : {}),
      };
      this.buckets.set(key, bucket);
    }
    bucket.contributionCount += sign;
    addUsageToBucket(bucket, value, sign);
    if (bucket.contributionCount <= 0) {
      this.buckets.delete(key);
    }
  }

  private addTimelineContribution(value: UsageContribution, sign: 1 | -1 = 1): void {
    if (value.timestamp === undefined) return;
    const minute = Math.floor(value.timestamp / 60_000) * 60_000;
    if (sign > 0 && this.latestTimelineMinute !== undefined
      && minute < this.latestTimelineMinute - (this.maxTimelineMinutes - 1) * 60_000) return;
    this.latestTimelineMinute = Math.max(this.latestTimelineMinute ?? minute, minute);
    const existing = this.timeline.get(minute);
    const input = sign * inputTotal(value.usage);
    const output = sign * (value.usage.output ?? 0);
    if (existing) {
      existing.inputTokens += input;
      existing.outputTokens += output;
      if (existing.inputTokens === 0 && existing.outputTokens === 0) this.timeline.delete(minute);
    } else if (sign > 0) {
      this.timeline.set(minute, { timestamp: minute, inputTokens: input, outputTokens: output });
    }
    const lowerBound = this.latestTimelineMinute - (this.maxTimelineMinutes - 1) * 60_000;
    for (const timestamp of this.timeline.keys()) {
      if (timestamp < lowerBound) this.timeline.delete(timestamp);
    }
  }
}

export function createUsageAccumulator(options?: { maxTimelineMinutes?: number }): UsageAccumulator {
  return new UsageAccumulator(options);
}

export { UNKNOWN_MODEL };
