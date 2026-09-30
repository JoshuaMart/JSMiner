import { JSLUICE_VERSION } from '@jsminer/adapters';
import type { AnalyzeResponse, Endpoint, Secret } from '@jsminer/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { secret } from './offline.ts';

interface EndpointRecord {
  type: 'endpoint';
  url: string;
  method: string;
  kind: string;
  query_params: string[] | null;
  body_params: string[] | null;
}
interface SecretRecord {
  type: 'secret';
  kind: string;
  data: Record<string, string>;
}
interface DoneRecord {
  type: 'done';
  version: string;
  truncated: boolean;
  secrets_truncated: boolean;
  syntax_error: boolean;
}
type RecordLine = EndpointRecord | SecretRecord | DoneRecord;
const string = { type: 'string' };
const parameters = { type: ['array', 'null'], items: string, maxItems: 10000 };
const variants = [
  {
    type: { const: 'endpoint' },
    url: string,
    method: string,
    kind: string,
    query_params: parameters,
    body_params: parameters,
  },
  {
    type: { const: 'secret' },
    kind: {
      enum: ['AWSAccessKey', 'gcpKey', 'firebase', 'githubKey', 'reactApp', 'genericSecret'],
    },
    data: { type: 'object', additionalProperties: string, minProperties: 1, maxProperties: 128 },
  },
  {
    type: { const: 'done' },
    version: { const: JSLUICE_VERSION },
    truncated: { type: 'boolean' },
    secrets_truncated: { type: 'boolean' },
    syntax_error: { type: 'boolean' },
  },
];
const validate = new Ajv2020({ strict: false }).compile<RecordLine>({
  oneOf: variants.map((properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  })),
});

/** Treat worker stdout as untrusted data; never publish its contexts or raw secret values. */
export function normalize(
  output: Buffer,
  mac: (value: string) => string,
  base?: string,
  redactQueryValues = false,
  maxFindings = 200,
) {
  if (output.length > 2 * 1024 * 1024) throw new Error('Invalid worker output.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  const lines = text.trimEnd().split('\n');
  if (lines.length > maxFindings * 2 + 1) throw new Error('Invalid worker output.');
  const records = lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (!validate(value)) throw new Error('Invalid worker output.');
    return value;
  });
  const done = records.pop();
  if (done?.type !== 'done' || records.some((r) => r.type === 'done'))
    throw new Error('Incomplete worker output.');
  if (
    (done.secrets_truncated && !done.truncated) ||
    records.filter((r) => r.type === 'secret').length > maxFindings ||
    records.filter((r) => r.type === 'endpoint').length > maxFindings
  )
    throw new Error('Invalid worker output.');
  const reasons = new Set<AnalyzeResponse['truncation']['reasons'][number]>();
  if (done.truncated) reasons.add('finding_count');
  const endpoints = new Map<string, Endpoint>();
  const secrets = new Map<string, Secret>();
  const sensitive: string[] = [];
  for (const record of records) {
    if (record.type !== 'secret') continue;
    const values = Object.values(record.data).filter(Boolean).sort();
    sensitive.push(...values);
    const rule = `jsluice:${record.kind}`;
    const found = secret(
      record.kind,
      values,
      rule,
      {
        tool: 'jsluice',
        module_path: 'original/bundle.js',
        representation: 'original',
        location: null,
      },
      mac,
    );
    const previous = secrets.get(found.id);
    if (previous) {
      if (!previous.evidence.some((e) => e.rule_id === rule))
        previous.evidence.push(...found.evidence);
      previous.rule_id = [previous.rule_id, rule].sort()[0] ?? rule;
    } else secrets.set(found.id, found);
  }
  sensitive.sort((a, b) => b.length - a.length);
  const mask = (value: string) => {
    let masked = value;
    for (const secret of sensitive) {
      masked = masked
        .replaceAll(secret, 'REDACTED')
        .replaceAll(encodeURIComponent(secret), 'REDACTED');
    }
    return masked;
  };
  const params = (values: string[] | null) => {
    const safe = [
      ...new Set(
        (values ?? []).map(mask).filter((value) => {
          if (!value || Buffer.byteLength(value) > 128) {
            reasons.add('field_bytes');
            return false;
          }
          return true;
        }),
      ),
    ].sort();
    if (safe.length > 128) reasons.add('field_bytes');
    return safe.slice(0, 128);
  };
  // When the worker clipped secrets, there is no complete redaction set for URLs.
  if (!done.secrets_truncated)
    for (const record of records) {
      if (record.type !== 'endpoint') continue;
      // Parse structural delimiters before redaction can change their meaning.
      const withoutFragment = record.url.split('#')[0] ?? '';
      const separator = withoutFragment.indexOf('?');
      const path = separator < 0 ? withoutFragment : withoutFragment.slice(0, separator);
      const query = separator < 0 ? undefined : withoutFragment.slice(separator + 1);
      if (!path) continue;
      const queryEntries = new URLSearchParams(query);
      const queryKeys = params([...queryEntries.keys()]);
      const queryValue = redactQueryValues
        ? queryKeys.map((key) => `${encodeURIComponent(key)}=REDACTED`).join('&')
        : [...queryEntries]
            .filter(([key]) => queryKeys.includes(mask(key)))
            .map(
              ([key, value]) =>
                `${encodeURIComponent(mask(key))}=${encodeURIComponent(mask(value))}`,
            )
            .join('&');
      let value =
        mask(path.replace(/^((?:https?:)?[/\\]{2}|https?:)[^/\\]*@/i, '$1')) +
        (queryValue ? `?${queryValue}` : '');
      value = value.replace(/^((?:https?:)?[/\\]{2}|https?:)[^/\\]*@/i, '$1');
      let resolved: string | null = null;
      const dynamic = record.url.includes('EXPR');
      try {
        const absolute = new URL(value, base ? mask(base) : undefined);
        if (!['http:', 'https:'].includes(absolute.protocol)) continue;
        const hadCredentials = Boolean(absolute.username || absolute.password);
        absolute.username = '';
        absolute.password = '';
        absolute.hash = '';
        if (/^https?:/i.test(value) || hadCredentials) value = absolute.href;
        if (!dynamic) resolved = absolute.href;
      } catch {
        // Protocol-relative credentials also need masking when no base URL is provided.
        value = value.replace(/^(\/\/)[^/@]+@/, '$1');
      }
      if (Buffer.byteLength(value) > 2048 || (resolved && Buffer.byteLength(resolved) > 2048)) {
        reasons.add('field_bytes');
        continue;
      }
      const kind: Endpoint['kind'] =
        record.kind === 'stringLiteral'
          ? 'literal'
          : /location|window\.open/i.test(record.kind)
            ? 'navigation'
            : 'http_call';
      const method = /^[A-Z]{1,32}$/.test(record.method) ? record.method : null;
      const queryParams = params([...(record.query_params ?? []), ...queryKeys]);
      const bodyParams = params(record.body_params);
      const id = `end_${mac(JSON.stringify([value, resolved, method, kind, dynamic, queryParams, bodyParams]))}`;
      endpoints.set(id, {
        id,
        value,
        resolved_url: resolved,
        method,
        kind,
        dynamic,
        query_params: queryParams,
        body_params: bodyParams,
        confidence: kind === 'literal' ? 'low' : 'medium',
        evidence: [
          {
            tool: 'jsluice',
            module_path: 'original/bundle.js',
            representation: 'original',
            location: null,
          },
        ],
      });
    }
  return {
    endpoints: [...endpoints.values()]
      .filter(
        (endpoint) =>
          ![...endpoints.values()].some(
            (other) =>
              other !== endpoint &&
              other.value === endpoint.value &&
              other.resolved_url === endpoint.resolved_url &&
              (endpoint.kind === other.kind || endpoint.kind === 'literal') &&
              (endpoint.method === other.method || endpoint.method === null) &&
              (endpoint.method !== other.method || endpoint.kind !== other.kind) &&
              (!endpoint.dynamic || other.dynamic) &&
              endpoint.query_params.every((param) => other.query_params.includes(param)) &&
              endpoint.body_params.every((param) => other.body_params.includes(param)),
          ),
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
    secrets: [...secrets.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sensitive,
    secretsTruncated: done.secrets_truncated,
    reasons: [...reasons],
    partial: done.truncated || done.syntax_error || reasons.size > 0,
    syntaxError: done.syntax_error,
  };
}
