---
title: Exploitation
description: Diagnostiquer une instance, purger les expirés et sauvegarder le stockage.
---

Le [démarrage rapide](/guides/quickstart/) couvre l’installation. Pour une instance existante :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

Réservez l’accès à Docker à l’opérateur. Pour un accès distant, placez l’API derrière un proxy TLS privé et désactivez la journalisation des corps de requête/réponse du proxy.

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
