/** Shared adapter boundaries and the isolated offline jsluice supervisor. */
import type { ToolName } from '@jsminer/contracts';

export interface AdapterDescriptor {
  name: ToolName;
  version: string;
  outputSchemaVersion: string;
  capabilities: readonly ('transform' | 'endpoints' | 'secrets' | 'graphql' | 'domains')[];
}

export interface AdapterInput {
  /** Supervisor-owned paths, never arbitrary paths supplied by a client. */
  inputFiles: readonly { logicalPath: string; absolutePath: string; hash: string }[];
  outputDirectory: string;
  deadline: number;
  signal: AbortSignal;
}

export interface AdapterOutput {
  /** Validated by the supervisor before publication; never sent directly to the API. */
  manifestFile: string;
  findingsFile: string | null;
}

export interface Adapter {
  descriptor: AdapterDescriptor;
  run(input: AdapterInput): Promise<AdapterOutput>;
}

export * from './docker.js';
