import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const root = new URL('../', import.meta.url);
const schema = JSON.parse(await readFile(new URL('schema.json', root), 'utf8'));
const types = await compile(schema, 'JSMinerContract', {
  bannerComment: '/* Generated from schema.json. Run pnpm contracts:generate. */',
  unreachableDefinitions: true,
  maxItems: -1,
});
const rewrite = (value) =>
  JSON.parse(JSON.stringify(value).replaceAll('#/$defs/', '#/components/schemas/'));
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (name) => ({ 'application/json': { schema: ref(name) } });
const response = (description, name) => ({ description, content: json(name) });
const errorDescriptions = {
  400: 'Invalid request or cursor',
  401: 'Missing or invalid credentials',
  403: 'Permission or capture policy denied',
  404: 'Unknown resource or another project',
  409: 'Script hash mismatch',
  410: 'Expired handle',
  413: 'Body or script too large',
  415: 'Unsupported media type or encoding',
  416: 'Offset beyond module',
  422: 'Invalid content or semantic parameters',
  429: 'Capacity or storage quota exceeded',
  500: 'Internal failure',
  501: 'URL acquisition is not implemented (offline content only)',
  502: 'Capture failed',
  503: 'Service unavailable',
  504: 'Capture timeout',
};
const responses = (name, codes) =>
  Object.fromEntries([
    ['200', response('Successful response (analysis may be partial or failed)', name)],
    ...codes.map((code) => [
      code,
      {
        ...response(errorDescriptions[code], 'ErrorResponse'),
        ...(code === 429
          ? {
              headers: {
                'Retry-After': {
                  schema: { type: 'string' },
                  description: 'Delay before retrying in seconds',
                },
              },
            }
          : {}),
      },
    ]),
  ]);
const param = (name, location, property, description) => ({
  name,
  in: location,
  required: location === 'path',
  schema: rewrite(property),
  description,
});
const handle = param(
  'handle',
  'path',
  { $ref: '#/$defs/Identifier' },
  'Opaque handle bound to the authenticated project',
);
const query = (name) =>
  Object.entries(schema.$defs[name].properties).map(([key, value]) =>
    param(key, 'query', value, `See ${name}`),
  );
const document = {
  openapi: '3.1.1',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'JSMiner API',
    version: '0.1.0',
    description:
      'Offline content analysis with isolated webcrack, Wakaru, jsluice, TruffleHog, GraphQL and domain extractors and private source artifacts is implemented. URL acquisition and cache reuse remain unavailable.',
  },
  servers: [
    {
      url: 'http://127.0.0.1:3000',
      description: 'Local development; use a private TLS reverse proxy for remote access',
    },
  ],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Analysis', description: 'Bounded analysis contract' },
    { name: 'Sources', description: 'Private source manifest and bounded reads' },
    { name: 'Operations', description: 'Service health' },
  ],
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Check service and metadata storage',
        tags: ['Operations'],
        'x-required-permissions': ['analysis:read'],
        responses: responses('HealthResponse', [401, 403, 500, 503]),
      },
    },
    '/analyze': {
      post: {
        operationId: 'analyze',
        summary: 'Analyze one script',
        tags: ['Analysis'],
        'x-required-permissions': ['analysis:write', 'analysis:read'],
        requestBody: { required: true, content: json('AnalyzeRequest') },
        responses: responses(
          'AnalyzeResponse',
          [400, 401, 403, 409, 413, 415, 422, 429, 500, 501, 502, 503, 504],
        ),
      },
    },
    '/source/{handle}': {
      get: {
        operationId: 'listModules',
        summary: 'List module metadata',
        tags: ['Sources'],
        'x-required-permissions': ['source:read'],
        parameters: [handle, ...query('SourceListQuery')],
        responses: responses('ManifestResponse', [400, 401, 403, 404, 410, 500, 503]),
      },
    },
    '/source/{handle}/{path}': {
      get: {
        operationId: 'readModule',
        summary: 'Read a bounded source fragment',
        tags: ['Sources'],
        'x-required-permissions': ['source:read'],
        parameters: [
          handle,
          param(
            'path',
            'path',
            ref('ModulePath'),
            'Logical path including slash-separated segments, e.g. original/bundle.js; treated as a wildcard route',
          ),
          ...query('SourceReadQuery'),
        ],
        responses: responses('SourceResponse', [400, 401, 403, 404, 410, 416, 422, 500, 503]),
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Opaque random token. Project and permissions are resolved server-side; not supplied by the request.',
      },
    },
    schemas: rewrite(
      Object.fromEntries(
        Object.entries(schema.$defs).filter(
          ([name]) =>
            ![
              'Permission',
              'SourceListQuery',
              'SourceReadQuery',
              'SourceParams',
              'ManifestParams',
            ].includes(name),
        ),
      ),
    ),
  },
};
for (const [name, content] of [
  ['src/generated.ts', types],
  ['openapi.json', `${JSON.stringify(document, null, 2)}\n`],
]) {
  const path = new URL(name, root);
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8').catch(() => '')) !== content)
      throw new Error(`Outdated generated file: ${fileURLToPath(path)}`);
  } else await writeFile(path, content);
}
console.log(
  process.argv.includes('--check')
    ? 'Contracts are up to date.'
    : 'Generated TypeScript and OpenAPI contracts.',
);
