import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { CleanupError, DockerWorker, type Worker } from '@jsminer/adapters';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  selectedTools,
  type ToolName,
  type ToolRun,
  validateContract,
} from '@jsminer/contracts';
import { ArtifactStore, type Pending, sha256 } from './artifacts.ts';
import type { ServiceConfig } from './config.ts';
import { ServiceError } from './errors.ts';
import { normalize } from './normalization.ts';

export interface EngineOptions {
  worker?: Worker;
  now?: () => number;
}
export class AnalysisEngine {
  readonly store: ArtifactStore;
  private readonly worker: Worker;
  private readonly now: () => number;
  private recovered = false;
  private blocked = false;
  private closing = false;
  private controller: AbortController | undefined;
  private active: Promise<AnalyzeResponse> | undefined;
  private admitted = false;
  private readonly purgeTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly config: ServiceConfig,
    db: DatabaseSync,
    options: EngineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.store = new ArtifactStore(db, config, this.now);
    this.worker = options.worker ?? new DockerWorker(config.worker_image, this.store.owner);
    this.purgeTimer = setInterval(
      () => {
        try {
          this.store.purge();
        } catch {
          this.blocked = true;
        }
      },
      Math.min(config.budgets.retention_ms, 60000),
    );
    this.purgeTimer.unref();
  }
  get healthy() {
    return !this.blocked && !this.closing && this.worker.healthy;
  }
  /** Reserve before HTTP body parsing; active also covers disconnect cleanup. */
  reserve() {
    if (!this.healthy) throw new ServiceError(503, 'service_unavailable');
    if (this.admitted || this.active) throw new ServiceError(429, 'analysis_capacity');
    this.admitted = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.admitted = false;
    };
  }
  analyze(project: string, request: AnalyzeRequest, signal: AbortSignal): Promise<AnalyzeResponse> {
    if (!this.healthy) throw new ServiceError(503, 'service_unavailable');
    if (this.active) throw new ServiceError(429, 'analysis_capacity');
    if (request.content === undefined) throw new ServiceError(501, 'url_not_implemented');
    if (!request.content.trim() || /^\s*</u.test(request.content))
      throw new ServiceError(422, 'invalid_content');
    const bytes = Buffer.from(request.content);
    if (request.script_hash && request.script_hash !== sha256(bytes))
      throw new ServiceError(409, 'script_hash_mismatch');
    this.controller = new AbortController();
    const controller = this.controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.active = this.execute(project, request, bytes, controller.signal).finally(() => {
      signal.removeEventListener('abort', abort);
      this.controller = undefined;
      this.active = undefined;
    });
    return this.active;
  }
  private async execute(
    project: string,
    request: AnalyzeRequest,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<AnalyzeResponse> {
    let pending: Pending | undefined;
    const budget = this.config.budgets;
    const deadline = performance.now() + budget.analysis_ms;
    const names = selectedTools(request);
    try {
      if (names.includes('jsluice') && this.worker instanceof DockerWorker && !this.recovered) {
        await this.worker.recover(budget.cleanup_ms);
        this.recovered = true;
      }
      if (signal.aborted) throw new ServiceError(503, 'analysis_cancelled');
      pending = this.store.prepare(project, bytes);
      const tools = names.map(
        (name): ToolRun => ({
          name,
          version: null,
          status: 'skipped',
          duration_ms: 0,
          cache_hit: false,
          modules_analyzed: ['webcrack', 'wakaru'].includes(name) ? null : 0,
          modules_available: ['webcrack', 'wakaru'].includes(name) ? null : 1,
          error_code: 'tool_unavailable',
          ...(['webcrack', 'wakaru'].includes(name) ? { input_path: null } : {}),
        }),
      );
      const response: AnalyzeResponse = {
        schema_version: '0.1',
        handle: pending.handle,
        status: 'failed',
        script_hash: pending.module.hash,
        expires_at: new Date(this.now() + budget.retention_ms).toISOString(),
        cache: { status: 'miss' },
        endpoints: [],
        secrets: [],
        gql_operations: [],
        subdomains: [],
        coverage: {
          endpoints: 'not_requested',
          secrets: 'not_requested',
          gql_operations: 'not_requested',
          subdomains: 'not_requested',
        },
        tools: tools as [ToolRun, ...ToolRun[]],
        truncation: { truncated: false, reasons: [] },
        warnings: [],
      };
      const tool = tools.find((tool) => tool.name === 'jsluice');
      if (tool) {
        const remaining = deadline - performance.now();
        const result =
          remaining <= 0
            ? {
                status: 'timeout' as const,
                version: null,
                durationMs: 0,
                errorCode: 'analysis_timeout',
                output: Buffer.alloc(0),
              }
            : await this.worker.run({
                content: bytes,
                timeoutMs: Math.max(
                  1,
                  Math.min(budget.tool_ms.jsluice, deadline - performance.now()),
                ),
                cleanupMs: budget.cleanup_ms,
                memoryBytes: budget.worker_memory_bytes,
                cpus: budget.worker_cpus,
                pids: budget.worker_pids,
                signal,
              });
        Object.assign(tool, {
          status: result.status,
          version: result.version,
          duration_ms: result.durationMs,
          error_code: result.errorCode,
        });
        if (result.status === 'success') {
          try {
            const normalized = normalize(
              result.output,
              (value) => this.store.mac(project, value),
              request.base_url,
            );
            response.endpoints = normalized.endpoints;
            response.secrets = normalized.secrets;
            response.truncation.reasons = normalized.reasons;
            tool.modules_analyzed = 1;
            if (normalized.partial) {
              tool.status = 'partial';
              tool.error_code = normalized.syntaxError ? 'syntax_incomplete' : 'output_truncated';
            }
          } catch {
            tool.status = 'error';
            tool.error_code = 'invalid_worker_output';
          }
        }
      }
      if (signal.aborted) throw new ServiceError(503, 'analysis_cancelled');
      this.statuses(response);
      while (Buffer.byteLength(JSON.stringify(response)) > budget.response_bytes) {
        if (!response.endpoints.length && !response.secrets.length)
          throw new ServiceError(503, 'response_budget_too_small');
        if (!response.truncation.reasons.includes('response_bytes'))
          response.truncation.reasons.push('response_bytes');
        (response.endpoints.length >= response.secrets.length
          ? response.endpoints
          : response.secrets
        ).pop();
        this.statuses(response);
      }
      response.expires_at = new Date(this.now() + budget.retention_ms).toISOString();
      // Reject any internal inconsistency before making the handle visible.
      if (!validateContract('AnalyzeResponse', response).ok)
        throw new ServiceError(500, 'invalid_result');
      this.store.publish(pending, response);
      return response;
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'storage_cleanup_unconfirmed')
        this.blocked = true;
      if (error instanceof CleanupError) {
        this.blocked = true;
        throw new ServiceError(503, 'worker_cleanup_unconfirmed');
      }
      throw error;
    } finally {
      if (pending) this.discard(pending);
    }
  }
  private discard(pending: Pending) {
    try {
      this.store.discard(pending);
    } catch {
      this.blocked = true;
      throw new ServiceError(503, 'storage_cleanup_unconfirmed');
    }
  }
  private statuses(response: AnalyzeResponse) {
    response.truncation.truncated = response.truncation.reasons.length > 0;
    const detectors: Record<keyof AnalyzeResponse['coverage'], ToolName[]> = {
      endpoints: ['jsluice'],
      secrets: ['jsluice', 'trufflehog'],
      gql_operations: ['graphql'],
      subdomains: ['domains'],
    };
    const transformedIncomplete = response.tools.some(
      (t) => ['webcrack', 'wakaru'].includes(t.name) && t.status !== 'success',
    );
    for (const category of Object.keys(detectors) as (keyof typeof detectors)[]) {
      const requested = response.tools.filter((t) => detectors[category].includes(t.name));
      response.coverage[category] =
        requested.length === 0
          ? 'not_requested'
          : !requested.some((t) => ['success', 'partial'].includes(t.status))
            ? 'failed'
            : transformedIncomplete ||
                response.truncation.truncated ||
                requested.some((t) => t.status !== 'success')
              ? 'partial'
              : 'complete';
    }
    response.status = !response.tools.some((t) => ['success', 'partial'].includes(t.status))
      ? 'failed'
      : response.truncation.truncated || response.tools.some((t) => t.status !== 'success')
        ? 'partial'
        : 'complete';
  }
  abort() {
    this.closing = true;
    this.controller?.abort();
  }
  async close() {
    this.abort();
    clearInterval(this.purgeTimer);
    await this.active?.catch(() => {});
    this.store.close();
  }
}
