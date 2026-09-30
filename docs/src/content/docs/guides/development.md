---
title: Développement et configuration
description: Installer le socle Node.js, démarrer l’API privée et faire évoluer les contrats.
---

## Installation

Le workspace du service utilise **Node.js 24.21.0 et pnpm 10.33.0**. pnpm sélectionne le Node.js déclaré par `useNodeVersion` sans remplacer celui du système. `docs/` conserve son workspace et son lockfile indépendants.

Depuis la racine, avec pnpm 10.33.0 installé :

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm dev
```

`config:init` crée `.local/` en mode `0700`, puis `config.json` et `token` en mode `0600`. Le jeton contient 32 octets aléatoires encodés en base64url ; seule son empreinte SHA-256 est placée dans la configuration. Le jeton n’est pas affiché. Un répertoire existant n’est jamais écrasé.

```sh
curl --fail -H "Authorization: Bearer $(cat .local/token)" http://127.0.0.1:3000/health
```

`/health` répond `200` lorsque SQLite est utilisable. Les requêtes valides sur `/analyze` et `/source` répondent `501 not_implemented` pendant la phase 1. Les requêtes invalides sont déjà refusées. L’arrêt par `Ctrl+C` ferme HTTP et SQLite.

Après `pnpm build`, le démarrage compilé est :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

## Authentification et projets

La configuration est validée par `apps/api/config.schema.json`. `JSMINER_CONFIG` est obligatoire ; aucune identité anonyme ou clé par défaut n’est acceptée. Chaque requête fournit `Authorization: Bearer <jeton>`. Le projet et les droits viennent exclusivement de la configuration serveur ; `project_id` est interdit dans une demande d’analyse.

| Route | Droits nécessaires |
| --- | --- |
| `GET /health` | `analysis:read` |
| `POST /analyze` | `analysis:write` et `analysis:read` |
| Routes `/source` | `source:read` |

Chaque entrée de `tokens` contient `sha256` (64 caractères hexadécimaux minuscules), `project_id` et `permissions`. Un jeton appartient à un seul projet ; plusieurs jetons peuvent partager ce projet avec des droits différents. Les empreintes sont comparées avec `timingSafeEqual`. Retirer une entrée ou remplacer son empreinte, puis redémarrer, révoque le jeton. Il n’y a ni rechargement automatique ni API de gestion des identités.

L’identité du projet et les permissions de route sont testées. L’isolation des futurs handles et du cache sera validée en phases 2 et 4, lorsque ces ressources existeront.

## Configuration et budgets

`database` est un chemin relatif au fichier de configuration, ou un chemin absolu. Son répertoire parent doit exister et être privé. `:memory:` est réservé aux essais. Le socle utilise `node:sqlite`, le journal WAL et une migration versionnée idempotente ; seules les métadonnées de migration existent à ce stade.

`host` vaut `127.0.0.1` par défaut et peut devenir `0.0.0.0` pour un conteneur privé. `port` vaut `3000`. Les journaux HTTP sont désactivés ; le démarrage et les erreurs fatales produisent seulement des messages génériques.

Les clés facultatives de `budgets` reprennent les [budgets du pipeline](/architecture/pipeline/#budgets-proposés). Chaque valeur est un entier positif et peut uniquement réduire son plafond. Les valeurs manquantes reçoivent leurs valeurs par défaut. Une clé inconnue, des empreintes de jetons dupliquées ou des budgets incohérents font échouer le démarrage.

Les plafonds HTTP et les octets UTF-8 de `content` sont appliqués dès cette phase. Les budgets des workers, de capture, d’artefacts, de concurrence et de rétention sont **configurés mais pas encore exécutés**. Aucun worker ni mécanisme d’admission d’analyse n’existe en phase 1.

## Contrats et vérifications

`packages/contracts/schema.json` est la source canonique des structures JSON. `pnpm contracts:generate` produit OpenAPI 3.1.1 et les types TypeScript. `pnpm contracts:check` refuse un artefact généré périmé. Modifier directement les fichiers générés est inutile : ils seront remplacés.

JSON Schema contrôle les structures, types, enums et bornes. `validateContract` complète ces règles pour compter les octets UTF-8, refuser les caractères de substitution isolés et vérifier les relations entre statuts, couverture, preuves et références. OpenAPI seul ne peut pas exprimer ces contraintes transversales. Les exemples de la référence API sont également testés.

| Commande | Vérification |
| --- | --- |
| `pnpm check` | Biome, génération à jour, OpenAPI, compilation, types et tests |
| `pnpm lint` | Lint, format et ordre des imports ; avertissements refusés |
| `pnpm lint:fix` | Corrections automatiques sûres de Biome |
| `pnpm format` | Formatage automatique |
| `pnpm build` | Compilation des trois packages |
| `pnpm typecheck` | Types des trois packages |
| `pnpm test` | Tests sur le code compilé ; exécuter `pnpm build` avant |
| `docker build --platform linux/amd64 --target validate -t jsminer-phase1:validation .` | Installation verrouillée et vérifications sur Linux amd64 |

Biome **2.5.14** est épinglé avec le preset `recommended`. Sa [configuration](https://biomejs.dev/guides/configure-biome/) est dans `biome.json` : code, tests, scripts JavaScript et JSON du service sont contrôlés. Le workspace documentaire, les sorties compilées, les fichiers privés `.local/` et les dépendances sont exclus. Les types et OpenAPI générés restent contrôlés par `contracts:check`, sans reformatage par Biome. La CI et le Dockerfile exécutent `pnpm check`, donc le lint y est bloquant.

## Plateformes et déploiement

Le socle est vérifié sur macOS arm64 et sur Linux amd64 dans Docker, ce dernier étant émulé sur la machine de développement. Linux amd64, instance unique et stockage local privé, est la cible initiale. Windows, Linux arm64 et la performance native Linux ne sont pas qualifiés.

Le Dockerfile sert à qualifier le socle ; son étage `runtime` utilise un utilisateur non privilégié, mais conserve les dépendances de développement. Ce n’est pas encore une image d’exploitation du moteur. Les dépendances natives des futurs outils et leur isolation devront être qualifiées séparément. Tout accès distant passe par un proxy TLS privé ; ne transmettre les jetons en HTTP clair que sur la boucle locale.

Le [rapport de phase 1](/reference/phase-1-validation/) décrit les vérifications réalisées et les conditions de compatibilité avec le hash Fingerprinter.

La vérification amont est séparée de la CI Node.js et ne nécessite pas de navigateur : avec Python 3.12+, Go compatible avec le `go.mod` amont et les dépendances Go déjà en cache, exécuter `python3 scripts/verify-fingerprinter-hash.py /chemin/vers/Fingerprinter`. Le dépôt amont doit être propre ; le script exige le commit consigné dans les fixtures, le teste dans un répertoire temporaire et affiche le commit vérifié et ne modifie pas le dépôt original. Une nouvelle version doit être comparée au commit consigné dans les fixtures avant de mettre à jour la preuve.
