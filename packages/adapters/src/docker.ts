import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const JSLUICE_PROTOCOL = '3';
export const JSLUICE_VERSION = '0ddfab153e060a9eeaded4d8669233f7c071e7e4';
export const OFFLINE_VERSION = 'webcrack2.16.0-wakaru1.12.0-trufflehog3.97.9-static2';
export interface WorkerProfile {
  version: string;
  protocol: string;
  command: string[];
  maxBytes: number;
  tmpfsBytes?: number;
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
}
export type Command = (args: string[], options: CommandOptions) => Promise<CommandResult>;

/** Bound both streams, and wait for the CLI to exit even after interrupting it. */
export const dockerCommand: Command = (args, options) =>
  new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let fault: CommandResult['fault'] = null;
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
      // Deliberately discard tool/daemon errors; they may contain source or local paths.
    });
    child.on('error', () => {
      fault = 'spawn_error';
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, output: Buffer.concat(chunks), fault });
    });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input);
  });

export interface WorkerInput {
  content: Buffer;
  timeoutMs: number;
  cleanupMs: number;
  memoryBytes: number;
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
export interface Worker {
  run(input: WorkerInput): Promise<WorkerResult>;
  readonly healthy: boolean;
}
export class CleanupError extends Error {
  constructor() {
    super('Worker cleanup could not be confirmed.');
  }
}

/** One container per input; no bind mounts, Docker socket, credentials, or network. */
export class DockerWorker implements Worker {
  healthy = true;
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

  async recover(cleanupMs: number) {
    const limit = this.now() + cleanupMs;
    const invoke = (args: string[]) => {
      const remaining = limit - this.now();
      if (remaining <= 0) throw new CleanupError();
      return this.command(args, { timeoutMs: remaining, maxBytes: 65536 });
    };
    try {
      const listing = await invoke([
        'ps',
        '-aq',
        '--filter',
        `label=io.jsminer.owner=${this.owner}`,
      ]);
      if (listing.code !== 0 || listing.fault) throw new CleanupError();
      const ids = listing.output.toString().trim().split(/\s+/).filter(Boolean);
      if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) throw new CleanupError();
      for (const id of ids) {
        const removal = await invoke(['rm', '--force', id]);
        if (removal.fault) throw new CleanupError();
      }
      const after = await invoke(['ps', '-aq', '--filter', `label=io.jsminer.owner=${this.owner}`]);
      if (after.code !== 0 || after.fault || after.output.toString().trim())
        throw new CleanupError();
    } catch {
      this.healthy = false;
      throw new CleanupError();
    }
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
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
        maxBytes: args[0] === 'start' ? this.profile.maxBytes : 65536,
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
        ...(this.profile.tmpfsBytes
          ? ['--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.profile.tmpfsBytes},mode=1777`]
          : []),
        id,
        ...this.profile.command,
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
          ? result(ran.fault === 'timeout' ? 'timeout' : 'error', ran.fault)
          : ran.code === 0
            ? result('success', null, ran.output)
            : result('error', 'worker_failed');
      }
    } finally {
      if (creationAttempted) await this.cleanup(name, input.cleanupMs, uncertainCreation);
    }
    return execution;
  }
  private async cleanup(name: string, timeoutMs: number, uncertainCreation: boolean) {
    try {
      const end = this.now() + timeoutMs;
      await this.command(['rm', '--force', name], { timeoutMs, maxBytes: 65536 });
      if (end <= this.now()) throw new CleanupError();
      const absent = await this.command(['ps', '-aq', '--filter', `name=^/${name}$`], {
        timeoutMs: end - this.now(),
        maxBytes: 65536,
      });
      if (uncertainCreation || absent.code !== 0 || absent.fault || absent.output.toString().trim())
        throw new CleanupError();
    } catch {
      this.healthy = false;
      throw new CleanupError();
    }
  }
}
