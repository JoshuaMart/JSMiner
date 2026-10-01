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

`POST /analyze` reste synchrone : jusqu’à 90 s de travail et un budget de nettoyage de 10 s par défaut, plus une marge réseau. Pour plusieurs scripts, utilisez les jobs asynchrones ci-dessous.

## GET /health

Retourne `{"status":"ok","storage":"ready"}` si SQLite et le superviseur sont disponibles. Ce contrôle ne lance pas de worker.

## POST /analyze

### Entrée

| Champ | Type | Règle |
| --- | --- | --- |
| `url` | string | URL HTTP(S) du script ; exclusif avec `content` |
| `content` | string | Script non vide ; exclusif avec `url` ; 10 MiB UTF-8 maximum |
| `tools` | string[] | Facultatif ; liste non vide, sans doublons, d’identifiants connus |
| `script_hash` | string | Facultatif ; `sha256:` puis 64 hexadécimaux minuscules, hash du contenu intégral attendu |
| `base_url` | string | Facultatif ; URL HTTP(S) du document, utilisée pour résoudre les chemins observés et comme référence des filtres |
| `redact_query_values` | boolean | `false` par défaut ; `true` masque toutes les valeurs query des endpoints |
| `min_confidence` | string | Seuil inclusif pour les quatre catégories : `low` (défaut), `medium` ou `high` |
| `endpoint_scope` | string | `all` (défaut), `same_fqdn` ou `same_domain` ; filtre uniquement les endpoints |
| `exclude_extensions` | string[] | Extensions à exclure des endpoints ; liste vide par défaut, 100 entrées maximum de 32 caractères |
| `reference_domains` | string[] | Facultatif ; domaines racines servant à classifier les sous-domaines observés |


Les URL sont limitées à 4 096 caractères ; les domaines de référence à 20 noms DNS ASCII sans wildcard. Le corps JSON est limité à 64 Mio et ne doit pas être compressé. Le mode `url` accepte les destinations publiques par défaut, selon la [politique de capture](/reference/configuration/#capture-url).

`script_hash` est recalculé avant consultation du cache. Pour Fingerprinter, voir la [convention de hash](/architecture/storage/#compatibilité-fingerprinter). `base_url` n’est pas déduite de l’URL du script et ne déclenche aucune requête ; sans elle, les chemins relatifs restent non résolus.

`same_fqdn` compare les noms d’hôte (sans tenir compte du schéma ni du port) ; `same_domain` compare les domaines enregistrables, sous-domaines inclus, avec les suffixes publics et privés de la [Public Suffix List via tldts](https://github.com/remusao/tldts). La référence est `base_url`, sinon `url` ; avec `content`, une portée restreinte exige `base_url` (`400` sinon). Pour une IP ou un hôte sans domaine enregistrable, la comparaison reste exacte. Les destinations indéterminables sont exclues d’une portée restreinte.

`exclude_extensions` accepte par exemple `css`, `.PNG` et `js.map` : comparaison sans casse sur la fin du nom de fichier, après décodage URL, sans query ni fragment. Ces deux filtres ne concernent que les endpoints. Les exclusions volontaires ne constituent pas une troncature ; les limites d’extraction restent applicables. Voir l’[exemple combiné](/guides/analysis/#filtrer-les-endpoints).

`min_confidence: "medium"` conserve `medium` et `high` ; `"high"` ne conserve que `high`. Les secrets détectés restent masqués même si leur observation est exclue par ce seuil. `redact_query_values: false` conserve les autres valeurs query ; `true` les remplace toutes par `REDACTED`. Ces options ne modifient pas les sources conservées.

Sans `tools`, le profil comprend `webcrack`, `wakaru`, `jsluice`, `trufflehog`, `graphql`, et `domains` si des domaines de référence sont fournis. Une sélection explicite remplace ce profil. L’ordre de la liste n’impose pas celui d’exécution ; les [outils](/reference/tools/) suivent le [pipeline](/architecture/pipeline/).

`domains` exige `reference_domains`, sinon `422`. Une sélection de transformateurs seuls est valide et produit des catégories `not_requested`.

### Exemple de requête

```json
{
  "content": "fetch(\"/api/profile\");",
  "tools": ["jsluice"],
  "base_url": "https://app.example.com/dashboard"
}
```

### Exemple de réponse 200

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

Les formats de chaque observation et de ses preuves sont définis dans le [modèle de résultats](/reference/results/).

### Statuts et couverture

| Champ | Sémantique |
| --- | --- |
| `status` | `complete` : traitements terminés sans perte ; `partial` : travail exploitable avec erreur ou limite ; `failed` : aucun traitement exploitable |
| `coverage[category]` | `complete`, `partial`, `failed` ou `not_requested`, pour les détecteurs sélectionnés |
| `tools[].status` | `success`, `partial`, `timeout`, `error`, `skipped` |
| `tools[].error_code` | Code stable ou `null` ; image absente/incompatible : `tool_unavailable` |
| `tools[].version` | Version/build exact, ou `null` si indisponible |
| `tools[].duration_ms` | Travail de la requête courante ; `0` pour une étape entièrement réutilisée |
| `tools[].modules_analyzed` / `modules_available` | Modules analysés/proposés ; `null` pour les transformateurs |
| `tools[].input_path` | Entrée du transformateur dans le manifeste ; absent pour les extracteurs |
| `tools[].cache_hit` | `true` seulement si toutes les entrées de l’outil sont réutilisées |
| `cache.status` | `hit` : tous les outils entièrement réutilisés ; `partial_hit` : certains ; `miss` : aucun |
| `warnings` | Objets `{ code, tool }` ; `tool: null` pour un avertissement global |

Chaque outil demandé a une entrée, même s’il n’a pas démarré. Un traitement en cache garde `success` ; sa durée exclut la lecture et la vérification du cache. Une réutilisation partielle des modules peut rester comptée comme `miss` pour cet outil.

`memory_limit` signale un épuisement mémoire identifié. `unpack_failed` indique que Wakaru a conservé son bundle transformé, mais que le dépliage n’a pas abouti ; les extracteurs peuvent utiliser ce bundle.

Une extraction vide réussie est `complete`, sans garantie d’exhaustivité. L’échec d’une transformation rend au plus `partial` la couverture des catégories extraites. Avec deux détecteurs de secrets, un échec et une réussite donnent `coverage.secrets: partial` ; deux échecs sans résultat donnent `failed`.

Les trois statuts globaux utilisent HTTP `200` avec un handle si les artefacts ont pu être publiés. Les échecs d’acquisition ou d’infrastructure utilisent les erreurs HTTP ci-dessous.

### Réponse bornée

Plafonds : **256 Kio** sérialisés, **200 observations par catégorie par défaut** (paramètre serveur `budgets.finding_count`, de 1 à 2 000), **5 preuves par observation**, **32 avertissements** et **2 048 octets par champ de découverte**. Un champ trop long est omis, pas raccourci.

Les résultats sont triés par confiance décroissante puis identifiant stable, et les catégories sont remplies par tours. Une perte rend la réponse et la couverture concernée `partial`, avec `truncation.truncated: true` et un motif : `response_bytes`, `finding_count`, `evidence_count`, `artifact_bytes`, `module_count` ou `field_bytes`.

Il n’y a pas de pagination des observations omises. La réponse ne contient ni code source, ni contexte brut, ni valeur originale de secret.

## Jobs asynchrones

| Route | Réponse |
| --- | --- |
| `POST /jobs` | `202` avec l’état initial et l’en-tête `Location: /jobs/:id` |
| `GET /jobs/:id` | État du lot et de chaque script, sans code ni observations |
| `GET /jobs/:id/items/:index` | Réponse `AnalyzeResponse` d’un script dès sa publication |
| `DELETE /jobs/:id` | Annulation des traitements restants ; les résultats publiés sont conservés |

Le corps de soumission contient `items`, de 1 à 50 objets au format de `POST /analyze`, et éventuellement `budget_ms`. Chaque script conserve ses propres options et son propre handle ; l’index correspond à sa position dans `items`, à partir de zéro. La limite du corps HTTP s’applique au lot entier. Les options et contenus sont validés avant acceptation ; une erreur d’acquisition ou de traitement reste ensuite propre au script concerné.

`budget_ms` vaut 90 000 par défaut (ou le plafond serveur s’il est inférieur). Il est borné par `jobs.max_budget_ms`, 300 000 par défaut. Le délai commence à l’acceptation, **attente dans la file comprise**. Une analyse reçoit au plus le temps restant et son plafond `analysis_ms`. Le nettoyage peut se poursuivre après l’échéance ; un état terminal n’est publié qu’après retour des analyses actives.

L’état du job contient `id`, `status`, `created_at`, `deadline_at`, `expires_at` et `items`. Chaque item expose `index`, `status`, `handle` et `error_code` (les deux derniers peuvent être `null`).

| État d’un script | Signification |
| --- | --- |
| `queued`, `running` | En attente ou en cours |
| `complete`, `partial`, `failed` | Statut de l’analyse publiée ; les détails sont dans son résultat |
| `failed` sans handle | Aucun résultat publié ; `error_code` indique la cause |
| `skipped` | Non démarré : délai, annulation, arrêt ou indisponibilité du service |

Le job passe de `queued` à `running`, puis à `completed` ou `timed_out`. `completed` signifie que tous les items sont terminaux, **pas qu’ils ont tous réussi**. L’annulation passe par `cancelling`, puis `cancelled` après retour des analyses actives. Un nettoyage non confirmé reste visible dans `error_code` et rend le service indisponible. Un arrêt ou redémarrage classe les jobs inachevés en `interrupted` ; aucune relance automatique. La déconnexion HTTP du client n’annule pas le job.

La lecture d’un résultat sans handle retourne `409 result_unavailable`, y compris pour un item définitivement ignoré. Un index absent retourne `404`. Les jobs expirés retournent `410` pendant 24 h, puis `404`. Les handles gardent leur propre durée de rétention : un résultat peut donc expirer avant le job. Les identifiants d’un autre projet retournent `404`.

Une soumission refusée pour quota retourne `429 job_capacity` ; une autre soumission dont le corps est encore en réception peut donner `429 job_submission_capacity`. Un budget supérieur au plafond serveur donne `422 job_budget_exceeded`. Un `POST` répété crée un nouveau job : il n’y a pas de clé d’idempotence.

Les [exemples](/guides/analysis/#soumettre-un-lot) montrent la soumission, le suivi et la lecture progressive.

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
| `404` | Handle/module inconnu ou handle appartenant à un autre projet |
| `409` | `script_hash_mismatch` : hash annoncé différent du contenu reçu |
| `410` | Handle expiré, tombstone encore connu du propriétaire |
| `413` | Corps ou script trop volumineux ; `capture_too_large` avant décompression, `script_too_large` après décompression |
| `415` | Type de requête ou compression HTTP non pris en charge |
| `416` | Offset supérieur à la taille du module |
| `422` | Domaine de référence manquant, entrée vide/non UTF-8/HTML, paramètres source invalides |
| `429` | Capacité d’exécution ou quota insuffisant ; `Retry-After` présent |
| `502` | `capture_failed` : réseau, transfert tronqué ou décompression invalide ; `capture_status` : statut autre que 200, redirection comprise ; `capture_encoding` : compression non prise en charge |
| `504` | `capture_timeout` : délai d’acquisition dépassé |
| `503` | Service indisponible ou arrêt d’un worker impossible à confirmer |
| `500` | Échec interne de persistance ou de publication |


Les erreurs n’exposent ni source, ni sortie brute, ni chemin local ni URL sensible. Voir le [diagnostic opérateur](/guides/operations/#vérifier-et-diagnostiquer) pour les actions associées.
