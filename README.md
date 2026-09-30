# JSMiner

Service TypeScript d’analyse statique de JavaScript, avec résultats compacts et consultation ciblée des sources.

**Phase 4 : acquisition autorisée et cache disponibles.** Node.js 24.21.0, pnpm 10.33.0, Fastify et SQLite. `POST /analyze` accepte `content` ou une `url` autorisée côté serveur, enchaîne webcrack et Wakaru, puis applique jsluice, TruffleHog et les extracteurs GraphQL/domaines dans des conteneurs isolés. Les étapes réussies sont mises en cache par contenu, image immuable et profil de traitement ; chaque requête publie un nouveau handle. Les captures URL sont désactivées tant qu’aucune origine n’est configurée.

## Démarrer le service

Installer pnpm 10.33.0 et disposer d’un moteur Docker local, puis, depuis la racine :

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm worker:build
pnpm test:workers
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm dev
```

pnpm utilise le Node.js épinglé dans le workspace. Le serveur écoute par défaut sur `127.0.0.1:3000`. La configuration et le jeton créés dans `.local/` sont privés et ignorés par Git. L’initialisation refuse d’écraser ce répertoire.

Dans un autre terminal :

```sh
curl --fail -H "Authorization: Bearer $(cat .local/token)" http://127.0.0.1:3000/health
```

Réponse attendue : `{"status":"ok","phase":3,"storage":"ready"}`. Arrêter le service avec `Ctrl+C`.

Pour analyser un extrait fourni localement :

```sh
curl --fail -H "Authorization: Bearer $(cat .local/token)" \
  -H 'Content-Type: application/json' \
  --data '{"content":"fetch(\"/api/profile\");","tools":["jsluice"],"base_url":"https://example.test/"}' \
  http://127.0.0.1:3000/analyze
```

Le `handle` permet de lister `/source/<handle>` et de lire `/source/<handle>/original/bundle.js`. Omettre `tools` sélectionne webcrack, Wakaru, jsluice, TruffleHog et GraphQL ; les domaines sont ajoutés si `reference_domains` est renseigné. Une sélection explicite remplace ce profil. Les images absentes sont signalées `skipped / tool_unavailable`. La couverture décrit les détecteurs exécutés, pas une garantie d’exhaustivité.

## Organisation

| Chemin | Contenu |
| --- | --- |
| `apps/api` | Serveur HTTP, authentification, stockage privé et orchestration |
| `packages/contracts/schema.json` | Contrats canoniques JSON Schema 2020-12 |
| `packages/contracts/openapi.json` | OpenAPI 3.1.1 généré |
| `packages/contracts/src` | Types générés, validation et invariants UTF-8 |
| `packages/contracts/examples` | Exemples valides/invalides et vecteurs de hash |
| `packages/adapters` | Superviseur Docker et interfaces des adaptateurs |
| `workers/node` | webcrack, Wakaru, TruffleHog et extracteurs statiques, dépendances verrouillées |
| `workers/jsluice` | Worker statique Go, dépendances et image épinglées |
| `docs` | Site Astro/Starlight avec son workspace indépendant |

`pnpm contracts:generate` régénère les types et OpenAPI après modification du schéma. `pnpm check` contrôle Biome (lint, format et imports), leur synchronisation, OpenAPI, la compilation, les types et les tests. `pnpm build` compile les trois packages. `pnpm lint` vérifie le code ; `pnpm lint:fix` applique les corrections automatiques sûres et `pnpm format` reformate les fichiers.

## Documentation

```sh
cd docs
pnpm install --frozen-lockfile
pnpm dev
```

Compiler le site avec `pnpm build` depuis `docs/`.

- [Développement et configuration](docs/src/content/docs/guides/development.md)
- [Rapport de validation de phase 4](docs/src/content/docs/reference/phase-4-validation.md)
- [Rapport de validation de phase 3](docs/src/content/docs/reference/phase-3-validation.md)
- [Rapport de validation de phase 2](docs/src/content/docs/reference/phase-2-validation.md)
- [Rapport de validation de phase 1](docs/src/content/docs/reference/phase-1-validation.md)
- [Contrat API](docs/src/content/docs/reference/api.md)
- [Pipeline et isolation](docs/src/content/docs/architecture/pipeline.md)
- [Feuille de route](docs/src/content/docs/guides/roadmap.md)

J1, J2 et J3 sont validés. La convention Fingerprinter a été vérifiée sur son code : SHA-256 sans préfixe du corps CDP complet, après décodage éventuel du base64 (commit `32142b2`). Sa réutilisation est conditionnelle ; JSMiner conserve un hash du contenu intégral. Voir le rapport de validation.
