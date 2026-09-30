---
title: Outils intégrés
description: Rôles, versions épinglées et images des workers.
---

| Identifiant | Version embarquée | Rôle |
| --- | --- | --- |
| `webcrack` | 2.16.0 | Désobfuscation, déminification, dépliage |
| `wakaru` | 1.12.0 | Reconstruction de syntaxe, dépliage |
| `jsluice` | Commit `0ddfab153e060a9eeaded4d8669233f7c071e7e4` | Endpoints et secrets potentiels |
| `trufflehog` | 3.97.9 | Secrets potentiels, sans vérification réseau |
| `graphql` | Interne, Babel 7.29.9 et GraphQL 17.0.2 | Opérations GraphQL statiques |
| `domains` | Interne | Sous-domaines observés |

webcrack et Wakaru ont des capacités complémentaires et communes. Leur [enchaînement](/architecture/pipeline/#transformations-et-extraction) conserve l’original pour l’extraction. Aucun gain de détection n’est garanti pour chaque script.

## Images et versions

`pnpm worker:build` construit les images locales :

| Image par défaut | Contenu | Protocole |
| --- | --- | --- |
| `jsminer-jsluice:phase2` | Worker Go et jsluice | 3 |
| `jsminer-offline:phase3` | Node.js et les cinq autres outils | 1 |

Ces tags gardent leur nom historique. Le superviseur contrôle l’ID immuable, le protocole et la version ; une image absente ou incompatible produit `tool_unavailable`. La version composite Node est `webcrack2.16.0-wakaru1.12.0-trufflehog3.97.9-static4`.

Le worker jsluice utilise la grammaire de `go-tree-sitter` au commit `dd81d9e9be82` (août 2024), avec des tests de syntaxe modernes. Son identifiant de build inclut cette version du parseur.

Les dépendances sont verrouillées par `package-lock.json` côté Node et `go.mod`/`go.sum` côté Go ; les archives TruffleHog sont vérifiées par SHA-256. Une reconstruction change l’identité de cache correspondante.

Projets amont : [webcrack](https://github.com/j4k0xb/webcrack), [Wakaru](https://github.com/pionxzh/wakaru), [jsluice](https://github.com/BishopFox/jsluice), [TruffleHog](https://github.com/trufflesecurity/trufflehog).
