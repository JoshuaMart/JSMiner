import { randomUUID } from 'node:crypto';
import type { ErrorResponse, Models, Permission } from '@jsminer/contracts';
import { schema, validateContract } from '@jsminer/contracts';
import Fastify from 'fastify';
import type { Principal } from './auth.ts';
import { createAuthenticator } from './auth.ts';
import { parseConfig } from './config.ts';
import { openMetadataStore } from './storage.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    permissions?: readonly Permission[];
  }
}

export function buildApp(configuration: unknown) {
  const config = parseConfig(configuration);
  const storage = openMetadataStore(config.database);
  const app = Fastify({
    logger: false,
    bodyLimit: config.budgets.http_body_bytes,
    routerOptions: { maxParamLength: schema.$defs.Identifier.maxLength },
    requestTimeout: config.budgets.analysis_ms + config.budgets.cleanup_ms + 5000,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  // Decode only after Fastify has bounded the raw bytes. Keep its JSON parser's
  // structural protections, while refusing UTF-8 replacement before parsing.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      let text: string;
      try {
        text = decoder.decode(body);
      } catch {
        done(Object.assign(new Error('Invalid UTF-8.'), { statusCode: 422, code: 'invalid_utf8' }));
        return;
      }
      parseJson(request, text, done);
    },
  );
  const authenticate = createAuthenticator(config.tokens);
  const errorBody = (id: string, code: string, message: string): ErrorResponse => ({
    error: { code, message, request_id: id },
  });
  app.decorateRequest('principal', null);
  app.addHook('onClose', async () => storage.close());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    request.principal = authenticate(request.headers.authorization);
    if (!request.principal) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply
        .code(401)
        .send(errorBody(request.id, 'unauthorized', 'Authentification requise.'));
    }
    const permissions = request.routeOptions.config.permissions;
    if (permissions && !permissions.every((p) => request.principal?.permissions.includes(p)))
      return reply.code(403).send(errorBody(request.id, 'forbidden', 'Droit insuffisant.'));
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
      return reply
        .code(415)
        .send(
          errorBody(
            request.id,
            'unsupported_encoding',
            'Compression de requête non prise en charge.',
          ),
        );
    if (
      request.method === 'POST' &&
      !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
    )
      return reply
        .code(415)
        .send(errorBody(request.id, 'unsupported_media_type', 'Un corps JSON est requis.'));
  });
  app.setErrorHandler((error, request, reply) => {
    const fault = error as { code?: string; statusCode?: number };
    if (fault.code === 'invalid_utf8')
      return reply
        .code(422)
        .send(
          errorBody(
            request.id,
            'invalid_content',
            'Le corps JSON doit être encodé en UTF-8 valide.',
          ),
        );
    const status =
      fault.statusCode === 413
        ? 413
        : fault.statusCode === 415
          ? 415
          : fault.statusCode === 400
            ? 400
            : 500;
    const code =
      status === 413
        ? 'body_too_large'
        : status === 415
          ? 'unsupported_media_type'
          : status === 400
            ? 'invalid_input'
            : 'internal_error';
    reply
      .code(status)
      .send(errorBody(request.id, code, status === 500 ? 'Erreur interne.' : 'Requête refusée.'));
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody(request.id, 'not_found', 'Ressource inconnue.')),
  );

  app.get('/health', { config: { permissions: ['analysis:read'] } }, async (request, reply) => {
    if (!storage.isReady())
      return reply
        .code(503)
        .send(errorBody(request.id, 'storage_unavailable', 'Stockage indisponible.'));
    return { status: 'ok', phase: 1, storage: 'ready' };
  });
  const notImplemented = (id: string) =>
    errorBody(
      id,
      'not_implemented',
      'Le moteur d’analyse et les artefacts seront implémentés après la phase 1.',
    );

  app.post(
    '/analyze',
    { config: { permissions: ['analysis:write', 'analysis:read'] } },
    async (request, reply) => {
      const result = validateContract('AnalyzeRequest', request.body);
      if (!result.ok)
        return reply
          .code(result.status)
          .send(errorBody(request.id, result.code, 'Entrée d’analyse invalide.'));
      if (
        result.value.content !== undefined &&
        Buffer.byteLength(result.value.content) > config.budgets.script_bytes
      )
        return reply
          .code(413)
          .send(errorBody(request.id, 'script_too_large', 'Script trop volumineux.'));
      return reply.code(501).send(notImplemented(request.id));
    },
  );

  function normalizeQuery(raw: unknown, integers: readonly string[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        integers.includes(key) && typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
          ? Number(value)
          : value,
      ]),
    );
  }
  function invalid<K extends keyof Models>(name: K, input: unknown) {
    const result = validateContract(name, input);
    return result.ok ? null : result;
  }
  app.get(
    '/source/:handle',
    { config: { permissions: ['source:read'] } },
    async (request, reply) => {
      const problem =
        invalid('ManifestParams', request.params) ??
        invalid('SourceListQuery', normalizeQuery(request.query, ['limit']));
      if (problem)
        return reply
          .code(problem.status)
          .send(errorBody(request.id, problem.code, 'Paramètres de manifeste invalides.'));
      return reply.code(501).send(notImplemented(request.id));
    },
  );
  app.get(
    '/source/:handle/*',
    { config: { permissions: ['source:read'] } },
    async (request, reply) => {
      const params = request.params as { handle: string; '*': string };
      const problem =
        invalid('SourceParams', { handle: params.handle, path: params['*'] }) ??
        invalid('SourceReadQuery', normalizeQuery(request.query, ['offset', 'max_bytes']));
      if (problem)
        return reply
          .code(problem.status)
          .send(errorBody(request.id, problem.code, 'Paramètres de lecture invalides.'));
      return reply.code(501).send(notImplemented(request.id));
    },
  );
  return app;
}
