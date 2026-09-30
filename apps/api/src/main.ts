import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

let app: ReturnType<typeof buildApp> | undefined;
let config: ReturnType<typeof loadConfig> | undefined;
try {
  const file = process.env.JSMINER_CONFIG;
  if (!file) throw new Error('Missing configuration.');
  config = loadConfig(file);
  app = buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app?.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  await app.listen({ host: config.host, port: config.port });
  console.info(`JSMiner listening on ${config.host}:${config.port}`);
} catch (error) {
  await app?.close().catch(() => {});
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && config) {
    console.error(
      `Unable to start JSMiner: ${config.host}:${config.port} is already in use (EADDRINUSE). Change "port" in your configuration or stop the service using it.`,
    );
  } else {
    console.error('Unable to start JSMiner. Check JSMINER_CONFIG, storage and port availability.');
  }
  process.exitCode = 1;
}
