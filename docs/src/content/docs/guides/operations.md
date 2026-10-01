---
title: Exploitation
description: Diagnostiquer une instance, purger les expirés et sauvegarder le stockage.
---

Le [démarrage rapide](/guides/quickstart/) couvre l’installation. Pour une instance existante :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

Réservez l’accès à Docker à l’opérateur. Pour un accès distant, placez l’API derrière un proxy TLS privé et désactivez la journalisation des corps de requête/réponse du proxy.

Les jobs inachevés deviennent `interrupted` lors d’un arrêt ou d’un redémarrage ; les résultats déjà publiés sont conservés. Les limites de [file et de concurrence](/reference/configuration/#concurrence) s’appliquent à toute l’instance.

## Déploiement Docker

Les commandes de démarrage sont dans le [README du dépôt](https://github.com/JoshuaMart/JSMiner#run-with-docker). Trois images sont publiées pour Linux amd64 et arm64 après validation CI :

| Image GHCR | Rôle |
| --- | --- |
| `ghcr.io/joshuamart/jsminer` | API HTTP |
| `ghcr.io/joshuamart/jsminer-jsluice` | Extracteur jsluice en Go |
| `ghcr.io/joshuamart/jsminer-offline` | webcrack, Wakaru, TruffleHog, GraphQL et domaines |

Utilisez le même tag pour les trois images : `latest` suit `main`, les tags Git `v*` sont repris tels quels, et `sha-<sha-complet>` fixe un commit. Pour des packages privés, authentifiez-vous avec `docker login ghcr.io`.

L’API s’exécute sous `node`, avec le groupe du socket comme groupe principal. Le GID est lu dans le conteneur Linux ; un GID `0` ne rend pas l’utilisateur root. Les workers temporaires ne reçoivent ni réseau ni socket Docker.

Le port hôte `3001` pointe vers le port `3000` du conteneur. Le volume `jsminer-data` contient configuration, jeton, SQLite et artefacts sous `.local/`. Arrêtez avec `docker stop jsminer`, puis reprenez avec `docker start jsminer`.

Pour changer de version, modifiez `worker_image` et `offline_worker_image` dans `/data/.local/config.json`, téléchargez les trois images correspondantes et recréez le conteneur API avec le même volume.

### Récupérer un volume créé en root

Un démarrage avec `--user 0` peut laisser des fichiers privés appartenant à root et empêcher le retour à `node`. Arrêtez toutes les instances utilisant le volume et sauvegardez-le, puis restaurez le propriétaire de tout `/data` :

```sh
JSMINER_IMAGE=ghcr.io/joshuamart/jsminer:latest # adapter au tag de votre instance
docker stop jsminer
docker run --rm --user 0:0 --network none --read-only \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE \
  --security-opt=no-new-privileges \
  --mount type=volume,src=jsminer-data,dst=/data \
  "$JSMINER_IMAGE" chown -Rh node:node /data
docker rm jsminer
```

Recréez ensuite l’API avec la commande du README, sans réinitialiser le volume. Cette maintenance conserve les données et leurs permissions ; elle seule utilise root, sans monter le socket Docker.

## Vérifier et diagnostiquer

```sh
curl --fail-with-body -H "Authorization: Bearer $(cat .local/token)" http://127.0.0.1:3000/health
docker image inspect jsminer-jsluice:phase2 jsminer-offline:phase3
```

| Symptôme | Action |
| --- | --- |
| `EADDRINUSE` au démarrage | Choisir un port libre dans `config.json`, puis redémarrer |
| `401` / `403 forbidden` | Vérifier le jeton et ses permissions dans la configuration |
| `destination_denied` | Vérifier les adresses DNS (locales/privées bloquées) et, en mode `allowlist`, l’origine dans `capture.origins` |
| `scheduler_unavailable` | Vérifier l’espace disque et les erreurs SQLite, puis redémarrer ; les résultats publiés restent consultables |
| `script_hash_mismatch` | Comparer les octets soumis, BOM et fins de ligne compris |
| `429 analysis_capacity` | Attendre le délai `Retry-After` |
| `429 storage_full` | Purger les expirés et vérifier le quota ; les handles actifs sont conservés |
| `tool_unavailable` | Vérifier les images et reconstruire avec `pnpm worker:build` |
| `capture_*` | Vérifier statut, compression et disponibilité de la ressource autorisée |
| `worker_cleanup_unconfirmed` | Le message précise l’étape (`recovery_*` au premier contrôle, `cleanup_*` après un worker) et le motif : `timeout`, `spawn_error`, `command_failed`, `container_remaining` ou `creation_uncertain`. Résoudre le problème Docker puis redémarrer avec le même stockage |
| Erreur de stockage | Vérifier droits, espace disque et SQLite/WAL |

Les erreurs HTTP contiennent un `request_id`. Pour une réponse d’analyse, consultez `tools`, `coverage` et `truncation`. La [référence API](/reference/api/#erreurs-http) décrit les codes.

## Arrêter et purger

`Ctrl+C` ou `SIGTERM` annule le travail actif, attend son nettoyage et ferme le stockage. Une fois le service arrêté :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm storage:purge
```

La commande exige le build Node et un stockage existant. Elle prend le verrou du serveur, supprime les expirés et conserve les handles actifs. Ne supprimez jamais `.lease.sqlite` pour contourner ce verrou.

## Sauvegarder et dimensionner

Arrêtez le service avant de copier **SQLite et le répertoire d’artefacts ensemble**, `.key` comprise. La perte de cette clé change les empreintes et les curseurs. Sources, caches et sauvegardes peuvent contenir des secrets : conservez leurs accès privés.

Surveillez l’espace physique de l’hôte et de Docker en plus du quota logique : SQLite/WAL, images et journaux s’y ajoutent. Les plafonds et durées se règlent dans la [configuration](/reference/configuration/) ; le [stockage](/architecture/storage/) décrit l’éviction et l’expiration.

Après une mise à jour du moteur ou des workers, suivez la [qualification](/reference/qualification/).
