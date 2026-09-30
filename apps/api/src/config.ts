import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Permission, ToolName } from '@jsminer/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';

export interface ServiceConfig {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  database: string;
  artifact_directory?: string;
  worker_image: string;
  tokens: { sha256: string; project_id: string; permissions: Permission[] }[];
  budgets: {
    http_body_bytes: number;
    script_bytes: number;
    capture_ms: number;
    analysis_ms: number;
    cleanup_ms: number;
    worker_memory_bytes: number;
    worker_cpus: number;
    worker_pids: number;
    artifact_bytes: number;
    module_count: number;
    response_bytes: number;
    source_read_bytes: number;
    active_analyses: number;
    active_workers: number;
    storage_bytes: number;
    retention_ms: number;
    tool_ms: Record<ToolName, number>;
  };
}

const configSchema = JSON.parse(
  readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'),
);
const validate = new Ajv2020({
  strict: true,
  useDefaults: true,
  coerceTypes: false,
  removeAdditional: false,
}).compile<ServiceConfig>(configSchema);

export function parseConfig(value: unknown, baseDirectory = process.cwd()): ServiceConfig {
  const copy: unknown = structuredClone(value);
  if (!validate(copy)) throw new Error('Invalid service configuration. Check config.schema.json.');
  if (new Set(copy.tokens.map((t) => t.sha256)).size !== copy.tokens.length)
    throw new Error('Duplicate token digests in configuration.');
  if (
    copy.budgets.script_bytes > copy.budgets.http_body_bytes ||
    copy.budgets.artifact_bytes > copy.budgets.storage_bytes ||
    copy.budgets.source_read_bytes < 4
  )
    throw new Error('Inconsistent resource budgets.');
  copy.database = copy.database === ':memory:' ? ':memory:' : resolve(baseDirectory, copy.database);
  if (copy.artifact_directory)
    copy.artifact_directory = resolve(baseDirectory, copy.artifact_directory);
  return copy;
}

export function loadConfig(file: string): ServiceConfig {
  const absolute = resolve(file);
  return parseConfig(JSON.parse(readFileSync(absolute, 'utf8')), dirname(absolute));
}
