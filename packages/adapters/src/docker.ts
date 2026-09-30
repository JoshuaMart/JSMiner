import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BATCH_OUTPUT_BYTES, type BatchResult, decodeBatch, encodeBatch } from './batch.js';

export const JSLUICE_PROTOCOL = '3';
export const JSLUICE_VERSION = '0ddfab153e060a9eeaded4d8669233f7c071e7e4-treesitterdd81d9e9be82-v5';
export const OFFLINE_VERSION = 'webcrack2.16.0-wakaru1.12.0-trufflehog3.97.9-static4';
export interface WorkerProfile {
  version: string;
  protocol: string;
  command: string[];
  maxBytes: number;
  tmpfsBytes?: number;
  nodeHeap?: boolean;
}
export interface CommandOptions {
  timeoutMs: number;
  maxBytes: number;
  input?: Buffer;
  signal?: AbortSignal;
}
export interface CommandResult {
  code: number | null;
  output: Buffer;
  fault: 'timeout' | 'aborted' | 'output_limit' | 'spawn_error' | null;
  memoryLimit?: boolean;
}
export type Command = (args: string[], options: CommandOptions) => Promise<CommandResult>;

/** Bound both streams, and wait for the CLI to exit even after interrupting it. */
export const dockerCommand: Command = (args, options) =>
  new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let fault: CommandResult['fault'] = null;
    let stderrTail = '';
    let memoryLimit = false;
    const stop = (reason: NonNullable<CommandResult['fault']>) => {
      fault ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), Math.max(1, options.timeoutMs));
    const abort = () => stop('aborted');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) stop('output_limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) stop('output_limit');
      // Retain only a fixed classification, never upstream diagnostics or source.
      const diagnostic = stderrTail + chunk.toString();
      memoryLimit ||= /FATAL ERROR:[^\n]*heap out of memory/.test(diagnostic);
      stderrTail = diagnostic.slice(-256);
    });
    child.on('error', () => {
      fault = 'spawn_error';
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, output: Buffer.concat(chunks), fault, memoryLimit });
    });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input);
  });

export interface WorkerInput {
  content: Buffer;
  timeoutMs: number;
  cleanupMs: number;
  memoryBytes: number;
  findingCount?: number;
  cpus: number;
  pids: number;
  signal: AbortSignal;
}
export interface WorkerResult {
  status: 'success' | 'error' | 'timeout' | 'skipped';
  output: Buffer;
  durationMs: number;
  errorCode: string | null;
  version: string | null;
}
export interface BatchInput extends Omit<WorkerInput, 'content'> {
  contents: Buffer[];
}
export interface Worker {
  runBatch?(input: BatchInput): Promise<BatchResult>;
  run(input: WorkerInput): Promise<WorkerResult>;
  readonly healthy: boolean;
  /** Resolve an immutable runtime identity before cache lookup. */
  pin?(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ identity: string; worker: Worker } | null>;
}
type CleanupStage =
  | 'worker_state'
  | 'recovery_list'
  | 'recovery_remove'
  | 'recovery_verify'
  | 'cleanup_remove'
  | 'cleanup_verify';
type CleanupReason =
  | NonNullable<CommandResult['fault']>
  | 'unknown'
  | 'command_failed'
  | 'invalid_output'
  | 'container_remaining'
  | 'creation_uncertain';
export class CleanupError extends Error {
  constructor(
    readonly stage: CleanupStage = 'worker_state',
    readonly reason: CleanupReason = 'unknown',
  ) {
    super('Worker cleanup could not be confirmed.');
  }
}

/** One container per transform or extraction batch; no host mounts, credentials, or network. */
export class DockerWorker implements Worker {
  private health = { healthy: true };
  get healthy() {
    return this.health.healthy;
  }
  constructor(
    private readonly image: string,
    private readonly owner: string,
    private readonly command: Command = dockerCommand,
    private readonly now = () => performance.now(),
    private readonly profile: WorkerProfile = {
      version: JSLUICE_VERSION,
      protocol: JSLUICE_PROTOCOL,
      command: [],
      maxBytes: 2 * 1024 * 1024 + 65536,
    },
  ) {}

  async pin(timeoutMs: number, signal: AbortSignal) {
    if (!this.healthy) throw new CleanupError();
    if (signal.aborted || timeoutMs <= 0) return null;
    const image = await this.command(
      [
        'image',
        'inspect',
        this.image,
        '--format',
        '{{.Id}} {{index .Config.Labels "io.jsminer.version"}} {{index .Config.Labels "io.jsminer.protocol"}}',
      ],
      { timeoutMs, signal, maxBytes: 65536 },
    );
    const [id, version, protocol] = image.output.toString().trim().split(' ');
    if (
      image.code !== 0 ||
      image.fault ||
      !id ||
      !/^sha256:[0-9a-f]{64}$/.test(id) ||
      version !== this.profile.version ||
      protocol !== this.profile.protocol
    )
      return null;
    const worker = new DockerWorker(id, this.owner, this.command, this.now, this.profile);
    worker.health = this.health;
    return { identity: JSON.stringify([id, this.profile]), worker };
  }

  async recover(cleanupMs: number) {
    const limit = this.now() + cleanupMs;
    let stage: CleanupStage = 'recovery_list';
    const invoke = (args: string[]) => {
      const remaining = limit - this.now();
      if (remaining <= 0) throw new CleanupError(stage, 'timeout');
      return this.command(args, { timeoutMs: remaining, maxBytes: 65536 });
    };
    try {
      const listing = await invoke([
        'ps',
        '-aq',
        '--filter',
        `label=io.jsminer.owner=${this.owner}`,
      ]);
      if (listing.code !== 0 || listing.fault)
        throw new CleanupError(stage, listing.fault ?? 'command_failed');
      const ids = listing.output.toString().trim().split(/\s+/).filter(Boolean);
      if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
        throw new CleanupError(stage, 'invalid_output');
      stage = 'recovery_remove';
      for (const id of ids) {
        const removal = await invoke(['rm', '--force', id]);
        if (removal.fault) throw new CleanupError(stage, removal.fault);
      }
      stage = 'recovery_verify';
      const after = await invoke(['ps', '-aq', '--filter', `label=io.jsminer.owner=${this.owner}`]);
      if (after.code !== 0 || after.fault)
        throw new CleanupError(stage, after.fault ?? 'command_failed');
      if (after.output.toString().trim()) throw new CleanupError(stage, 'container_remaining');
    } catch (error) {
      this.health.healthy = false;
      throw error instanceof CleanupError ? error : new CleanupError(stage);
    }
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    return this.execute(input);
  }
  async runBatch(input: BatchInput): Promise<BatchResult> {
    const started = this.now();
    const content = encodeBatch(input.contents);
    const execution = await this.execute(
      { ...input, content, timeoutMs: input.timeoutMs - (this.now() - started) },
      true,
    );
    if (input.signal.aborted) execution.output = Buffer.alloc(0);
    return decodeBatch(execution, input.contents.length);
  }
  private async execute(input: WorkerInput, batch = false): Promise<WorkerResult> {
    if (!this.healthy) throw new CleanupError();
    const started = this.now();
    const deadline = started + input.timeoutMs;
    let creationAttempted = false;
    const invoke = (args: string[], stdin?: Buffer): Promise<CommandResult> => {
      const remaining = deadline - this.now();
      const fault = input.signal.aborted ? 'aborted' : remaining <= 0 ? 'timeout' : null;
      if (fault) return Promise.resolve({ code: null, output: Buffer.alloc(0), fault });
      if (args[0] === 'create') creationAttempted = true;
      return this.command(args, {
        timeoutMs: remaining,
        maxBytes:
          args[0] === 'start' ? (batch ? BATCH_OUTPUT_BYTES : this.profile.maxBytes) : 65536,
        ...(stdin ? { input: stdin } : {}),
        signal: input.signal,
      });
    };
    const result = (
      status: WorkerResult['status'],
      errorCode: string | null,
      output: Buffer = Buffer.alloc(0),
    ): WorkerResult => ({
      status,
      errorCode,
      output,
      durationMs: Math.ceil(this.now() - started),
      version: status === 'skipped' ? null : this.profile.version,
    });
    const image = await invoke([
      'image',
      'inspect',
      this.image,
      '--format',
      '{{.Id}} {{index .Config.Labels "io.jsminer.version"}} {{index .Config.Labels "io.jsminer.protocol"}}',
    ]);
    if (image.fault) return result(image.fault === 'timeout' ? 'timeout' : 'error', image.fault);
    const [id, version, protocol] = image.output.toString().trim().split(' ');
    if (
      image.code !== 0 ||
      !id ||
      !/^sha256:[0-9a-f]{64}$/.test(id) ||
      version !== this.profile.version ||
      protocol !== this.profile.protocol
    )
      return result('skipped', 'tool_unavailable');
    const name = `jsminer-${randomUUID()}`;
    let uncertainCreation = true;
    let execution: WorkerResult;
    try {
      const created = await invoke([
        'create',
        '--pull=never',
        '--name',
        name,
        '--label',
        `io.jsminer.owner=${this.owner}`,
        '--network=none',
        '--read-only',
        '--user=65532:65532',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        `--memory=${input.memoryBytes}`,
        `--memory-swap=${input.memoryBytes}`,
        `--cpus=${input.cpus}`,
        `--pids-limit=${input.pids}`,
        '--ulimit',
        'nofile=64:64',
        '--ulimit',
        'core=0:0',
        '--log-driver=none',
        '--interactive',
        '--env',
        `JSMINER_MAX_FINDINGS=${input.findingCount ?? 200}`,
        ...(this.profile.nodeHeap
          ? [
              '--env',
              `NODE_OPTIONS=--max-old-space-size=${Math.max(16, Math.floor((input.memoryBytes / 1048576) * 0.7))}`,
            ]
          : []),
        ...(this.profile.tmpfsBytes
          ? ['--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.profile.tmpfsBytes},mode=1777`]
          : []),
        id,
        ...this.profile.command,
        ...(batch ? ['--batch'] : []),
      ]);
      uncertainCreation = created.fault !== null;
      if (created.code !== 0 || created.fault)
        execution = result(
          created.fault === 'timeout' ? 'timeout' : 'error',
          created.fault ?? 'worker_start_failed',
        );
      else {
        const ran = await invoke(['start', '--attach', '--interactive', name], input.content);
        execution = ran.fault
          ? result(
              ran.fault === 'timeout' ? 'timeout' : 'error',
              ran.fault,
              batch ? ran.output : undefined,
            )
          : ran.code === 0
            ? result('success', null, ran.output)
            : result(
                'error',
                ran.memoryLimit ? 'memory_limit' : 'worker_failed',
                batch ? ran.output : undefined,
              );
        if (!ran.fault && ran.code !== 0 && !ran.memoryLimit) {
          const state = await invoke(['inspect', '--format', '{{.State.OOMKilled}}', name]);
          if (!state.fault && state.code === 0 && state.output.toString().trim() === 'true')
            execution = result('error', 'memory_limit', batch ? ran.output : undefined);
        }
      }
    } finally {
      if (creationAttempted) await this.cleanup(name, input.cleanupMs, uncertainCreation);
    }
    return execution;
  }
  private async cleanup(name: string, timeoutMs: number, uncertainCreation: boolean) {
    let stage: CleanupStage = 'cleanup_remove';
    try {
      const end = this.now() + timeoutMs;
      await this.command(['rm', '--force', name], { timeoutMs, maxBytes: 65536 });
      if (end <= this.now()) throw new CleanupError(stage, 'timeout');
      stage = 'cleanup_verify';
      const absent = await this.command(['ps', '-aq', '--filter', `name=^/${name}$`], {
        timeoutMs: end - this.now(),
        maxBytes: 65536,
      });
      if (absent.code !== 0 || absent.fault)
        throw new CleanupError(stage, absent.fault ?? 'command_failed');
      if (absent.output.toString().trim()) throw new CleanupError(stage, 'container_remaining');
      // An interrupted create request may still complete later in the daemon.
      if (uncertainCreation) throw new CleanupError(stage, 'creation_uncertain');
    } catch (error) {
      this.health.healthy = false;
      throw error instanceof CleanupError ? error : new CleanupError(stage);
    }
  }
}
