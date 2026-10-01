---
title: Référence API
description: Champs, réponses, statuts et erreurs du protocole HTTP v0.1.
---

Pour les commandes prêtes à utiliser, voir les [exemples de requêtes](/guides/analysis/). Cette page définit le contrat ; `packages/contracts/schema.json` et son validateur sont les sources canoniques, `openapi.json` est généré.

## Conventions

JSON UTF-8, champs `snake_case`, dates UTC RFC 3339. Les champs inconnus sont refusés en entrée. Les réponses d’analyse annoncent `schema_version: "0.1"` ; les clients doivent tolérer de nouveaux champs de réponse.

Toutes les routes exigent `Authorization: Bearer <jeton>`. Le projet est déterminé par la [configuration serveur](/reference/configuration/#jetons-projets-et-droits).

| Route | Permissions |
| --- | --- |
| `GET /health` | `analysis:read` |
| `POST /analyze` | `analysis:write` et `analysis:read` |
| `POST /jobs`, `DELETE /jobs/:id` | `analysis:write` et `analysis:read` |
| `GET /jobs/:id`, `GET /jobs/:id/items/:index` | `analysis:read` |
| Routes `/source` | `source:read` |

## GET /health

Retourne `{"status":"ok","storage":"ready"}` si SQLite et le superviseur sont disponibles. Ce contrôle ne lance pas de worker.

## POST /analyze

Analyse synchrone d’un script. Prévoir jusqu’à 90 s de travail et 10 s de nettoyage par défaut, plus la marge réseau. Pour plusieurs scripts, utiliser les [jobs](#jobs-asynchrones).

### Entrée

Fournir exactement un champ parmi `url` et `content`. Les autres champs sont facultatifs. Corps JSON non compressé, limité à 64 Mio.

| Champ | Type | Règle / défaut |
| --- | --- | --- |
| `url` | string | URL HTTP(S), 4 096 caractères maximum ; [destinations publiques](/reference/configuration/#capture-url) par défaut |
| `content` | string | Script non vide, 10 Mio UTF-8 maximum |
| `tools` | string[] | Liste non vide d’[identifiants connus](/reference/tools/), sans doublons ; remplace le profil par défaut |
| `script_hash` | string | Hash attendu : `sha256:` + 64 hexadécimaux minuscules ; vérifié avant le cache ([Fingerprinter](/architecture/storage/#compatibilité-fingerprinter)) |
| `base_url` | string | URL HTTP(S) du document, 4 096 caractères maximum ; résout les chemins et sert de référence aux filtres, sans requête réseau |
| `redact_query_values` | boolean | `false` ; `true` remplace toutes les valeurs query par `REDACTED`. Les secrets détectés restent toujours masqués |
| `min_confidence` | string | Seuil inclusif : `low` (défaut), `medium`, `high` ; s’applique aux quatre catégories |
| `endpoint_scope` | string | `all` (défaut), `same_fqdn`, `same_domain` ; endpoints uniquement |
| `exclude_extensions` | string[] | `[]` ; extensions exclues des endpoints, 100 entrées maximum de 32 caractères |
| `reference_domains` | string[] | Au plus 20 racines DNS ASCII sans wildcard ; obligatoire avec `domains` (`422` sinon) |

Sans `tools` : `webcrack`, `wakaru`, `jsluice`, `trufflehog`, `graphql`, plus `domains` si des racines sont fournies. L’ordre d’exécution suit le [pipeline](/architecture/pipeline/), pas la liste. Des transformateurs seuls sont acceptés ; les catégories sont alors `not_requested`.

<details>
<summary>Résolution des URL et règles de filtrage</summary>

- `base_url` n’est pas déduite de `url` : sans elle, les chemins relatifs restent non résolus.
- La portée compare les hôtes (`same_fqdn`, sans schéma ni port) ou les domaines enregistrables (`same_domain`, suffixes publics et privés via [tldts](https://github.com/remusao/tldts)). Référence : `base_url`, sinon `url`. Avec `content`, une portée restreinte exige `base_url` (`400` sinon). IP et hôtes sans domaine enregistrable sont comparés exactement ; destinations indéterminables exclues.
- Les extensions (`css`, `.PNG`, `js.map`) sont comparées sans casse sur la fin du nom de fichier décodé, sans query ni fragment.
- Les filtres ne modifient pas les sources et leurs exclusions ne sont pas des troncatures. Le masquage des secrets détectés reste actif même si leur observation est exclue par le seuil de confiance.

</details>

### Statuts et couverture

HTTP `200` signifie qu’un résultat avec handle a été publié, même si l’analyse a échoué. Les erreurs d’acquisition ou d’infrastructure utilisent les [erreurs HTTP](#erreurs-http).

| Champ | Valeurs / sens |
| --- | --- |
| `status` | `complete` : sans perte ; `partial` : exploitable avec erreur ou limite ; `failed` : aucun traitement exploitable |
| `coverage[category]` | `complete`, `partial`, `failed`, `not_requested` ; porte sur les détecteurs sélectionnés |
| `cache.status` | `hit` : tous les outils entièrement réutilisés ; `partial_hit` : certains ; `miss` : aucun |
| `warnings` | Objets `{ code, tool }` ; `tool: null` pour un avertissement global |

Une extraction vide réussie est `complete`, sans garantie d’exhaustivité. Une transformation échouée dégrade au plus la couverture en `partial`. Pour les secrets, un détecteur réussi et un échoué donnent `partial` ; deux échecs sans résultat donnent `failed`.

<details>
<summary>Détails par outil : tools[]</summary>

Chaque outil demandé a une entrée, même s’il n’a pas démarré.

| Champ | Sens |
| --- | --- |
| `status` | `success`, `partial`, `timeout`, `error`, `skipped` |
| `error_code` | Code stable ou `null` ; voir les [outils](/reference/tools/) et le [pipeline](/architecture/pipeline/) |
| `version` | Version/build exact, ou `null` si indisponible |
| `duration_ms` | Travail de la requête courante ; `0` si entièrement réutilisé, hors lecture/vérification du cache |
| `modules_analyzed` / `modules_available` | Modules analysés/proposés ; `null` pour les transformateurs |
| `input_path` | Entrée du transformateur dans le manifeste ; absent pour les extracteurs |
| `cache_hit` | `true` seulement si toutes les entrées sont réutilisées ; une réutilisation partielle peut rester comptée comme `miss` |

Un traitement en cache garde `success`. `memory_limit` indique un épuisement mémoire ; `unpack_failed`, un bundle Wakaru conservé malgré l’échec du dépliage.

</details>

### Réponse bornée

Plafonds : **256 Kio**, **200 observations par catégorie** par défaut, **5 preuves par observation**, **32 avertissements**, **2 048 octets par champ de découverte**. Les [budgets serveur](/reference/configuration/#budgets) permettent notamment de régler `finding_count` de 1 à 2 000.

Les observations sont triées par confiance décroissante puis identifiant ; les catégories sont remplies par tours. Toute perte rend la réponse et la couverture concernée `partial`, avec `truncation.truncated: true` et un motif : `response_bytes`, `finding_count`, `evidence_count`, `artifact_bytes`, `module_count`, `field_bytes`.

Les champs trop longs sont omis, sans pagination des observations perdues. La réponse ne contient ni source, ni contexte brut, ni secret en clair. Voir le [modèle de résultats](/reference/results/).

<details>
<summary>Exemple JSON complet : requête et réponse</summary>

**Requête**

```json
{
  "content": "fetch(\"/api/profile\");",
  "tools": ["jsluice"],
  "base_url": "https://app.example.com/dashboard"
}
```

**Réponse HTTP 200**

Les versions, durées et identifiants sont illustratifs ; le hash correspond à la requête ci-dessus.

```json
{
  "schema_version": "0.1",
  "handle": "ana_example_01",
  "status": "complete",
  "script_hash": "sha256:4e9f0ba12af4dcdfe6ac3d9213717c3e3e9dee807889e783cb57b0f6d65e38be",
  "expires_at": "2026-10-01T10:00:00Z",
  "cache": { "status": "miss" },
  "endpoints": [
    {
      "id": "ep_example_01",
      "value": "/api/profile",
      "resolved_url": "https://app.example.com/api/profile",
      "method": "GET",
      "kind": "http_call",
      "dynamic": false,
      "query_params": [],
      "body_params": [],
      "confidence": "high",
      "evidence": [
        {
          "tool": "jsluice",
          "module_path": "original/bundle.js",
          "representation": "original",
          "location": null
        }
      ]
    }
  ],
  "secrets": [],
  "gql_operations": [],
  "subdomains": [],
  "coverage": {
    "endpoints": "complete",
    "secrets": "complete",
    "gql_operations": "not_requested",
    "subdomains": "not_requested"
  },
  "tools": [
    {
      "name": "jsluice",
      "version": "example-build",
      "status": "success",
      "duration_ms": 40,
      "cache_hit": false,
      "modules_analyzed": 1,
      "modules_available": 1,
      "error_code": null
    }
  ],
  "truncation": { "truncated": false, "reasons": [] },
  "warnings": []
}
```

</details>

## Jobs asynchrones

| Route | Réponse |
| --- | --- |
| `POST /jobs` | `202` : état initial, en-tête `Location: /jobs/:id` |
| `GET /jobs/:id` | État du lot et de ses scripts, sans observations ni code |
| `GET /jobs/:id/items/:index` | Résultat au format `POST /analyze` dès sa publication ; index à partir de zéro |
| `DELETE /jobs/:id` | Annule le travail restant, conserve les résultats publiés |

### Soumission et délai

| Champ | Règle |
| --- | --- |
| `items` | 1 à 50 objets au format `POST /analyze`, chacun avec ses options et son handle ; limite HTTP de 64 Mio pour le lot entier |
| `budget_ms` | Défaut : le minimum entre 90 000 et `jobs.max_budget_ms` ; maximum : ce plafond serveur (300 000 par défaut) |

Les entrées sont validées avant acceptation ; les erreurs de capture ou de traitement restent ensuite propres à chaque script. Chaque `POST` crée un nouveau job, sans clé d’idempotence.

Le budget commence à l’acceptation, **attente en file comprise**. Chaque analyse reçoit au plus le temps restant et son plafond `analysis_ms`. Le nettoyage peut dépasser l’échéance ; l’état terminal attend le retour des analyses actives.

### Suivi

Le job expose `id`, `status`, `created_at`, `deadline_at`, `expires_at`, `items`. Chaque item contient `index`, `status`, `handle` et `error_code` (ces deux derniers peuvent être `null`).

| Statut du job | Sens |
| --- | --- |
| `queued` → `running` | En attente, puis en cours |
| `completed` | Tous les items sont terminaux, sans garantir leur réussite |
| `timed_out` | Budget épuisé |
| `cancelling` → `cancelled` | Annulation demandée, puis traitements actifs terminés |
| `interrupted` | Arrêt ou redémarrage, sans reprise automatique |

Les items passent de `queued` à `running`, puis à `complete`, `partial` ou `failed`. Un item `failed` sans handle n’a aucun résultat publié : consulter `error_code`. `skipped` signifie qu’il n’a pas démarré (délai, annulation, arrêt ou indisponibilité).

La déconnexion HTTP n’annule pas le job. Les handles ont leur propre rétention et peuvent expirer avant lui. Un job expiré répond `410` pendant 24 h, puis `404`.

En cas de `scheduler_unavailable`, le suivi des jobs inachevés et leurs résultats indisponibles renvoient `503` ; les résultats déjà publiés restent lisibles. Un nettoyage non confirmé apparaît dans `error_code` et rend le service indisponible.

Voir les [exemples de soumission et de suivi](/guides/analysis/#soumettre-un-lot), les [quotas et la concurrence](/reference/configuration/#concurrence), et les [erreurs HTTP](#erreurs-http).

## GET /source/:handle

Manifeste sans code. `limit` : 1 à 100, défaut 50 ; `cursor` : opaque, facultatif, lié au handle et à l’ordre des chemins. `next_cursor: null` marque la fin.

```json
{
  "handle": "ana_example_01",
  "expires_at": "2026-10-01T10:00:00Z",
  "modules": [
    {
      "path": "original/bundle.js",
      "origin": "original",
      "parent_path": null,
      "bytes": 22,
      "lines": 1,
      "hash": "sha256:4e9f0ba12af4dcdfe6ac3d9213717c3e3e9dee807889e783cb57b0f6d65e38be"
    }
  ],
  "total_modules": 1,
  "next_cursor": null
}
```

`origin` vaut `original`, `webcrack` ou `wakaru`. `parent_path` désigne l’entrée de transformation, ou `null` pour l’original. Les [règles de conservation](/architecture/storage/#publication-et-handles) décrivent le cycle de vie des sources.

## GET /source/:handle/:path

`:path` est un chemin du manifeste, par exemple `original/bundle.js`, jamais un chemin local arbitraire.

| Paramètre | Règle |
| --- | --- |
| `offset` | Octets UTF-8, défaut 0 ; doit être une frontière de caractère (`422` sinon) |
| `max_bytes` | De 4 à 65 536, défaut 16 384 ; la fin est ajustée à une frontière UTF-8 |

```json
{
  "handle": "ana_example_01",
  "path": "original/bundle.js",
  "content": "fetch(\"/api/profile\");",
  "offset": 0,
  "returned_bytes": 22,
  "total_bytes": 22,
  "next_offset": null
}
```

Reprendre à `next_offset` jusqu’à `null`. À la fin du fichier, le contenu est vide ; au-delà, `416`. `max_bytes` borne le source, pas le surcoût de l’échappement JSON.

## Erreurs HTTP

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Fournir exactement un champ parmi url et content.",
    "request_id": "req_example_01"
  }
}
```

| HTTP | Cas |
| --- | --- |
| `400` | JSON invalide, entrée ambiguë, outil inconnu, champ ou curseur invalide |
| `401` | Authentification absente ou invalide |
| `403` | Droit manquant ou `destination_denied` pour une capture refusée |
| `404` | Handle, module, job ou index inconnu ; identifiant appartenant à un autre projet |
| `409` | `script_hash_mismatch` : hash différent ; `result_unavailable` : item sans handle, même définitivement ignoré |
| `410` | Handle ou job expiré, tombstone encore connu du propriétaire |
| `413` | Corps ou script trop volumineux ; `capture_too_large` avant décompression, `script_too_large` après décompression |
| `415` | Type de requête ou compression HTTP non pris en charge |
| `416` | Offset supérieur à la taille du module |
| `422` | Domaine de référence manquant, entrée vide/non UTF-8/HTML, paramètres source invalides ; `job_budget_exceeded` : budget supérieur au plafond serveur |
| `429` | Capacité ou quota insuffisant ; `job_capacity` pour la file, `job_submission_capacity` si une soumission occupe déjà la réception ; `Retry-After` présent |
| `502` | `capture_failed` : réseau, transfert tronqué ou décompression invalide ; `capture_status` : statut autre que 200, redirection comprise ; `capture_encoding` : compression non prise en charge |
| `504` | `capture_timeout` : acquisition expirée ; `global_deadline` : délai global dépassé avant admission au stockage ou pendant son attente |
| `503` | Service indisponible, `scheduler_unavailable`, ou arrêt d’un worker impossible à confirmer |
| `500` | Échec interne de persistance ou de publication |

Les erreurs n’exposent ni source, ni sortie brute, ni chemin local ni URL sensible. Voir le [diagnostic opérateur](/guides/operations/#vérifier-et-diagnostiquer) pour les actions associées.
