import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Refuse to overwrite an existing directory, including its credentials.
const directory = resolve('.local');
try {
  mkdirSync(directory, { mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  const config = {
    database: 'metadata.db',
    tokens: [
      {
        sha256: createHash('sha256').update(token).digest('hex'),
        project_id: 'local',
        permissions: ['analysis:write', 'analysis:read', 'source:read'],
      },
    ],
  };
  writeFileSync(resolve(directory, 'token'), `${token}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(resolve(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.info('Configuration créée dans .local/config.json ; jeton privé dans .local/token.');
} catch (error) {
  console.error(
    error.code === 'EEXIST'
      ? 'Le répertoire .local existe déjà ; aucun fichier existant n’a été modifié.'
      : 'Initialisation impossible. Vérifiez les droits et les éventuels fichiers partiellement créés dans .local.',
  );
  process.exitCode = 1;
}
