import { existsSync, lstatSync } from 'node:fs';
import { ArtifactStore } from '../apps/api/dist/artifacts.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { openMetadataStore } from '../apps/api/dist/storage.js';

let metadata,
  artifacts,
  failed = false;
try {
  if (!process.env.JSMINER_CONFIG) throw new Error();
  const config = loadConfig(process.env.JSMINER_CONFIG);
  const root = config.artifact_directory ?? `${config.database}.artifacts`;
  if (
    config.database === ':memory:' ||
    !existsSync(config.database) ||
    !lstatSync(config.database).isFile() ||
    !existsSync(root)
  )
    throw new Error();
  metadata = openMetadataStore(config.database);
  artifacts = new ArtifactStore(metadata.database, config);
  artifacts.purge();
} catch {
  failed = true;
} finally {
  for (const resource of [artifacts, metadata]) {
    try {
      resource?.close();
    } catch {
      failed = true;
    }
  }
}
if (failed) {
  console.error(
    'Purge impossible. Arrêtez le service et vérifiez JSMINER_CONFIG ainsi que les droits du stockage.',
  );
  process.exitCode = 1;
} else {
  console.info('Purge des données expirées terminée. Les handles actifs sont conservés.');
}
