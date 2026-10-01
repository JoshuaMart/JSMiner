---
title: Configuration du serveur
description: Paramètres, jetons, origines autorisées et budgets.
---

`JSMINER_CONFIG` désigne le fichier JSON lu au démarrage. `pnpm config:init` crée une configuration locale. Le schéma canonique est `apps/api/config.schema.json` : champs inconnus, types incorrects et empreintes dupliquées sont refusés. Toute modification nécessite un redémarrage.

## Paramètres généraux

| Clé | Défaut | Règle |
| --- | --- | --- |
| `database` | Obligatoire | Chemin SQLite ; le répertoire parent doit exister |
| `tokens` | Obligatoire | De 1 à 100 entrées d’authentification |
| `host` | `127.0.0.1` | `127.0.0.1` ou `0.0.0.0` |
| `port` | `3000` | Entier de 1 à 65535 |
| `artifact_directory` | `<database>.artifacts` | Répertoire privé des sources, caches, clé et verrou |
| `worker_image` | `jsminer-jsluice:phase2` | Image locale du worker jsluice |
| `offline_worker_image` | `jsminer-offline:phase3` | Image locale des cinq autres outils |


Les chemins relatifs partent du **répertoire du fichier de configuration**. Le mode `:memory:` est réservé aux essais ; sans répertoire d’artefacts explicite, ses sources sont temporaires.

## Jetons, projets et droits

`tokens` contient de 1 à 100 entrées :

| Champ | Valeur |
| --- | --- |
| `sha256` | Empreinte du jeton, 64 hexadécimaux minuscules |
| `project_id` | 1 à 128 caractères parmi lettres ASCII, chiffres, `_` et `-` |
| `permissions` | Liste non vide et sans doublon parmi `analysis:read`, `analysis:write`, `source:read` |

Le client transmet le jeton original ; le projet est déterminé par cette configuration. Plusieurs jetons peuvent partager un projet. Supprimez une entrée et redémarrez pour la révoquer. Les [droits requis par route](/reference/api/#conventions) figurent dans l’API.

## Capture URL

`capture.mode` vaut `public` par défaut : les clients authentifiés peuvent soumettre une URL HTTP(S) publique sans déclarer son origine. Les adresses locales, privées et link-local restent bloquées.

Pour limiter la capture à certaines origines, choisissez `allowlist` (une liste vide refuse tout) :

```json
{
  "capture": {
    "mode": "allowlist",
    "origins": [{ "origin": "https://assets.example.com", "allow_private": false }],
    "wire_bytes": 10485760
  }
}
```

Pour compatibilité, une liste `origins` non vide sans `mode` conserve le comportement `allowlist`. Un `mode: "public"` explicite accepte les autres origines publiques.

Une origine est un schéma HTTP(S), un hôte et un port éventuel, sans chemin, query, identifiants ni wildcard. Le slash final est accepté ; doublons normalisés refusés. La liste comprend au plus 100 origines et s’applique à tous les projets.

`allow_private: true` ajoute une exception pour les adresses non publiques de cette origine exacte, dans les deux modes. Ce paramètre vaut `false` par défaut. La résolution DNS et la destination utilisée restent contrôlées. La capture ne suit pas les redirections et ne transmet pas le jeton du client.

`wire_bytes` limite le corps avant décompression à 10 Mio par défaut et au maximum ; `budgets.script_bytes` borne le contenu décompressé.

## Cache

| Clé dans `cache` | Défaut | Bornes |
| --- | --- | --- |
| `enabled` | `true` | Booléen |
| `retention_ms` | `86400000` (24 h) | De 1 à 86 400 000 ms |
| `max_bytes` | `268435456` (256 Mio) | De 0 à 1 Gio, dans le quota global disponible |

Le cache n’ajoute pas de capacité à `budgets.storage_bytes`. Avec `enabled: false`, les outils sont exécutés à nouveau. Voir les [règles de réutilisation](/architecture/storage/#cache-des-traitements).

## Budgets

Les valeurs sont des entiers positifs. Les maximums différents du défaut sont indiqués dans le tableau. Contraintes : `source_read_bytes ≥ 4`, `script_bytes ≤ http_body_bytes`, `artifact_bytes ≤ storage_bytes`. Un Kio vaut 1 024 octets, un Mio 1 048 576 octets.

| Clé de `budgets` | Défaut (maximum si différent) | Effet |
| --- | ---: | --- |
| `http_body_bytes` | `67108864` | Corps JSON HTTP, avant décodage de `content` |
| `script_bytes` | `10485760` | Script UTF-8 après décodage ou décompression |
| `capture_ms` | `12000` | Acquisition URL, incluse dans le délai global |
| `analysis_ms` | `90000` | Travail global, acquisition et publication incluses |
| `cleanup_ms` | `10000` | Arrêt et vérification du nettoyage, budget distinct |
| `worker_memory_bytes` | `2147483648` (max. `8589934592`) | Mémoire par conteneur : 2 Gio par défaut, jusqu’à 8 Gio |
| `finding_count` | `200` (max. `2000`) | Observations par catégorie, par extraction et dans la réponse fusionnée |
| `worker_cpus` | `2` | CPU par conteneur |
| `worker_pids` | `128` | Processus par conteneur |
| `artifact_bytes` | `67108864` | Sources conservées par analyse |
| `module_count` | `2000` | Modules conservés par analyse |
| `response_bytes` | `262144` | JSON d’analyse sérialisé |
| `source_read_bytes` | `65536` | Octets source par lecture |
| `active_analyses` | `1` (max. `8`) | Analyses admises simultanément, requêtes synchrones et jobs confondus |
| `active_workers` | `2` (max. `8`) | Plafond global de workers, nettoyage compris |
| `total_worker_memory_bytes` | `4294967296` (max. `68719476736`) | Enveloppe de mémoire réservée aux workers simultanés |
| `storage_bytes` | `1073741824` | Quota logique global, sources et cache compris |
| `retention_ms` | `86400000` | Durée de vie fixe des handles après publication |


Délais dans `budgets.tool_ms` :

| Outil | Défaut et maximum |
| --- | ---: |
| `webcrack` | `25000` ms |
| `wakaru` | `25000` ms |
| `jsluice` | `15000` ms |
| `trufflehog` | `15000` ms |
| `graphql` | `5000` ms |
| `domains` | `3000` ms |


Le budget d’un extracteur couvre le lot de modules absents du cache, dans un seul conteneur ; le délai global prévaut. Les outils d’un même script restent séquentiels.

Le tas JavaScript des workers Node est réglé à environ 70 % du budget du conteneur, avec une réserve pour les autres allocations et `/tmp`. Un épuisement mémoire identifié produit `memory_limit` ; augmenter le budget ne garantit pas qu’un script complexe terminera dans le délai.

`finding_count` s’applique avant dédoublonnage et filtres : une réponse peut contenir moins de résultats tout en signalant une troncature. Les limites de sortie des workers (2 Mio) et de réponse HTTP restent applicables.

Ajoutez uniquement les valeurs à changer :

```json
{
  "budgets": {
    "finding_count": 1000,
    "worker_memory_bytes": 2147483648,
    "analysis_ms": 60000,
    "tool_ms": { "trufflehog": 10000 }
  }
}
```

Les champs omis gardent leurs défauts. Le [guide d’exploitation](/guides/operations/) traite l’espace physique, la purge et les sauvegardes.

## Concurrence

La capacité effective est `min(active_analyses, active_workers, floor(total_worker_memory_bytes / worker_memory_bytes))`. Une place reste réservée jusqu’au nettoyage ; captures et accès au cache occupent aussi leur place. Par défaut, une analyse tourne à la fois. Pour en autoriser deux :

```json
{
  "budgets": {
    "active_analyses": 2,
    "active_workers": 2,
    "worker_memory_bytes": 2147483648,
    "total_worker_memory_bytes": 4294967296
  }
}
```

Les 4 Gio de cet exemple couvrent les conteneurs, **pas** l’API, Docker, le cache système ou les autres applications. Dimensionnez la mémoire de l’hôte ou de la VM Docker en conséquence. JSMiner réserve les plafonds configurés ; il ne mesure pas la mémoire libre de Docker pour augmenter automatiquement sa capacité. `total_worker_memory_bytes` doit être au moins égal à `worker_memory_bytes`.

## File de jobs

| Clé dans `jobs` | Défaut | Maximum |
| --- | ---: | ---: |
| `max_jobs` | `128` | `10000` |
| `max_bytes` | `134217728` (128 Mio) | 1 Gio |
| `retention_ms` | `86400000` (24 h) | 7 jours |
| `max_budget_ms` | `300000` (5 min) | 1 heure |

`max_jobs` compte les jobs non expirés, y compris ceux terminés. `max_bytes` borne les entrées en attente et une réservation de métadonnées (8 Kio par job, 512 octets par item). Ce quota SQLite est distinct de `storage_bytes` ; il ne représente pas l’espace physique exact du journal WAL. Les contenus sont retirés de la file lorsqu’ils démarrent ou deviennent terminaux. Une seule soumission de lot peut recevoir son corps HTTP à la fois.

La rétention part de l’acceptation et doit couvrir `max_budget_ms + cleanup_ms`. Les jobs et résultats terminés restent consultables après redémarrage ; le travail inachevé est marqué `interrupted`, sans reprise automatique. Le mode `:memory:` ne conserve rien après arrêt.
