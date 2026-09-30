---
title: Développement
description: Organisation du code, contrats et commandes de contribution.
---

Après l’[installation](/guides/quickstart/), lancez l’API avec rechargement :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm dev
```

Cette commande compile les packages partagés avant de démarrer `--watch`. Relancez-la après leur modification.

## Organisation

| Chemin | Responsabilité |
| --- | --- |
| `apps/api` | HTTP, authentification, capture, orchestration et stockage |
| `packages/contracts` | Schéma canonique, invariants, types et OpenAPI générés |
| `packages/adapters` | Interfaces et supervision Docker |
| `workers` | Outils isolés et dépendances verrouillées |
| `qualification` | Corpus, seuils, banc et rapports |
| `scripts` | Initialisation, purge et compatibilité Fingerprinter |
| `docs/src/content/docs` | Pages publiées |

## Contrats

Modifiez `packages/contracts/schema.json`, puis exécutez `pnpm contracts:generate`. Ne modifiez pas directement les types et OpenAPI générés. `validateContract` ajoute les invariants UTF-8 et les relations entre statuts, couverture et preuves.

Les exemples JSON de la référence API sont testés : mettez-les à jour avec les fixtures lorsqu’un contrat évolue.

## Commandes

| Commande | Usage |
| --- | --- |
| `pnpm check` | Biome, génération à jour, OpenAPI, build, types et tests |
| `pnpm lint` / `pnpm lint:fix` | Contrôle / corrections automatiques sûres |
| `pnpm format` | Formatage |
| `pnpm build` / `pnpm typecheck` | Compilation / vérification des types |
| `pnpm test` | Tests sur le dernier build |
| `pnpm worker:build` | Construction des images |
| `pnpm test:workers` | Intégrations Docker avec ces images |
| `pnpm test:qualification` | Tests du banc, sans Docker |

Biome est configuré dans `biome.json`. La CI exécute `pnpm check` ; le workspace documentaire est indépendant.

## Workers

Gardez cohérents versions, étiquettes d’images, protocoles et constantes des adaptateurs. Après modification : `pnpm build`, `pnpm worker:build`, puis `pnpm test:workers`.

Une image reconstruite change son identité de cache. Une modification de normalisation côté service exige aussi de revoir sa version dans la clé de cache.

## Qualification

La [procédure de qualification](/reference/qualification/) décrit les mesures complètes. Pour le socle Linux amd64 :

```sh
docker build --platform linux/amd64 --target validate -t jsminer:validation .
```

La compatibilité Fingerprinter est vérifiée séparément, avec Python 3.12+, le Go requis par son dépôt et ses dépendances déjà en cache :

```sh
python3 scripts/verify-fingerprinter-hash.py /chemin/vers/Fingerprinter
```

Le script exige le commit des fixtures et travaille sur une copie temporaire, sans navigateur. La CI Node ne suit pas automatiquement les versions amont.

## Documentation

```sh
pnpm --dir docs install --frozen-lockfile
pnpm --dir docs build
```

Prévisualisation : `pnpm --dir docs dev`. Éditez la navigation dans `docs/astro.config.mjs`. Décrivez l’usage actuel ; placez les évolutions dans [limitations et après v0.1](/guides/limitations/).
