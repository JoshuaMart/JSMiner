import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

for (const [base, tag, command] of [
  ['jsminer-jsluice:phase2', 'jsminer-jsluice:qualification', ['/metrics', '/worker']],
  [
    'jsminer-offline:phase3',
    'jsminer-offline:qualification',
    ['/metrics', 'node', '--no-node-snapshot', '/worker/worker.mjs'],
  ],
]) {
  // Resolve the local image first; qualification never substitutes a remote image.
  const image = execFileSync('docker', ['image', 'inspect', base, '--format', '{{.Id}}'], {
    encoding: 'utf8',
  }).trim();
  const pinned = `jsminer-qualification-base:${randomUUID()}`;
  execFileSync('docker', ['tag', image, pinned]);
  const { readFileSync } = await import('node:fs');
  const dockerfile = `${readFileSync(new URL('./metrics/Dockerfile', import.meta.url), 'utf8')}\nENTRYPOINT ${JSON.stringify(command)}\n`;
  try {
    execFileSync(
      'docker',
      [
        'build',
        '--build-arg',
        `BASE_IMAGE=${pinned}`,
        '-t',
        tag,
        '-f',
        '-',
        'qualification/metrics',
      ],
      { input: dockerfile, stdio: ['pipe', 'inherit', 'inherit'] },
    );
  } finally {
    execFileSync('docker', ['image', 'rm', pinned], { stdio: 'ignore' });
  }
}
