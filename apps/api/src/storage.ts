import { chmodSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Open metadata storage; the artifact store owns its additional versioned migration. */
export function openMetadataStore(path: string) {
  if (path !== ':memory:') {
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('Invalid metadata file.');
    chmodSync(path, 0o600);
    for (const suffix of ['-wal', '-shm'])
      if (existsSync(path + suffix)) {
        if (!lstatSync(path + suffix).isFile() || lstatSync(path + suffix).isSymbolicLink())
          throw new Error('Invalid metadata sidecar.');
        chmodSync(path + suffix, 0o600);
      }
  }
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
    timeout: 1000,
  });
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;
    `);
    const probe = database.prepare('SELECT version FROM schema_migrations WHERE version = ?');
    return {
      database,
      isReady: () => probe.get(1)?.version === 1,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
