---
title: Contrat API
description: Contrats v0.1, validation disponible et comportement métier prévu.
---

## Conventions

**Acquisition et cache implémentés en phase 4.** `content` accepte tous les outils documentés ; les lectures `/source` exposent les représentations conservées. Le mode `url` accepte les origines autorisées dans `capture.origins` ; sans configuration, il répond `403 destination_denied`. Un outil dont l’image est absente ou incompatible est signalé `skipped / tool_unavailable`. JSON UTF-8, noms de champs en `snake_case`, dates UTC au format RFC 3339. Toutes les routes nécessitent un jeton Bearer opaque associé à un projet par la configuration serveur. Les droits sont `analysis:write`, `analysis:read` et `source:read`. `POST /analyze` exige les deux premiers droits, les routes `/source` le troisième. Voir le [guide de configuration](/guides/development/).

Le contrat machine est `packages/contracts/schema.json`, complété par les invariants de `validateContract` ; `packages/contracts/openapi.json` est généré. Les exemples de réponses métier ci-dessous sont vérifiés comme fixtures du contrat. `GET /health`, authentifié avec `analysis:read`, vérifie réellement SQLite et répond `200` avec les champs `status: "ok"`, `phase: 4`, `storage: "ready"`.

Les champs inconnus sont refusés en entrée. Les clients tolèrent les nouveaux champs de réponse. Une rupture nécessite une nouvelle version de contrat ; la réponse annonce `schema_version: "0.1"`.

La v0.1 est synchrone et bornée. Aucun `202` ni endpoint de polling n’est prévu. Le transport doit permettre les 90 secondes de travail et les 10 secondes réservées au nettoyage, avec une marge réseau.

## POST /analyze

### Entrée

| Champ | Type | Règle |
| --- | --- | --- |
| `url` | string | URL HTTP(S) du script ; exclusif avec `content` |
| `content` | string | Script non vide ; exclusif avec `url` ; 10 MiB UTF-8 maximum |
| `tools` | string[] | Facultatif ; liste non vide, sans doublons, d’identifiants connus |
| `script_hash` | string | Facultatif ; `sha256:` puis 64 hexadécimaux minuscules, hash du contenu intégral attendu |
| `base_url` | string | Facultatif ; URL HTTP(S) du document, utilisée uniquement pour résoudre les chemins observés |
| `reference_domains` | string[] | Facultatif ; domaines racines servant à classifier les sous-domaines observés |

Limites complémentaires proposées : URL de 4 096 caractères maximum ; au plus 20 domaines de référence, sans wildcard, normalisés en noms DNS ASCII. Les paramètres de sélection ne constituent aucune autorisation réseau. Les requêtes HTTP compressées sont refusées en v0.1 ; le corps JSON est limité à 64 MiB et `content` est contrôlé après décodage.

Depuis le commit `32142b2`, le hash Fingerprinter brut identifie le corps CDP complet et n’a pas le préfixe `sha256:`. Ajouter ce préfixe pour le transmettre comme assertion sur les mêmes octets ; sinon omettre `script_hash`. Les anciens hashes tronqués à 2 MiB ne doivent pas être réutilisés comme hashes complets. Le serveur le recalcule avant toute consultation du cache et refuse une différence avec `409 script_hash_mismatch`. Voir la [convention de hash](/architecture/storage/).

`base_url` n’est pas déduite de l’URL du script : un bundle hébergé sur un CDN peut appeler l’origine de la page. Sans base explicite, les endpoints relatifs restent non résolus. Une base ne déclenche jamais de requête.

| Identifiant | Fonction |
| --- | --- |
| `webcrack` | Transformation et dépliage |
| `wakaru` | Transformation et dépliage |
| `jsluice` | Extraction d’endpoints et de secrets potentiels |
| `trufflehog` | Détection de secrets dans les artefacts locaux, sans vérification réseau |
| `graphql` | Extracteur interne d’opérations GraphQL statiques |
| `domains` | Extracteur interne de sous-domaines observés |

Lorsque `tools` est absent, le profil par défaut sélectionne `webcrack`, `wakaru`, `jsluice`, `trufflehog` et `graphql`, puis ajoute `domains` si `reference_domains` contient au moins un domaine. `tools` décrit un ensemble, pas un ordre : si les deux transformateurs sont sélectionnés, le serveur applique webcrack puis Wakaru, avec repli sur l’original si la première transformation échoue. Une sélection explicite remplace le profil par défaut. Une liste de transformateurs seuls est valide : les tableaux de résultats sont vides et leur couverture vaut `not_requested`.

L’extracteur `domains` exige au moins un `reference_domains` lorsqu’il est explicitement sélectionné ; sinon, la requête est refusée avec `422`. Une requête minimale avec seulement `content` reste valide et indique `coverage.subdomains: not_requested`.

### Exemple de requête

```json
{
  "content": "fetch(\"/api/profile\");",
  "tools": ["jsluice"],
  "base_url": "https://app.example.com/dashboard"
}
```

Le mode URL utilise le même contrat en remplaçant `content` par `url`. L’acquisition doit être autorisée par la politique du serveur. Aucune requête ne suit les observations produites.

### Exemple de réponse 200

Les versions et durées ci-dessous sont illustratives. Le hash correspond exactement à la chaîne d’entrée ci-dessus.

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

`location: null` signifie que l’adaptateur n’a pas fourni de position fiable. Aucun extrait n’est ajouté pour compenser cette absence. Les règles des observations figurent dans le [modèle de résultats](/reference/results/).

### Statuts et couverture

| Champ | Valeurs et sens |
| --- | --- |
| `status` | `complete` : tous les traitements demandés terminent sans perte ; `partial` : un résultat utile subsiste avec une erreur ou limite ; `failed` : aucun traitement demandé ne produit de résultat exploitable |
| `tools[].status` | `success`, `partial`, `timeout`, `error`, `skipped` |
| `tools[].error_code` | Code stable ou `null` ; par exemple `tool_timeout`, `output_limit`, `parse_error`, `global_deadline`, `tool_unavailable` |
| `coverage[category]` | `complete`, `partial`, `failed`, `not_requested` |
| `cache.status` | `hit` : tous les outils entièrement réutilisés ; `partial_hit` : certains ; `miss` : aucun outil entièrement réutilisé |
| `truncation` | Booléen et codes de limite atteinte : `response_bytes`, `finding_count`, `evidence_count`, `artifact_bytes`, `module_count`, `field_bytes` |

Une extraction terminée sans observation est un succès. `complete` décrit l’exécution demandée, sans garantir la découverte de tout comportement possible. Une transformation demandée qui échoue rend la couverture des catégories extraites au plus `partial`, même si l’original a été analysé intégralement. Une catégorie sans résultat exploitable après échec de son extracteur vaut `failed`. Une catégorie non sélectionnée vaut `not_requested`.

La réutilisation se fait par entrée effective de chaque outil. `cache_hit` vaut `true` seulement si toutes ses entrées ont été réutilisées avec succès ; une réutilisation partielle des modules peut donc rester comptée comme `miss` pour cet outil. Les durées des outils entièrement réutilisés valent `0` et excluent le coût de lecture et de vérification du cache.

Un traitement sur cache garde un statut `success` et indique `cache_hit: true`. Les erreurs ne suppriment pas les observations déjà validées. Un outil connu mais indisponible est `skipped` avec `tool_unavailable`. Chaque outil demandé possède une entrée, même s’il n’a pas démarré.

`tools[].version` contient la version ou l’identifiant de build exact, ou `null` si indisponible. `duration_ms` mesure le travail de la requête courante, hors attente ; il vaut 0 pour une étape entièrement réutilisée. Pour un extracteur, `modules_analyzed` compte les modules effectivement analysés et `modules_available` ceux proposés par le pipeline ; ces deux champs valent `null` pour un transformateur. Les avertissements sont des objets `{ code, tool }`, où `code` est un identifiant stable et `tool` un identifiant d’outil ou `null` pour un avertissement global.

Pour un transformateur, le champ supplémentaire `input_path` référence l’entrée effective dans le manifeste : `original/bundle.js` ou, pour Wakaru après webcrack, `webcrack/bundle.js`. Le repli est signalé par `{ "code": "fallback_to_original", "tool": "wakaru" }`. Les extracteurs parcourant plusieurs représentations n’exposent pas ce champ unique.

`coverage.secrets` agrège les détecteurs demandés : avec jsluice et TruffleHog, l’échec de l’un rend la couverture `partial` si l’autre termine, même sans observation. Si les deux échouent sans résultat exploitable, elle vaut `failed`. Avec un seul détecteur sélectionné, `complete` décrit uniquement sa couverture ; les entrées `tools` indiquent lequel a travaillé.

Le statut global est `partial` dès qu’au moins un traitement réussit ou publie un résultat exploitable et qu’une autre étape échoue ou est omise. Il est `failed` si toutes les étapes demandées échouent ou sont omises sans résultat exploitable. Ces trois états retournent `200` avec un handle lorsque l’entrée et le manifeste ont pu être conservés. Une erreur d’acquisition ou d’infrastructure utilise les codes HTTP ci-dessous.

### Réponse bornée

Le plafond est de 256 KiB sérialisés. Les limites initiales sont 200 observations par catégorie, 5 preuves par observation et 32 avertissements. Les champs de découverte sont plafonnés à 2 048 octets ; une valeur trop longue est omise avec `field_bytes`, jamais présentée comme une valeur exacte raccourcie.

Le tri est déterministe : confiance décroissante, puis identifiant stable. Le serveur remplit les catégories par tours successifs pour qu’une catégorie ne consomme pas tout le budget. Si nécessaire, il retire des preuves puis des observations, en conservant toujours l’enveloppe et les statuts. Toute perte rend `status: partial`, la couverture concernée `partial` et `truncation.truncated: true`.

La v0.1 n’expose pas de pagination des observations omises. Le client peut consulter les modules ; une pagination des résultats fera l’objet d’une extension. Les champs bruts `source`, `context`, documents GraphQL complets et valeurs de secrets ne sont jamais copiés dans cette réponse.

## GET /source/:handle

Liste paginée du manifeste, sans code. Paramètres : `limit` entier de 1 à 100, défaut 50 ; `cursor` opaque facultatif. Le curseur est lié au handle et à l’ordre lexicographique des chemins.

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

`origin` vaut `original`, `webcrack` ou `wakaru` en v0.1. La pagination n’est pas une troncature : `next_cursor` permet de parcourir tout le manifeste conservé.

`parent_path` référence le module d’entrée de la transformation, ou `null` pour l’original. Les modules Wakaru ont pour parent `webcrack/bundle.js` après une préparation réussie, et `original/bundle.js` dans le cas du repli ou d’une sélection de Wakaru seul. Cette chaîne permet de retrouver les étapes sans inclure leur code dans la réponse d’analyse.

## GET /source/:handle/:path

`:path` capture tout le chemin logique, segments inclus. Exemple : `/source/ana_example_01/original/bundle.js`. Le serveur valide ce chemin dans le manifeste. Il n’accepte pas de chemin arbitraire du système de fichiers.

Paramètres : `offset` en octets UTF-8, entier positif ou nul, défaut 0 ; `max_bytes` entier de 4 à 65 536, défaut 16 384. L’offset doit correspondre au début d’un caractère ; une valeur invalide retourne `422`. La fin du fragment est ajustée à une frontière UTF-8. À la fin du fichier, la réponse contient une chaîne vide et `next_offset: null` ; au-delà, `416`.

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

`max_bytes` borne les octets source ; l’échappement JSON peut agrandir la réponse de transport. Pour un module volumineux, reprendre avec `offset=next_offset`. Ce découpage évite qu’une ligne minifiée gigantesque contourne une limite exprimée seulement en lignes.

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
| `410` | Handle expiré ou révoqué, tombstone encore connu du propriétaire |
| `413` | Corps ou script trop volumineux ; `capture_too_large` avant décompression, `script_too_large` après décompression |
| `415` | Type de requête ou compression HTTP non pris en charge |
| `416` | Offset supérieur à la taille du module |
| `422` | Domaine de référence manquant, entrée vide/non UTF-8/HTML, paramètres source invalides |
| `429` | Capacité d’exécution ou quota insuffisant ; `Retry-After` présent |
| `502` | `capture_failed` : réseau, transfert tronqué ou décompression invalide ; `capture_status` : statut autre que 200, redirection comprise ; `capture_encoding` : compression non prise en charge |
| `504` | `capture_timeout` : délai d’acquisition dépassé |
| `503` | Service indisponible ou arrêt d’un worker impossible à confirmer |
| `500` | Échec interne de persistance ou de publication |

Les messages d’erreur n’incluent ni code source, ni sorties brutes, ni chemins locaux, ni URL contenant des données sensibles.
