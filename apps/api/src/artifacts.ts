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
}

export class ArtifactStore {
  readonly root: string;
  readonly owner: string;
  private readonly temporary: boolean;
  private readonly key: Buffer;
  private readonly lease: DatabaseSync;
  private closed = false;
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
      for (const directory of ['staging', 'objects']) {
        const path = join(this.root, directory);
        if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
        if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
          throw new Error('Invalid artifact layout.');
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS analyses (
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
  purge() {
    for (const row of this.db
      .prepare('SELECT handle FROM analyses WHERE expires<=? AND expired=0')
      .all(this.now()) as { handle: string }[]) {
      rmSync(join(this.root, 'objects', row.handle), { recursive: true, force: true });
      this.db
        .prepare('UPDATE analyses SET bytes=0,manifest=?,expired=1 WHERE handle=?')
        .run('[]', row.handle);
    }
    this.db.prepare('DELETE FROM analyses WHERE expired=1 AND expires<=?').run(this.now() - DAY);
  }
  prepare(project: string, bytes: Buffer): Pending {
    this.purge();
    if (bytes.length > this.config.budgets.artifact_bytes)
      throw new ServiceError(413, 'artifact_too_large');
    const used = Number(
      this.db.prepare('SELECT coalesce(sum(bytes),0) AS used FROM analyses').get()?.used ?? 0,
    );
    const reserved = bytes.length + this.config.budgets.response_bytes + 8192;
    if (used + reserved > this.config.budgets.storage_bytes)
      throw new ServiceError(429, 'storage_full');
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
    return { handle, directory, bytes, module, project };
  }
  private removeDirectory(directory: string) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      throw new ServiceError(503, 'storage_cleanup_unconfirmed');
    }
  }
  discard(pending: Pending) {
    rmSync(pending.directory, { recursive: true, force: true });
  }
  publish(pending: Pending, response: AnalyzeResponse) {
    const manifest = [pending.module];
    const serialized = JSON.stringify(response);
    if (pending.bytes.length + Buffer.byteLength(serialized) > this.config.budgets.artifact_bytes)
      throw new ServiceError(413, 'artifact_too_large');
    writeFileSync(join(pending.directory, 'result.json'), serialized, { flag: 'wx', mode: 0o600 });
    const total = pending.bytes.length + Buffer.byteLength(serialized) + 8192;
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
