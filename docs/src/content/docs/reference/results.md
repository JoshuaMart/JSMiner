---
title: Modèle de résultats
description: Champs des observations, provenance et règles de regroupement.
---

## Champs communs

Chaque observation possède un `id` stable dans son projet, une `confidence` (`low`, `medium`, `high`) et des `evidence`. La confiance décrit la preuve statique, pas la gravité d’une vulnérabilité ou la validité d’un secret.

Une preuve contient `tool`, `module_path`, `representation` (`original`, `webcrack`, `wakaru`) et `location`. La position est `null` si inconnue, sinon `{ start_byte, end_byte }` en octets UTF-8, borne finale exclue, dans le module référencé. Une position transformée n’est pas une position dans l’original.

Les observations identiques sont regroupées en conservant leurs preuves. Les [statuts et limites de réponse](/reference/api/#statuts-et-couverture) indiquent les éventuelles pertes.

## Endpoints

| Champ | Sens |
| --- | --- |
| `value` | URL ou chemin observé, valeurs sensibles masquées |
| `resolved_url` | URL résolue avec `base_url`, ou `null` |
| `method` | Méthode identifiée, ou `null` |
| `kind` | `http_call`, `navigation`, `resource` ou `literal` |
| `dynamic` | Présence d’une expression inconnue |
| `query_params` / `body_params` | Noms des paramètres, sans valeurs |

Les valeurs query sont masquées et les identifiants de l’autorité URL supprimés. La casse des chemins et les caractères réservés sont préservés. Une méthode inconnue ne devient pas automatiquement `GET` ; le défaut de `fetch` peut être reconnu.

Le regroupement tient compte du type, de la méthode, du chemin, des paramètres et des parties dynamiques. Une chaîne isolée reste une preuve moins forte qu’un appel réseau reconnu.

## Secrets potentiels

jsluice et TruffleHog contribuent à cette catégorie. TruffleHog fonctionne sans vérification réseau. Les résultats sont regroupés par famille normalisée et empreinte des valeurs, y compris lorsqu’ils viennent de représentations différentes.

| Champ | Sens |
| --- | --- |
| `kind` | Famille de détection |
| `rule_id` | Règle principale qualifiée par outil |
| `masked_value` | Toujours `[REDACTED]` |
| `fingerprint` | HMAC-SHA-256 propre au projet |
| `validation` | Toujours `not_performed` |

Les alias GitHub, Google/Firebase et AWS sont normalisés ; les autres familles gardent leur nom de détecteur en minuscules. Une identité composite n’est pas fusionnée avec une clé isolée sans correspondance exacte des valeurs.

Chaque preuve ajoute son `rule_id`. La règle principale vient de la preuve à plus forte confiance, puis du premier identifiant lexical en cas d’égalité. Si les preuves doivent être limitées, un couple détecteur/règle distinct est retenu en priorité.

Le HMAC permet le regroupement sans publier de hash simple du secret. Sa stabilité dépend de la clé persistante du stockage. Les valeurs originales restent accessibles dans les sources avec `source:read`.

## Opérations GraphQL

| Champ | Sens |
| --- | --- |
| `operation_type` | `query`, `mutation` ou `subscription` |
| `name` | Nom, ou `null` pour une opération anonyme |
| `variables` | `{ name, type }`, sans valeurs par défaut |
| `root_fields` | Champs de premier niveau, sans arguments |
| `document_hash` | SHA-256 du document canonique interne |
| `endpoint_id` | Toujours `null` dans l’extracteur actuel |

Le parseur traite les documents statiques, sans schéma distant. Les fragments seuls ne sont pas des opérations. Un document interpolé ou incomplet donne un avertissement ; un hash de requête persistée ne permet pas d’en reconstituer le contenu.

## Sous-domaines

Le résultat contient `hostname` et `reference_domain`. Il retient uniquement les descendants stricts d’une racine fournie : pour `example.com`, `api.example.com` est accepté, mais pas `example.com` ni `example.com.other.test`.

La comparaison utilise les labels DNS normalisés ; la racine la plus spécifique est retenue. IP, wildcards et noms incomplets sont exclus. Aucune résolution DNS n’est effectuée.
