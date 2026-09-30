---
title: Exploitation du service
description: Démarrer, diagnostiquer, arrêter et purger une instance privée de JSMiner.
---

## Installer et démarrer

Prévoir Node.js 24.21.0 via pnpm 10.33.0, un moteur Docker accessible et un répertoire privé pour la configuration et les données. Le moteur Docker est une dépendance de l’hôte ; le Dockerfile racine qualifie le socle et ne déploie pas à lui seul le service complet.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm worker:build
pnpm build
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

`config:init` refuse tout écrasement. `.local/token` est un secret, `.local/config.json` contient son empreinte et les droits du projet. Conserver `.local/` en `0700` et ses fichiers en `0600`. Le serveur écoute sur `127.0.0.1:3000` par défaut. Un accès distant nécessite un proxy TLS privé ; l’accès au socket Docker reste réservé à l’opérateur.

Les captures URL sont refusées jusqu’à configuration de `capture.origins`. La liste est commune aux projets de l’instance. Autoriser uniquement les origines nécessaires ; la dérogation `allow_private` inclut les réseaux internes et link-local. Voir le [guide de configuration](/guides/development/#acquisition-url-et-cache).

## Vérifier et diagnostiquer

```sh
curl --fail -H "Authorization: Bearer $(cat .local/token)" http://127.0.0.1:3000/health
docker image inspect jsminer-jsluice:phase2 jsminer-offline:phase3
```

`/health` vérifie SQLite et l’état du superviseur ; il ne lance pas de worker et ne prouve pas que Docker répond. Une analyse dont les outils sont `skipped / tool_unavailable` nécessite de vérifier ou reconstruire les images avec `pnpm worker:build`. Les versions/protocoles doivent correspondre au code du service ; changer seulement un tag n’actualise pas le contenu d’une image.

| Symptôme | Action opérateur |
| --- | --- |
| `401` / `403 forbidden` | Vérifier le jeton, le projet et les permissions de la route |
| `403 destination_denied` | Vérifier l’origine exacte et sa politique d’adresses ; une redirection n’est jamais suivie |
| `409 script_hash_mismatch` | Vérifier que le hash porte sur les octets complets réellement soumis, BOM et fins de ligne compris |
| `429 analysis_capacity` | Attendre la fin de l’analyse/du nettoyage actif ; respecter `Retry-After` |
| `429 storage_full` | Attendre l’expiration des handles, purger les expirés service arrêté et vérifier le quota ; les handles actifs ne sont pas sacrifiés |
| `502 capture_*` / `504 capture_timeout` | Contrôler la ressource autorisée, son statut, sa compression et les délais sans exposer son URL sensible dans les logs |
| `worker_cleanup_unconfirmed` ou santé indisponible | Vérifier Docker, arrêter puis redémarrer avec le même stockage pour récupérer les conteneurs portant son étiquette propriétaire |
| Erreur de stockage | Vérifier droits, espace physique et SQLite/WAL, séparément du quota logique |

Les journaux du service sont volontairement succincts et ne contiennent pas les scripts, secrets ni sorties brutes. Utiliser `request_id`, les codes d’erreur, `tools`, `coverage` et `truncation` pour diagnostiquer. Un résultat `partial` est exploitable avec sa provenance ; il ne garantit pas une couverture complète. Ne pas ajouter les corps de requête/réponse aux journaux du proxy.

## Arrêter et purger

Arrêter le processus avec `Ctrl+C` ou `SIGTERM`. Le service annule l’acquisition/l’analyse active, attend la fermeture réseau et le nettoyage du worker, puis ferme HTTP et SQLite. Une suppression manuelle du verrou `.lease.sqlite` pendant l’exécution peut casser l’exclusivité : conserver ce fichier, même service arrêté.

La purge des expirés est automatique au démarrage, lors des admissions et périodiquement. Pour la déclencher hors ligne après arrêt :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm storage:purge
```

La commande exige les fichiers compilés (`pnpm build`). Elle prend le même verrou exclusif que le serveur et refuse de fonctionner si une instance possède déjà le stockage. Elle conserve les handles actifs, supprime les sources et caches expirés, puis garde les tombstones privés pendant 24 heures. Elle n’expose pas d’option de suppression forcée des handles actifs.

## Sauvegarder et dimensionner

Arrêter le service avant une copie cohérente de SQLite et de son répertoire d’artefacts. Conserver `.key` avec les données : elle stabilise les HMAC par projet et les curseurs. Les fichiers sources et les caches bruts peuvent contenir des secrets, même si les réponses d’analyse sont masquées. Restreindre également les sauvegardes.

L’instance admet une analyse à la fois. Le quota logique par défaut est de 1 Gio, dont au plus 256 Mio de cache. Il compte les artefacts, réponses et marges de métadonnées ; la taille physique de SQLite/WAL, des images et du stockage Docker s’ajoute. La réservation protège le handle en cours et l’éviction ne supprime que les copies du cache. Surveiller séparément l’espace libre de l’hôte et de Docker.

La rétention est fixe : 24 h par défaut pour handles et caches, sans prolongation à la lecture. Les budgets peuvent être abaissés, pas dépassés. Toute modification des règles, des versions ou des options embarquées nécessite une reconstruction des images et invalide les caches concernés.

## Requalifier après changement

```sh
pnpm check
pnpm worker:build
pnpm test:workers
pnpm qualify:build
pnpm qualify
pnpm qualify:stress
pnpm qualify:clean
```

Le corpus de qualification est synthétique et local. Exécuter les mesures sans autre charge Docker de test en parallèle, puis conserver le rapport avec les versions, hashes et limites de couverture. Voir le [rapport de phase 5](/reference/phase-5-validation/).
