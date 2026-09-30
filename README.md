# JSMiner

Service TypeScript d’analyse statique de JavaScript, avec résultats compacts et consultation ciblée des sources.

**Phase 1 : socle et contrats disponibles.** Node.js 24.21.0, pnpm 10.33.0, Fastify et SQLite. L’authentification et la validation HTTP fonctionnent ; les routes d’analyse et de sources retournent encore `501 not_implemented`. Aucun outil d’analyse ni acquisition réseau n’est intégré.

## Démarrer le socle

Installer pnpm 10.33.0 puis, depuis la racine :

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm dev
```

pnpm utilise le Node.js épinglé dans le workspace. Le serveur écoute par défaut sur `127.0.0.1:3000`. La configuration et le jeton créés dans `.local/` sont privés et ignorés par Git. L’initialisation refuse d’écraser ce répertoire.

Dans un autre terminal :

```sh
curl --fail -H "Authorization: Bearer $(cat .local/token)" http://127.0.0.1:3000/health
```

Réponse attendue : `{"status":"ok","phase":1,"storage":"ready"}`. Arrêter le service avec `Ctrl+C`.

## Organisation

| Chemin | Contenu |
| --- | --- |
| `apps/api` | Serveur HTTP, authentification, configuration et essai SQLite |
| `packages/contracts/schema.json` | Contrats canoniques JSON Schema 2020-12 |
| `packages/contracts/openapi.json` | OpenAPI 3.1.1 généré |
| `packages/contracts/src` | Types générés, validation et invariants UTF-8 |
| `packages/contracts/examples` | Exemples valides/invalides et vecteurs de hash |
| `packages/adapters` | Interfaces des futurs adaptateurs isolés |
| `docs` | Site Astro/Starlight avec son workspace indépendant |

`pnpm contracts:generate` régénère les types et OpenAPI après modification du schéma. `pnpm check` contrôle leur synchronisation, OpenAPI, la compilation, les types et les tests. `pnpm build` compile les trois packages.

## Documentation

```sh
cd docs
pnpm install --frozen-lockfile
pnpm dev
```

Compiler le site avec `pnpm build` depuis `docs/`.

- [Développement et configuration](docs/src/content/docs/guides/development.md)
- [Rapport de validation de phase 1](docs/src/content/docs/reference/phase-1-validation.md)
- [Contrat API](docs/src/content/docs/reference/api.md)
- [Pipeline et isolation](docs/src/content/docs/architecture/pipeline.md)
- [Feuille de route](docs/src/content/docs/guides/roadmap.md)

J1 est validé. La convention Fingerprinter a été vérifiée sur son code : SHA-256 sans préfixe du corps CDP complet, après décodage éventuel du base64 (commit `32142b2`). Sa réutilisation est conditionnelle ; JSMiner conserve un hash du contenu intégral. Voir le rapport de validation.
