import type {
  Evidence,
  GraphqlOperation,
  Module,
  Secret,
  Subdomain,
  ToolName,
} from '@jsminer/contracts';
import { ajv, schema } from '@jsminer/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';

export type Reason = 'finding_count' | 'field_bytes' | 'artifact_bytes' | 'module_count';
export interface OfflineOutput {
  modules: { path: string; content: string }[];
  findings: Record<string, unknown>[];
  partial: boolean;
  reasons: Reason[];
  error_code: string | null;
}
const string = { type: 'string' };
const validate = new Ajv2020().compile<OfflineOutput>({
  type: 'object',
  additionalProperties: false,
  required: ['modules', 'findings', 'partial', 'reasons', 'error_code'],
  properties: {
    modules: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            maxLength: 64,
            pattern: '^(?:bundle\\.js|modules/m[0-9]+\\.js)$',
          },
          content: string,
        },
      },
    },
    findings: { type: 'array', maxItems: 2000, items: { type: 'object' } },
    partial: { type: 'boolean' },
    reasons: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['finding_count', 'field_bytes', 'artifact_bytes', 'module_count'] },
    },
    error_code: { enum: [null, 'incomplete_document', 'output_truncated', 'unpack_failed'] },
  },
});
export function parseOutput(bytes: Buffer, transform: boolean, maxFindings = 200): OfflineOutput {
  if (bytes.length > (transform ? 96 * 1024 * 1024 : 2 * 1024 * 1024))
    throw new Error('Invalid output size.');
  const output: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !validate(output) ||
    output.findings.length > maxFindings ||
    (!transform && output.error_code === 'unpack_failed') ||
    output.partial !== (output.error_code !== null) ||
    (output.reasons.length > 0 && !output.partial)
  )
    throw new Error('Invalid output.');
  if (transform ? output.findings.length > 0 : output.modules.length > 0)
    throw new Error('Unexpected output.');
  return output;
}
export function decodeModules(output: OfflineOutput) {
  const paths = output.modules.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate module.');
  let size = 0;
  return output.modules.map((file) => {
    const content = Buffer.from(file.content, 'base64');
    size += content.length;
    if (size > 64 * 1024 * 1024 || content.toString('base64') !== file.content)
      throw new Error('Invalid module bytes.');
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return { path: file.path, content };
  });
}
export function provenance(
  tool: ToolName,
  module: Module,
  location: Evidence['location'] = null,
): Evidence {
  if (
    location &&
    (!Number.isSafeInteger(location.start_byte) ||
      !Number.isSafeInteger(location.end_byte) ||
      location.start_byte < 0 ||
      location.end_byte <= location.start_byte ||
      location.end_byte > module.bytes)
  )
    throw new Error('Invalid position.');
  return { tool, module_path: module.path, representation: module.origin, location };
}
export function family(kind: string) {
  const name = kind.toLowerCase();
  if (['github', 'githubkey'].includes(name)) return 'github';
  if (['gcpkey', 'firebase', 'gcp', 'googleapikey'].includes(name)) return 'google_api_key';
  if (['awsaccesskey', 'aws'].includes(name)) return 'aws';
  return name;
}
export function secret(
  kind: string,
  values: string[],
  rule: string,
  evidence: Evidence,
  mac: (s: string) => string,
): Secret {
  const canonical = [...new Set(values)].sort();
  const fingerprint = `hmac-sha256:${mac(JSON.stringify(canonical))}`;
  return {
    id: `sec_${mac(JSON.stringify([family(kind), fingerprint]))}`,
    confidence: 'medium',
    kind: family(kind),
    rule_id: rule,
    masked_value: '[REDACTED]',
    fingerprint,
    validation: 'not_performed',
    evidence: [{ ...evidence, tool: evidence.tool as 'jsluice' | 'trufflehog', rule_id: rule }],
  };
}
const validateSecret = new Ajv2020().compile<{ kind: string; value: string; extra: string }>({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'value', 'extra'],
  properties: {
    kind: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,100}$' },
    value: { type: 'string', minLength: 1, maxLength: 65536 },
    extra: { type: 'string', maxLength: 65536 },
  },
});
export function normalizeOffline(
  output: OfflineOutput,
  tool: ToolName,
  module: Module,
  mac: (s: string) => string,
) {
  const secrets: Secret[] = [],
    gql_operations: GraphqlOperation[] = [],
    subdomains: Subdomain[] = [],
    sensitive: string[] = [];
  for (const finding of output.findings) {
    if (tool === 'trufflehog') {
      if (
        !validateSecret(finding) ||
        Buffer.from(finding.value).toString() !== finding.value ||
        Buffer.from(finding.extra).toString() !== finding.extra
      )
        throw new Error('Invalid secret.');
      sensitive.push(finding.value, ...(finding.extra ? [finding.extra] : []));
      secrets.push(
        secret(
          finding.kind,
          [finding.value, ...(finding.extra ? [finding.extra] : [])],
          `trufflehog:${finding.kind}`,
          provenance(tool, module),
          mac,
        ),
      );
    } else {
      const { location, ...fields } = finding;
      if (tool === 'graphql' && fields.endpoint_id !== null)
        throw new Error('Unproven endpoint association.');
      const evidence = [provenance(tool, module, location as Evidence['location'])];
      const name = tool === 'graphql' ? 'GraphqlOperation' : 'Subdomain';
      const value = {
        ...fields,
        id: `${tool === 'graphql' ? 'gql' : 'sub'}_${mac(JSON.stringify(fields))}`,
        confidence: 'high',
        evidence,
      };
      const check = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
      if (!check?.(value)) throw new Error('Invalid finding.');
      if (tool === 'graphql') gql_operations.push(value as unknown as GraphqlOperation);
      else subdomains.push(value as unknown as Subdomain);
    }
  }
  return { secrets, gql_operations, subdomains, sensitive };
}
