import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

let app: ReturnType<typeof buildApp> | undefined;
try {
  const file = process.env.JSMINER_CONFIG;
  if (!file) throw new Error('Missing configuration.');
  const config = loadConfig(file);
  app = buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app?.close().catch(() => { process.exitCode = 1; }); });
  }
  await app.listen({ host: config.host, port: config.port });
  console.info(`JSMiner phase 1 listening on ${config.host}:${config.port}`);
} catch {
  await app?.close().catch(() => {});
  console.error('Unable to start JSMiner. Check JSMINER_CONFIG, storage and port availability.');
  process.exitCode = 1;
}
