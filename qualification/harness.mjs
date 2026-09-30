import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const read = (name) => readFileSync(new URL(name, import.meta.url));

/** Wait for subprocess exit even on cancellation; escalate if graceful exit stalls. */
export function execute(
  file,
  args,
  { signal, timeout = 120000, graceMs = 10000, ...options } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stopped, force;
    const child = spawn(file, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [],
      stderr = [];
    let bytes = 0,
      spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > (options.maxBuffer ?? 1024 * 1024))
          stop(new Error('Qualification output limit exceeded.'));
        else chunks.push(chunk);
      });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener('abort', abort);
      if (stopped || spawnError || code !== 0)
        reject(
          stopped ?? spawnError ?? new Error(`Qualification subprocess exited with code ${code}.`),
        );
      else
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    });
    const kill = (sig) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(sig);
      }
    };
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), graceMs);
    };
    const abort = () => stop(new Error('Qualification interrupted.'));
    const timer = setTimeout(() => stop(new Error('Qualification subprocess timed out.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** One qualification at a time; invalidate old success before inspecting inputs. */
export function beginReport(name, directory = resolve('.local/qualification')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, '.lock');
  mkdirSync(lock, { mode: 0o700 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const save = (report) => {
    const temporary = resolve(directory, `${name}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, resolve(directory, `${name}.json`));
  };
  const close = () => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    rmSync(lock, { recursive: true });
  };
  try {
    save({ passed: false, started_at: new Date().toISOString() });
  } catch (error) {
    close();
    throw error;
  }
  return { save, close, signal: controller.signal };
}

export async function resolveImages(signal) {
  const images = {},
    details = {};
  for (const tag of [
    'jsminer-jsluice:phase2',
    'jsminer-offline:phase3',
    'jsminer-jsluice:qualification',
    'jsminer-offline:qualification',
  ]) {
    const result = await execute('docker', ['image', 'inspect', tag], { signal, timeout: 10000 });
    const [image] = JSON.parse(result.stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('Invalid image identity.');
    images[tag] = image.Id;
    details[tag] = image;
  }
  for (const [base, qualified] of [
    ['jsminer-jsluice:phase2', 'jsminer-jsluice:qualification'],
    ['jsminer-offline:phase3', 'jsminer-offline:qualification'],
  ]) {
    const layers = details[base].RootFS.Layers;
    if (
      !layers.length ||
      !layers.every((layer, index) => details[qualified].RootFS.Layers[index] === layer)
    )
      throw new Error('Rebuild qualification images from the current production images.');
  }
  return images;
}

export async function cleanupOwner(owner) {
  const args = ['ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`];
  const list = async () =>
    (await execute('docker', args, { timeout: 10000 })).stdout.trim().split(/\s+/).filter(Boolean);
  const ids = await list();
  if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id)))
    throw new Error('Invalid container identity.');
  if (ids.length) await execute('docker', ['rm', '-f', ...ids], { timeout: 10000 });
  if ((await list()).length) throw new Error('Unconfirmed qualification worker cleanup.');
}

export async function runCase(fixture, profile, images, signal, inputs) {
  const owner = `qualification-${randomUUID()}`;
  try {
    const result = await execute(
      process.execPath,
      ['qualification/run-one.mjs', fixture, profile],
      {
        signal,
        timeout: 180000,
        env: {
          ...process.env,
          JSMINER_QUALIFICATION: JSON.stringify({
            owner,
            images,
            corpus_hash: inputs.corpus_hash,
            policy_hash: inputs.policy_hash,
          }),
        },
      },
    );
    return JSON.parse(result.stdout);
  } finally {
    await cleanupOwner(owner);
    signal?.throwIfAborted();
  }
}
