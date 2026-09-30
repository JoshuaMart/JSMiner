import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import type * as Model from './generated.js';

export type * from './generated.js';
export type Permission = 'analysis:write' | 'analysis:read' | 'source:read';
export type AnalyzeRequest = Pick<
  Model.AnalyzeRequest,
  | 'tools'
  | 'script_hash'
  | 'base_url'
  | 'reference_domains'
  | 'endpoint_scope'
  | 'exclude_extensions'
  | 'redact_query_values'
  | 'min_confidence'
> &
  ({ url: string; content?: never } | { content: string; url?: never });

export const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'));
export const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  strictTypes: false,
  allErrors: true,
  formats: fullFormats,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
ajv.addSchema(schema);

export interface Models {
  AnalyzeRequest: AnalyzeRequest;
  AnalyzeResponse: Model.AnalyzeResponse;
  SourceListQuery: Model.SourceListQuery;
  SourceReadQuery: Model.SourceReadQuery;
  ManifestParams: Model.ManifestParams;
  SourceParams: Model.SourceParams;
  ManifestResponse: Model.ManifestResponse;
  SourceResponse: Model.SourceResponse;
  ErrorResponse: Model.ErrorResponse;
  HealthResponse: Model.HealthResponse;
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; status: 400 | 413 | 422 };
const failure = (code = 'invalid_input', status: 400 | 413 | 422 = 400): ContractResult<never> => ({
  ok: false,
  code,
  status,
});
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const wellFormed = (s: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);

/** JSON Schema validates structure; refinements enforce byte and cross-field invariants. */
export function validateContract<K extends keyof Models>(
  name: K,
  data: unknown,
): ContractResult<Models[K]> {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Unknown contract: ${name}`);
  if (name === 'AnalyzeRequest' && record(data) && typeof data.content === 'string') {
    if (!wellFormed(data.content)) return failure('invalid_content', 422);
    if (Buffer.byteLength(data.content, 'utf8') > 10 * 1024 * 1024)
      return failure('script_too_large', 413);
  }
  if (!validate(data)) {
    if (name === 'SourceReadQuery') return failure('invalid_source_query', 422);
    if (name === 'AnalyzeRequest' && record(data)) {
      if (data.content === '') return failure('invalid_content', 422);
      if (
        Array.isArray(data.tools) &&
        data.tools.includes('domains') &&
        (!Array.isArray(data.reference_domains) || data.reference_domains.length === 0)
      )
        return failure('reference_domains_required', 422);
    }
    return failure();
  }
  const value = data as Models[K];
  if (name === 'AnalyzeRequest') {
    const input = value as AnalyzeRequest;
    for (const raw of [input.url, input.base_url]) {
      if (raw === undefined) continue;
      try {
        const url = new URL(raw);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          !url.hostname ||
          url.username ||
          url.password
        )
          return failure();
      } catch {
        return failure();
      }
    }
  }
  if (name === 'SourceResponse') {
    const source = value as Model.SourceResponse;
    const bytes = Buffer.byteLength(source.content);
    const end = source.offset + bytes;
    if (
      !wellFormed(source.content) ||
      bytes !== source.returned_bytes ||
      end > source.total_bytes ||
      source.next_offset !== (end < source.total_bytes ? end : null) ||
      (bytes === 0 && end < source.total_bytes)
    )
      return failure();
  }
  if (name === 'ManifestResponse') {
    const manifest = value as Model.ManifestResponse;
    if (
      manifest.modules.length > manifest.total_modules ||
      new Set(manifest.modules.map((m) => m.path)).size !== manifest.modules.length
    )
      return failure();
    if (
      manifest.modules.some((m) => m.path === m.parent_path || !m.path.startsWith(`${m.origin}/`))
    )
      return failure();
  }
  if (name === 'AnalyzeResponse') {
    const result = value as Model.AnalyzeResponse;
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) return failure();
    if (new Set(result.tools.map((t) => t.name)).size !== result.tools.length) return failure();
    if (result.truncation.truncated !== result.truncation.reasons.length > 0) return failure();
    if (result.truncation.truncated && result.status !== 'partial') return failure();
    const categories = ['endpoints', 'secrets', 'gql_operations', 'subdomains'] as const;
    const observations = [
      ...result.endpoints,
      ...result.secrets,
      ...result.gql_operations,
      ...result.subdomains,
    ];
    const usable =
      observations.length > 0 ||
      result.tools.some((t) => t.status === 'success' || t.status === 'partial');
    const hasLoss =
      result.truncation.truncated ||
      result.tools.some((t) => t.status !== 'success') ||
      Object.values(result.coverage).some((c) => c === 'partial' || c === 'failed');
    const expectedStatus = usable ? (hasLoss ? 'partial' : 'complete') : 'failed';
    if (result.status !== expectedStatus) return failure();
    const transformationIncomplete = result.tools.some(
      (t) => ['webcrack', 'wakaru'].includes(t.name) && t.status !== 'success',
    );
    const hits = result.tools.filter((t) => t.cache_hit).length;
    if (
      result.cache.status !==
      (hits === 0 ? 'miss' : hits === result.tools.length ? 'hit' : 'partial_hit')
    )
      return failure();
    if (new Set(observations.map((o) => o.id)).size !== observations.length) return failure();
    const detectors: Record<(typeof categories)[number], readonly Model.ToolName[]> = {
      endpoints: ['jsluice'],
      secrets: ['jsluice', 'trufflehog'],
      gql_operations: ['graphql'],
      subdomains: ['domains'],
    };
    for (const category of categories) {
      const requested = result.tools.filter((t) => detectors[category].includes(t.name));
      if ((result.coverage[category] === 'not_requested') !== (requested.length === 0))
        return failure();
      if (requested.length > 0) {
        const categoryUsable =
          result[category].length > 0 ||
          requested.some((t) => t.status === 'success' || t.status === 'partial');
        if ((result.coverage[category] === 'failed') !== !categoryUsable) return failure();
        const incomplete =
          transformationIncomplete || requested.some((t) => t.status !== 'success');
        if (result.coverage[category] === 'complete' && incomplete) return failure();
        if (
          categoryUsable &&
          !incomplete &&
          !result.truncation.truncated &&
          result.coverage[category] !== 'complete'
        )
          return failure();
      }
      if (
        ['not_requested', 'failed'].includes(result.coverage[category]) &&
        result[category].length > 0
      )
        return failure();
      if (
        result[category].some((o) => o.evidence.some((e) => !detectors[category].includes(e.tool)))
      )
        return failure();
    }
    for (const observation of observations) {
      for (const evidence of observation.evidence) {
        if (
          !evidence.module_path.startsWith(`${evidence.representation}/`) ||
          (evidence.location && evidence.location.end_byte < evidence.location.start_byte) ||
          !result.tools.some((t) => t.name === evidence.tool)
        )
          return failure();
      }
    }
    for (const operation of result.gql_operations) {
      if (
        operation.endpoint_id !== null &&
        !result.endpoints.some((e) => e.id === operation.endpoint_id)
      )
        return failure();
    }
    for (const domain of result.subdomains) {
      if (!domain.hostname.endsWith(`.${domain.reference_domain}`)) return failure();
    }
    for (const tool of result.tools) {
      if (tool.status === 'success' && (tool.error_code !== null || tool.version === null))
        return failure();
      if (
        tool.status === 'success' &&
        !['webcrack', 'wakaru'].includes(tool.name) &&
        (tool.modules_analyzed === null ||
          tool.modules_available === null ||
          tool.modules_analyzed !== tool.modules_available)
      )
        return failure();
      if (tool.status !== 'success' && tool.error_code === null) return failure();
      if (
        tool.modules_analyzed !== null &&
        tool.modules_available !== null &&
        tool.modules_analyzed > tool.modules_available
      )
        return failure();
      if (tool.cache_hit && (tool.status !== 'success' || tool.duration_ms !== 0)) return failure();
    }
    const stringsWithinLimit = (x: unknown): boolean =>
      typeof x === 'string'
        ? Buffer.byteLength(x) <= 2048
        : Array.isArray(x)
          ? x.every(stringsWithinLimit)
          : record(x)
            ? Object.values(x).every(stringsWithinLimit)
            : true;
    if (!observations.every(stringsWithinLimit)) return failure();
  }
  return { ok: true, value };
}

export function selectedTools(request: AnalyzeRequest): Model.ToolName[] {
  return request.tools
    ? [...request.tools]
    : [
        'webcrack',
        'wakaru',
        'jsluice',
        'trufflehog',
        'graphql',
        ...(request.reference_domains?.length ? ['domains' as const] : []),
      ];
}
