import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import {
  CleanupError,
  DockerWorker,
  OFFLINE_VERSION,
  type Worker,
  type WorkerResult,
} from '@jsminer/adapters';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  selectedTools,
  type ToolName,
  type ToolRun,
  validateContract,
} from '@jsminer/contracts';
import { ArtifactStore, type Pending, sha256 } from './artifacts.ts';
import { capture, validateScript } from './capture.ts';
import type { ServiceConfig } from './config.ts';
import { ServiceError } from './errors.ts';
import { type Category, finalize, merge } from './merge.ts';
import { normalize } from './normalization.ts';
import { decodeModules, normalizeOffline, parseOutput } from './offline.ts';
import { confidenceFilter, endpointFilter } from './result-filters.ts';

export interface EngineOptions {
  worker?: Worker;
  workers?: Partial<Record<ToolName, Worker>>;
  now?: () => number;
}
export class AnalysisEngine {
  readonly store: ArtifactStore;
  private readonly workers: Partial<Record<ToolName, Worker>>;
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
    this.workers =
      options.workers ??
      (options.worker
        ? { jsluice: options.worker }
        : Object.fromEntries(
            (['webcrack', 'wakaru', 'jsluice', 'trufflehog', 'graphql', 'domains'] as const).map(
              (name) => [
                name,
                name === 'jsluice'
                  ? new DockerWorker(config.worker_image, this.store.owner)
                  : new DockerWorker(
                      config.offline_worker_image,
                      this.store.owner,
                      undefined,
                      undefined,
                      {
                        version: OFFLINE_VERSION,
                        protocol: '1',
                        command: [name],
                        maxBytes: ['webcrack', 'wakaru'].includes(name)
                          ? 96 * 1024 * 1024
                          : 2 * 1024 * 1024,
                        tmpfsBytes: 128 * 1024 * 1024,
                      },
                    ),
              ],
            ),
          ));
    this.purgeTimer = setInterval(
      () => {
        try {
          this.store.purge();
        } catch {
          this.blocked = true;
        }
      },
      Math.min(config.budgets.retention_ms, config.cache.retention_ms, 60000),
    );
    this.purgeTimer.unref();
  }
  get healthy() {
    return !this.blocked && !this.closing && Object.values(this.workers).every((w) => w.healthy);
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
    this.controller = new AbortController();
    const controller = this.controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.active = this.execute(project, request, controller.signal).finally(() => {
      signal.removeEventListener('abort', abort);
      this.controller = undefined;
      this.active = undefined;
    });
    return this.active;
  }
  private async execute(
    project: string,
    request: AnalyzeRequest,
    signal: AbortSignal,
  ): Promise<AnalyzeResponse> {
    let pending: Pending | undefined;
    const budget = this.config.budgets;
    const deadline = performance.now() + budget.analysis_ms;
    const names = selectedTools(request);
    try {
      const bytes =
        request.content !== undefined
          ? Buffer.from(request.content)
          : await capture(
              request.url ?? '',
              this.config,
              signal,
              Math.min(budget.capture_ms, deadline - performance.now()),
            );
      if (bytes.length > budget.script_bytes) throw new ServiceError(413, 'script_too_large');
      validateScript(bytes);
      if (request.script_hash && request.script_hash !== sha256(bytes))
        throw new ServiceError(409, 'script_hash_mismatch');
      const docker = names.map((name) => this.workers[name]).find((w) => w instanceof DockerWorker);
      if (docker instanceof DockerWorker && !this.recovered) {
        await docker.recover(budget.cleanup_ms);
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
      const current = pending;
      const sensitive = new Set<string>();
      let sensitiveBytes = 0,
        redactIncomplete = false;
      const addSensitive = (values: string[]) => {
        for (const value of values)
          if (!sensitive.has(value)) {
            sensitiveBytes += Buffer.byteLength(value);
            if (sensitiveBytes > 2 * 1024 * 1024 || sensitive.size >= 2000) {
              redactIncomplete = true;
              break;
            }
            sensitive.add(value);
          }
      };
      const reasons = (values: AnalyzeResponse['truncation']['reasons']) => {
        response.truncation.reasons = [...new Set([...response.truncation.reasons, ...values])];
      };
      type StepResult = WorkerResult & { cacheKey?: string; cacheHit?: boolean };
      const pinned = new Map<ToolName, { identity: string; worker: Worker } | null>();
      const lineage = new Map<string, string>([['original/bundle.js', 'original']]);
      const run = async (
        tool: ToolRun,
        content: Buffer,
        end: number,
        path: string,
      ): Promise<StepResult> => {
        if (signal.aborted) throw new ServiceError(503, 'analysis_cancelled');
        const timeout = Math.min(end, deadline) - performance.now();
        if (timeout <= 0)
          return {
            status: 'skipped',
            version: null,
            durationMs: 0,
            errorCode: deadline <= performance.now() ? 'global_deadline' : 'tool_deadline',
            output: Buffer.alloc(0),
          };
        let worker = this.workers[tool.name];
        if (!worker)
          return {
            status: 'skipped',
            version: null,
            durationMs: 0,
            errorCode: 'tool_unavailable',
            output: Buffer.alloc(0),
          };
        const started = performance.now();
        try {
          if (!pinned.has(tool.name))
            pinned.set(
              tool.name,
              this.config.cache.enabled && worker.pin ? await worker.pin(timeout, signal) : null,
            );
          const runtime = pinned.get(tool.name);
          const cacheKey = runtime
            ? this.store.mac(
                project,
                JSON.stringify([
                  'step-cache-v1',
                  'normalization-v4',
                  tool.name,
                  runtime.identity,
                  sha256(content),
                  lineage.get(path),
                  budget.tool_ms[tool.name],
                  budget.analysis_ms,
                  budget.worker_memory_bytes,
                  budget.worker_cpus,
                  budget.worker_pids,
                  budget.artifact_bytes,
                  budget.module_count,
                ]),
              )
            : undefined;
          const cached = cacheKey ? this.store.cached(cacheKey) : null;
          if (signal.aborted) throw new ServiceError(503, 'analysis_cancelled');
          if (performance.now() >= Math.min(end, deadline))
            return {
              status: 'skipped',
              version: null,
              durationMs: Math.ceil(performance.now() - started),
              errorCode: deadline <= performance.now() ? 'global_deadline' : 'tool_deadline',
              output: Buffer.alloc(0),
            };
          if (cached && cacheKey)
            return {
              ...cached,
              status: 'success',
              durationMs: 0,
              errorCode: null,
              cacheKey,
              cacheHit: true,
            };
          worker = runtime?.worker ?? worker;
          const result = await worker.run({
            content,
            timeoutMs: Math.max(1, Math.min(end, deadline) - performance.now()),
            cleanupMs: budget.cleanup_ms,
            memoryBytes: budget.worker_memory_bytes,
            cpus: budget.worker_cpus,
            pids: budget.worker_pids,
            signal,
          });
          return {
            ...result,
            durationMs: Math.ceil(performance.now() - started),
            ...(cacheKey ? { cacheKey } : {}),
          };
        } catch (error) {
          if (error instanceof ServiceError) throw error;
          if (error instanceof CleanupError || !worker.healthy) throw new CleanupError();
          // The Docker adapter only throws an ordinary error after any attempted
          // container has been cleaned up. Never expose the upstream error text.
          return {
            status: 'error',
            version: null,
            durationMs: Math.ceil(performance.now() - started),
            errorCode: 'worker_failed',
            output: Buffer.alloc(0),
          };
        }
      };
      const remember = (result: StepResult) => {
        if (result.cacheKey && !result.cacheHit && result.version)
          this.store.cacheStep(result.cacheKey, result.output, result.version, current);
      };
      const envelope = (content: Buffer, name: ToolName) =>
        Buffer.from(
          JSON.stringify({
            content: content.toString('utf8'),
            reference_domains:
              name === 'domains' ? [...(request.reference_domains ?? [])].sort() : [],
            max_bytes: ['webcrack', 'wakaru'].includes(name)
              ? Math.max(
                  0,
                  current.capacity -
                    current.sources.reduce((n, s) => n + s.bytes.length, 0) -
                    budget.response_bytes,
                )
              : 0,
            max_modules: ['webcrack', 'wakaru'].includes(name)
              ? Math.max(0, budget.module_count - current.sources.length)
              : 0,
          }),
        );
      for (const name of ['webcrack', 'wakaru'] as const) {
        const tool = tools.find((t) => t.name === name);
        if (!tool) continue;
        const aggregate = current.sources.find(
          (s) => s.module.path === 'webcrack/bundle.js' && s.bytes.length > 0,
        );
        const source = name === 'wakaru' && aggregate ? aggregate : current.sources[0];
        if (!source) throw new Error('Missing original.');
        tool.input_path = source.module.path;
        if (name === 'wakaru' && names.includes('webcrack') && !aggregate)
          response.warnings.push({ tool: name, code: 'fallback_to_original' });
        const result = await run(
          tool,
          envelope(source.bytes, name),
          performance.now() + budget.tool_ms[name],
          source.module.path,
        );
        Object.assign(tool, {
          status: result.status,
          version: result.version,
          duration_ms: result.durationMs,
          error_code: result.errorCode,
        });
        if (result.status === 'success') {
          let output: ReturnType<typeof parseOutput>, files: ReturnType<typeof decodeModules>;
          try {
            output = parseOutput(result.output, true);
            files = decodeModules(output);
          } catch {
            tool.status = 'error';
            tool.error_code = 'invalid_worker_output';
            continue;
          }
          // Filesystem failures propagate: never pretend an incompletely imported representation succeeded.
          const losses = this.store.add(current, name, source.module.path, files);
          reasons([...output.reasons, ...losses]);
          if (output.partial || losses.length) {
            tool.status = 'partial';
            tool.error_code = 'output_truncated';
          } else if (!files.some((file) => file.path === 'bundle.js')) {
            tool.status = 'error';
            tool.error_code = 'missing_aggregate';
          }
          if (tool.status === 'success') {
            tool.cache_hit = result.cacheHit ?? false;
            remember(result);
          }
          const identity = result.cacheKey ?? randomUUID();
          for (const item of current.sources.filter((s) => s.module.origin === name))
            lineage.set(item.module.path, identity);
        }
      }
      const keepEndpoint = endpointFilter(request);
      const keepConfidence = confidenceFilter(request.min_confidence);
      for (const name of ['jsluice', 'trufflehog', 'graphql', 'domains'] as const) {
        const tool = tools.find((t) => t.name === name);
        if (!tool) continue;
        tool.modules_available = current.sources.length;
        const end = performance.now() + budget.tool_ms[name];
        let allCached = true;
        for (const source of current.sources) {
          const result = await run(
            tool,
            name === 'jsluice' ? source.bytes : envelope(source.bytes, name),
            end,
            source.module.path,
          );
          allCached &&= result.cacheHit === true;
          tool.duration_ms += result.durationMs;
          tool.version ??= result.version;
          if (result.status !== 'success') {
            tool.status = result.status;
            tool.error_code = result.errorCode;
            // Exhausted budgets and unavailable images cannot improve for a subsequent module.
            if (['timeout', 'skipped'].includes(result.status)) break;
            continue;
          }
          try {
            if (name === 'jsluice') {
              const normalized = normalize(
                result.output,
                (v) => this.store.mac(project, v),
                request.base_url,
                request.redact_query_values,
              );
              for (const value of [...normalized.endpoints, ...normalized.secrets])
                for (const e of value.evidence) {
                  e.module_path = source.module.path;
                  e.representation = source.module.origin;
                }
              addSensitive(normalized.sensitive);
              redactIncomplete ||= normalized.secretsTruncated;
              merge(
                response,
                'endpoints',
                normalized.endpoints.filter(keepConfidence).filter(keepEndpoint),
              );
              merge(response, 'secrets', normalized.secrets.filter(keepConfidence));
              reasons(normalized.reasons);
              if (!normalized.partial) remember(result);
              if (normalized.partial) {
                tool.status = 'partial';
                tool.error_code = normalized.syntaxError ? 'syntax_incomplete' : 'output_truncated';
              } else if (tool.error_code === 'tool_unavailable') {
                tool.status = 'success';
                tool.error_code = null;
              }
            } else {
              const output = parseOutput(result.output, false);
              const normalized = normalizeOffline(output, name, source.module, (v) =>
                this.store.mac(project, v),
              );
              if (
                name === 'domains' &&
                normalized.subdomains.some(
                  (d) =>
                    !request.reference_domains?.includes(d.reference_domain) ||
                    !d.hostname.endsWith(`.${d.reference_domain}`),
                )
              )
                throw new Error('Invalid domain.');
              addSensitive(normalized.sensitive);
              if (name === 'trufflehog' && output.partial) redactIncomplete = true;
              merge(response, 'secrets', normalized.secrets.filter(keepConfidence));
              merge(response, 'gql_operations', normalized.gql_operations.filter(keepConfidence));
              merge(response, 'subdomains', normalized.subdomains.filter(keepConfidence));
              reasons(output.reasons);
              if (!output.partial) remember(result);
              if (output.partial) {
                tool.status = 'partial';
                tool.error_code = output.error_code;
                if (
                  output.error_code === 'incomplete_document' &&
                  !response.warnings.some(
                    (w) => w.tool === name && w.code === 'incomplete_document',
                  )
                )
                  response.warnings.push({ tool: name, code: 'incomplete_document' });
              } else if (tool.error_code === 'tool_unavailable') {
                tool.status = 'success';
                tool.error_code = null;
              }
            }
            tool.modules_analyzed = (tool.modules_analyzed ?? 0) + 1;
          } catch (error) {
            if (error instanceof ServiceError) throw error;
            tool.status = 'error';
            tool.error_code = 'invalid_worker_output';
          }
        }
        tool.cache_hit = allCached && tool.status === 'success';
        // A failed module never cancels findings from completed modules.
        if (tool.status === 'success' && tool.modules_analyzed !== tool.modules_available) {
          tool.status = 'partial';
          tool.error_code = 'incomplete_modules';
        }
      }
      finalize(response, [...sensitive], redactIncomplete, (v) => this.store.mac(project, v));
      response.endpoints = response.endpoints.filter(keepEndpoint);
      if (signal.aborted) throw new ServiceError(503, 'analysis_cancelled');
      if (performance.now() >= deadline) {
        const last = (
          ['domains', 'graphql', 'trufflehog', 'jsluice', 'wakaru', 'webcrack'] as const
        )
          .map((name) => tools.find((tool) => tool.name === name))
          .find((tool) => tool !== undefined);
        if (last?.status === 'success') {
          last.status = 'partial';
          last.error_code = 'global_deadline';
        }
      }
      this.statuses(response);
      while (Buffer.byteLength(JSON.stringify(response)) > budget.response_bytes) {
        const categories: Category[] = ['endpoints', 'secrets', 'gql_operations', 'subdomains'];
        categories.sort((a, b) => response[b].length - response[a].length);
        const category = categories[0];
        if (!category || !response[category].length)
          throw new ServiceError(503, 'response_budget_too_small');
        if (!response.truncation.reasons.includes('response_bytes'))
          response.truncation.reasons.push('response_bytes');
        response[category].pop();
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
    for (const tool of response.tools) if (tool.status !== 'success') tool.cache_hit = false;
    const hits = response.tools.filter((tool) => tool.cache_hit).length;
    response.cache.status =
      hits === 0 ? 'miss' : hits === response.tools.length ? 'hit' : 'partial_hit';
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
          : !response[category].length &&
              !requested.some((t) => ['success', 'partial'].includes(t.status))
            ? 'failed'
            : transformedIncomplete ||
                response.truncation.truncated ||
                requested.some((t) => t.status !== 'success')
              ? 'partial'
              : 'complete';
    }
    response.status =
      ![
        ...response.endpoints,
        ...response.secrets,
        ...response.gql_operations,
        ...response.subdomains,
      ].length && !response.tools.some((t) => ['success', 'partial'].includes(t.status))
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
