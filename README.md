# JSMiner

Service privé d’analyse statique de JavaScript : endpoints, secrets potentiels, opérations GraphQL et sous-domaines. Les résultats sont compacts ; les sources se consultent séparément par `handle`.

## Démarrer

Avec pnpm **10.33.0** et Docker disponibles, depuis la racine :

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm worker:build
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

Le workspace sélectionne Node.js **24.21.0**. L’API écoute sur `127.0.0.1:3000`. Configuration et jeton sont dans `.local/` ; l’initialisation refuse d’écraser un répertoire existant.

## Documentation

- [Installation](docs/src/content/docs/guides/quickstart.md)
- [Exemples de requêtes](docs/src/content/docs/guides/analysis.md)
- [Configuration](docs/src/content/docs/reference/configuration.md)
- [API HTTP](docs/src/content/docs/reference/api.md) et [résultats](docs/src/content/docs/reference/results.md)
- [Exploitation](docs/src/content/docs/guides/operations.md) et [développement](docs/src/content/docs/guides/development.md)
- [Limitations et après v0.1](docs/src/content/docs/guides/limitations.md)

Le site a son propre workspace : `pnpm --dir docs install --frozen-lockfile`, puis `pnpm --dir docs dev`.

## Vérifier

`pnpm check` contrôle lint, contrats, compilation, types et tests locaux. `pnpm test:workers` ajoute les intégrations Docker. Le [banc de qualification](qualification/README.md) mesure qualité et ressources sur un corpus synthétique.
