import { DatabaseSync } from 'node:sqlite';

/** Minimal metadata migration and connectivity probe; artifact storage belongs to phase 2. */
export function openMetadataStore(path: string) {
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
      isReady: () => probe.get(1)?.version === 1,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
