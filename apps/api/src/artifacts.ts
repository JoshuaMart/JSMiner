import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { AnalyzeResponse, ManifestResponse, Module, SourceResponse } from '@jsminer/contracts';
import { validateContract } from '@jsminer/contracts';
import type { ServiceConfig } from './config.ts';
import { ServiceError } from './errors.ts';

const DAY = 24 * 60 * 60 * 1000;
export const sha256 = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
interface Row {
  handle: string;
  project: string;
  expires: number;
  bytes: number;
  manifest: string;
  expired: number;
}
export interface Pending {
  handle: string;
  directory: string;
  bytes: Buffer;
  module: Module;
  project: string;
  sources: { module: Module; bytes: Buffer }[];
  capacity: number;
}

export class ArtifactStore {
  readonly root: string;
  readonly owner: string;
  private readonly temporary: boolean;
  private readonly key: Buffer;
  private readonly lease: DatabaseSync;
  private closed = false;
  private readonly reservations = new Map<string, number>();
  private readonly capacityWaiters = new Set<() => void>();
  private reservedBytes(except?: string) {
    let total = 0;
    for (const [handle, bytes] of this.reservations) if (handle !== except) total += bytes;
    return total;
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: ServiceConfig,
    private readonly now = Date.now,
  ) {
    this.temporary = config.database === ':memory:' && !config.artifact_directory;
    this.root =
      config.artifact_directory ??
      (this.temporary
        ? mkdtempSync(join(tmpdir(), 'jsminer-artifacts-'))
        : resolve(`${config.database}.artifacts`));
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700, recursive: true });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('Artifact directory must be private.');
    // SQLite owns the OS lock: acquisition is atomic and process exit releases it.
    // Never unlink this file: doing so would permit two independent lock inodes.
    const leasePath = join(this.root, '.lease.sqlite');
    try {
      writeFileSync(leasePath, '', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const leaseStat = lstatSync(leasePath);
    if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || (leaseStat.mode & 0o077) !== 0)
      throw new Error('Invalid storage lease.');
    this.lease = new DatabaseSync(leasePath, { timeout: 0, allowExtension: false });
    try {
      this.lease.exec('BEGIN EXCLUSIVE');
    } catch {
      this.lease.close();
      throw new Error('Artifact directory already in use.');
    }
    try {
      const keyFile = join(this.root, '.key');
      if (!existsSync(keyFile))
        writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
      this.key = this.readPrivate(keyFile, 32);
      if (this.key.length !== 32) throw new Error('Invalid artifact key.');
      for (const directory of ['staging', 'objects', 'cache']) {
        const path = join(this.root, directory);
        if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
        if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
          throw new Error('Invalid artifact layout.');
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS step_cache (
        key TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL, size INTEGER NOT NULL,
        version TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cache_expiry ON step_cache(expires);
      INSERT OR IGNORE INTO schema_migrations VALUES (3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      CREATE TABLE IF NOT EXISTS analyses (
        handle TEXT PRIMARY KEY, project TEXT NOT NULL, expires INTEGER NOT NULL,
        bytes INTEGER NOT NULL, manifest TEXT NOT NULL, expired INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS analyses_expiry ON analyses(expires);
      INSERT OR IGNORE INTO schema_migrations VALUES (2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
      // Only this process holds the root lock. Recover unfinished filesystem publication.
      for (const entry of readdirSync(join(this.root, 'staging')))
        rmSync(join(this.root, 'staging', entry), { recursive: true, force: true });
      for (const entry of readdirSync(join(this.root, 'objects'))) {
        if (!this.db.prepare('SELECT 1 FROM analyses WHERE handle=?').get(entry))
          rmSync(join(this.root, 'objects', entry), { recursive: true, force: true });
      }
      for (const entry of readdirSync(join(this.root, 'cache'))) {
        if (!this.db.prepare('SELECT 1 FROM step_cache WHERE key=?').get(entry))
          rmSync(join(this.root, 'cache', entry), { recursive: true, force: true });
      }
      this.purge();
    } catch (error) {
      this.lease.close();
      throw error;
    }
    this.owner = createHash('sha256').update(this.root).digest('hex').slice(0, 24);
  }
  private readPrivate(path: string, max: number): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > max || (st.mode & 0o077) !== 0)
        throw new Error('Invalid private file.');
      const buffer = Buffer.alloc(st.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length !== st.size) throw new Error('Private file changed during read.');
      return buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  }
  mac(project: string, value: string) {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([project, value]))
      .digest('hex');
  }
  private handleBytes() {
    return Number(
      this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM analyses').get()?.n ?? 0,
    );
  }
  private cacheBytes() {
    return Number(
      this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM step_cache').get()?.n ?? 0,
    );
  }
  private evict(key: string) {
    this.removeDirectory(join(this.root, 'cache', key));
    this.db.prepare('DELETE FROM step_cache WHERE key=?').run(key);
  }
  private trimCache(limit: number) {
    let used = this.cacheBytes();
    if (used <= Math.max(0, limit)) return;
    for (const row of this.db
      .prepare('SELECT key,bytes FROM step_cache ORDER BY created,key')
      .all() as { key: string; bytes: number }[]) {
      if (used <= Math.max(0, limit)) break;
      this.evict(row.key);
      used -= row.bytes;
    }
  }
  cached(key: string): { output: Buffer; version: string } | null {
    if (!this.config.cache.enabled) return null;
    const row = this.db.prepare('SELECT * FROM step_cache WHERE key=?').get(key) as
      | { hash: string; size: number; version: string; expires: number }
      | undefined;
    if (!row) return null;
    if (row.expires <= this.now()) {
      this.evict(key);
      return null;
    }
    try {
      const output = this.readPrivate(join(this.root, 'cache', key), 96 * 1024 * 1024);
      if (output.length !== row.size || sha256(output) !== row.hash)
        throw new Error('Invalid cached output.');
      return { output, version: row.version };
    } catch {
      this.evict(key);
      return null;
    }
  }
  cacheStep(key: string, output: Buffer, version: string) {
    if (
      !this.config.cache.enabled ||
      this.db.prepare('SELECT 1 FROM step_cache WHERE key=?').get(key)
    )
      return;
    const bytes = output.length + 8192;
    // Every active handle owns its reservation until publication; cache cannot borrow them.
    const limit = Math.min(
      this.config.cache.max_bytes,
      this.config.budgets.storage_bytes - this.handleBytes() - this.reservedBytes(),
    );
    if (bytes > limit) return;
    this.trimCache(limit - bytes);
    const staging = join(this.root, 'cache', `tmp-${randomUUID()}`);
    const destination = join(this.root, 'cache', key);
    try {
      writeFileSync(staging, output, { mode: 0o600, flag: 'wx' });
      renameSync(staging, destination);
      this.db
        .prepare(
          'INSERT INTO step_cache(key,hash,bytes,size,version,expires,created) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          key,
          sha256(output),
          bytes,
          output.length,
          version,
          this.now() + this.config.cache.retention_ms,
          this.now(),
        );
    } catch {
      this.removeDirectory(staging);
      this.removeDirectory(destination);
      // Cache is optional: publication of the analysis can still succeed.
    }
  }
  purge() {
    for (const row of this.db
      .prepare('SELECT key FROM step_cache WHERE expires<=?')
      .all(this.now()) as { key: string }[])
      this.evict(row.key);
    for (const row of this.db
      .prepare('SELECT handle FROM analyses WHERE expires<=? AND expired=0')
      .all(this.now()) as { handle: string }[]) {
      rmSync(join(this.root, 'objects', row.handle), { recursive: true, force: true });
      this.db
        .prepare('UPDATE analyses SET bytes=0,manifest=?,expired=1 WHERE handle=?')
        .run('[]', row.handle);
    }
    this.db.prepare('DELETE FROM analyses WHERE expired=1 AND expires<=?').run(this.now() - DAY);
    this.trimCache(
      this.config.cache.enabled
        ? Math.min(
            this.config.cache.max_bytes,
            this.config.budgets.storage_bytes - this.handleBytes() - this.reservedBytes(),
          )
        : 0,
    );
  }
  private minimumCapacity(bytes: number) {
    return bytes + this.config.budgets.response_bytes + 8192 + 1024;
  }
  async prepareAvailable(
    project: string,
    bytes: Buffer,
    signal: AbortSignal,
    deadline: number,
  ): Promise<Pending> {
    for (;;) {
      if (signal.aborted) throw new ServiceError(503, 'analysis_cancelled');
      if (performance.now() >= deadline) throw new ServiceError(504, 'global_deadline');
      try {
        return this.prepare(project, bytes);
      } catch (error) {
        // Only pending reservations can be waited on; committed handles cannot be evicted.
        if (
          !(error instanceof ServiceError) ||
          error.code !== 'storage_full' ||
          this.reservations.size === 0 ||
          this.handleBytes() + this.minimumCapacity(bytes.length) >
            this.config.budgets.storage_bytes
        )
          throw error;
      }
      // Keep the already captured bytes. A wakeup retries admission without another HTTP fetch.
      await new Promise<void>((resolve, reject) => {
        const done = (error?: ServiceError) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          this.capacityWaiters.delete(wake);
          if (error) reject(error);
          else resolve();
        };
        const wake = () => done();
        const abort = () => done(new ServiceError(503, 'analysis_cancelled'));
        const timer = setTimeout(wake, Math.max(1, Math.ceil(deadline - performance.now())));
        this.capacityWaiters.add(wake);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  prepare(project: string, bytes: Buffer): Pending {
    this.purge();
    if (bytes.length > this.config.budgets.artifact_bytes)
      throw new ServiceError(413, 'artifact_too_large');
    const used = this.handleBytes() + this.reservedBytes();
    // Include the original manifest as well as the index/storage overhead.
    const reserved = this.minimumCapacity(bytes.length);
    if (used + reserved > this.config.budgets.storage_bytes)
      throw new ServiceError(429, 'storage_full');
    const capacity = Math.min(
      this.config.budgets.artifact_bytes,
      this.config.budgets.storage_bytes - used - 8192,
    );
    this.trimCache(this.config.budgets.storage_bytes - used - capacity - 8192);
    const handle = `ana_${randomUUID()}`;
    const directory = join(this.root, 'staging', handle);
    try {
      mkdirSync(join(directory, 'original'), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, 'original', 'bundle.js'), bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      this.removeDirectory(directory);
      throw error;
    }
    let lines = 1;
    for (const byte of bytes) if (byte === 10) lines++;
    const module: Module = {
      path: 'original/bundle.js',
      origin: 'original',
      parent_path: null,
      bytes: bytes.length,
      lines,
      hash: sha256(bytes),
    };
    this.reservations.set(handle, capacity + 8192);
    return {
      handle,
      directory,
      bytes,
      module,
      project,
      sources: [{ module, bytes }],
      capacity,
    };
  }
  add(
    pending: Pending,
    origin: 'webcrack' | 'wakaru',
    parent: string,
    files: { path: string; content: Buffer }[],
  ) {
    const reasons = new Set<'module_count' | 'artifact_bytes'>();
    const paths = new Set(pending.sources.map((s) => s.module.path));
    if (!paths.has(parent)) throw new Error('Invalid parent.');
    // Validate the whole envelope before writing any file; worker paths never reach the filesystem unchecked.
    for (const file of files) {
      const path = `${origin}/${file.path}`;
      if (!/^(?:bundle\.js|modules\/m[0-9]+\.js)$/.test(file.path) || paths.has(path))
        throw new Error('Invalid module path.');
      paths.add(path);
    }
    let used = pending.sources.reduce((n, s) => n + s.bytes.length, 0);
    let metadata = Buffer.byteLength(JSON.stringify(pending.sources.map((s) => s.module)));
    for (const file of files) {
      if (pending.sources.length >= this.config.budgets.module_count) {
        reasons.add('module_count');
        continue;
      }
      if (
        used + file.content.length + this.config.budgets.response_bytes + metadata + 1024 >
        pending.capacity
      ) {
        reasons.add('artifact_bytes');
        continue;
      }
      const path = `${origin}/${file.path}`;
      const module: Module = {
        path,
        origin,
        parent_path: parent,
        bytes: file.content.length,
        lines: 1,
        hash: sha256(file.content),
      };
      for (const byte of file.content) if (byte === 10) module.lines++;
      mkdirSync(join(pending.directory, origin, 'modules'), { recursive: true, mode: 0o700 });
      writeFileSync(join(pending.directory, path), file.content, { flag: 'wx', mode: 0o600 });
      pending.sources.push({ module, bytes: file.content });
      used += file.content.length;
      metadata += Buffer.byteLength(JSON.stringify(module)) + 1;
    }
    return [...reasons];
  }
  private removeDirectory(directory: string) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      throw new ServiceError(503, 'storage_cleanup_unconfirmed');
    }
  }
  discard(pending: Pending) {
    try {
      rmSync(pending.directory, { recursive: true, force: true });
    } finally {
      this.reservations.delete(pending.handle);
      for (const wake of this.capacityWaiters) wake();
    }
  }
  publish(pending: Pending, response: AnalyzeResponse) {
    const manifest = pending.sources.map((s) => s.module);
    const sourceBytes = pending.sources.reduce((n, s) => n + s.bytes.length, 0);
    const serialized = JSON.stringify(response);
    if (sourceBytes + Buffer.byteLength(serialized) > pending.capacity)
      throw new ServiceError(413, 'artifact_too_large');
    writeFileSync(join(pending.directory, 'result.json'), serialized, { flag: 'wx', mode: 0o600 });
    const total =
      sourceBytes +
      Buffer.byteLength(serialized) +
      Buffer.byteLength(JSON.stringify(manifest)) +
      8192;
    const used = this.handleBytes() + this.reservedBytes(pending.handle);
    this.trimCache(this.config.budgets.storage_bytes - used - total);
    if (used + total > this.config.budgets.storage_bytes)
      throw new ServiceError(429, 'storage_full');
    const destination = join(this.root, 'objects', pending.handle);
    // The index is the publication boundary. Renamed but unindexed objects are private orphans.
    renameSync(pending.directory, destination);
    try {
      this.db
        .prepare('INSERT INTO analyses(handle,project,expires,bytes,manifest) VALUES (?,?,?,?,?)')
        .run(
          pending.handle,
          pending.project,
          Date.parse(response.expires_at),
          total,
          JSON.stringify(manifest),
        );
    } catch (error) {
      this.removeDirectory(destination);
      throw error;
    }
  }
  private lookup(project: string, handle: string): { row: Row; modules: Module[] } {
    const row = this.db
      .prepare('SELECT * FROM analyses WHERE handle=? AND project=?')
      .get(handle, project) as unknown as Row | undefined;
    if (!row) throw new ServiceError(404, 'not_found');
    if (row.expires <= this.now() || row.expired) {
      this.purge();
      throw new ServiceError(this.now() >= row.expires + DAY ? 404 : 410, 'handle_expired');
    }
    const modules: unknown = JSON.parse(row.manifest);
    if (!Array.isArray(modules) || modules.length > this.config.budgets.module_count)
      throw new ServiceError(500, 'invalid_artifact');
    for (let offset = 0; offset < Math.max(modules.length, 1); offset += 100) {
      if (
        !validateContract('ManifestResponse', {
          handle,
          expires_at: new Date(row.expires).toISOString(),
          modules: modules.slice(offset, offset + 100),
          total_modules: modules.length,
          next_cursor: null,
        }).ok
      )
        throw new ServiceError(500, 'invalid_artifact');
    }
    const paths = (modules as Module[]).map((module) => module.path);
    if (new Set(paths).size !== paths.length) throw new ServiceError(500, 'invalid_artifact');
    (modules as Module[]).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { row, modules: modules as Module[] };
  }
  result(project: string, handle: string): AnalyzeResponse {
    this.lookup(project, handle);
    try {
      for (const directory of [join(this.root, 'objects'), join(this.root, 'objects', handle)]) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Invalid artifact directory.');
      }
      const result: unknown = JSON.parse(
        this.readPrivate(
          join(this.root, 'objects', handle, 'result.json'),
          this.config.budgets.response_bytes,
        ).toString(),
      );
      const checked = validateContract('AnalyzeResponse', result);
      if (!checked.ok || checked.value.handle !== handle) throw new Error('Invalid result.');
      return checked.value;
    } catch {
      throw new ServiceError(500, 'invalid_artifact');
    }
  }
  list(project: string, handle: string, limit = 50, cursor?: string): ManifestResponse {
    const { row, modules } = this.lookup(project, handle);
    let index = 0;
    if (cursor) {
      const encoded = Buffer.from(cursor, 'base64url');
      if (encoded.length <= 32) throw new ServiceError(400, 'invalid_cursor');
      const payload = encoded.subarray(0, -32),
        signature = encoded.subarray(-32);
      const expected = Buffer.from(this.mac(project, payload.toString('utf8')), 'hex');
      if (!timingSafeEqual(signature, expected)) throw new ServiceError(400, 'invalid_cursor');
      try {
        const [bound, offset] = JSON.parse(payload.toString());
        if (
          bound !== handle ||
          !Number.isSafeInteger(offset) ||
          offset <= 0 ||
          offset >= modules.length
        )
          throw new Error();
        index = offset;
      } catch {
        throw new ServiceError(400, 'invalid_cursor');
      }
    }
    const page = modules.slice(index, index + limit);
    let next: string | null = null;
    if (index + page.length < modules.length) {
      const payload = Buffer.from(JSON.stringify([handle, index + page.length]));
      next = Buffer.concat([
        payload,
        Buffer.from(this.mac(project, payload.toString()), 'hex'),
      ]).toString('base64url');
    }
    return {
      handle,
      expires_at: new Date(row.expires).toISOString(),
      modules: page,
      total_modules: modules.length,
      next_cursor: next,
    };
  }
  read(
    project: string,
    handle: string,
    path: string,
    offset = 0,
    maxBytes = 16384,
  ): SourceResponse {
    const { modules } = this.lookup(project, handle);
    const module = modules.find((m) => m.path === path);
    if (!module) throw new ServiceError(404, 'not_found');
    let parent = join(this.root, 'objects', handle);
    for (const part of ['', ...path.split('/').slice(0, -1)]) {
      parent = join(parent, part);
      const st = lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new ServiceError(500, 'invalid_artifact');
    }
    let bytes: Buffer;
    try {
      bytes = this.readPrivate(
        join(this.root, 'objects', handle, path),
        this.config.budgets.artifact_bytes,
      );
    } catch {
      throw new ServiceError(500, 'invalid_artifact');
    }
    if (bytes.length !== module.bytes || sha256(bytes) !== module.hash)
      throw new ServiceError(500, 'invalid_artifact');
    if (offset > bytes.length) throw new ServiceError(416, 'invalid_offset');
    if (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80)
      throw new ServiceError(422, 'invalid_source_query');
    let end = Math.min(
      bytes.length,
      offset + Math.min(maxBytes, this.config.budgets.source_read_bytes),
    );
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return {
      handle,
      path,
      content: bytes.subarray(offset, end).toString('utf8'),
      offset,
      returned_bytes: end - offset,
      total_bytes: bytes.length,
      next_offset: end < bytes.length ? end : null,
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.lease.close();
    if (this.temporary) rmSync(this.root, { recursive: true, force: true });
  }
}
