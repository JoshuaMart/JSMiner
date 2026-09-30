---
title: Installation
description: Installer les dépendances, créer une configuration et démarrer JSMiner.
---

## Prérequis

Un clone du dépôt, **pnpm 10.33.0**, Docker démarré et accessible au même utilisateur que le service, et `curl`. Le workspace sélectionne **Node.js 24.21.0**. L’API tourne sur l’hôte ; Docker exécute les workers.

## Installer et construire

Depuis la racine :

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm worker:build
pnpm config:init
```

`config:init` crée `.local/config.json` et le jeton `.local/token`, avec des droits privés. Il refuse un répertoire `.local/` existant : réutilisez votre configuration sans supprimer les données de l’instance.

## Démarrer l’API

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

Dans un autre terminal, depuis la même racine :

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $(cat .local/token)" \
  http://127.0.0.1:3000/health
```

Réponse attendue : `{"status":"ok","storage":"ready"}`. La santé contrôle le stockage et le superviseur, sans lancer de worker.

Arrêtez avec `Ctrl+C` ; redémarrez avec la même configuration pour conserver les données non expirées.

**Suite :** [envoyer une première analyse](/guides/analysis/). Pour modifier le port, les projets ou les origines autorisées, consultez la [configuration](/reference/configuration/).
