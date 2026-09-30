---
title: Modèle de résultats
description: Sémantique des observations, provenance, regroupement et limites d’interprétation.
---

## Champs communs

Chaque observation possède un `id`, une `confidence` (`low`, `medium`, `high`) et un tableau `evidence`. L’identifiant est dérivé de l’identité canonique de l’observation dans le projet ; il est stable pour le même contenu et la même configuration. Il ne sert jamais de droit d’accès.

Une preuve comporte `tool`, `module_path`, `representation` et `location`. La représentation désigne les octets effectivement analysés : `original`, `webcrack` ou `wakaru`. Le chemin appartient au manifeste du handle. `location` vaut `null` ou contient des offsets UTF-8 `start_byte` inclusif et `end_byte` exclusif, relativement à ce module. L’adaptateur convertit explicitement les positions exprimées dans une autre unité.

Les positions sur un module reconstruit ne sont pas annoncées comme des positions originales. Plusieurs preuves peuvent justifier la même observation. Les limites de preuves et la disponibilité des sources sont visibles, jamais remplacées par des coordonnées inventées.

## Endpoints

| Champ | Sens |
| --- | --- |
| `value` | URL ou chemin statique observé, avec masquage des valeurs sensibles |
| `resolved_url` | URL absolue dérivée d’une base explicite, ou `null` |
| `method` | Méthode HTTP identifiée, ou `null` si inconnue |
| `kind` | `http_call`, `navigation`, `resource` ou `literal` |
| `dynamic` | Une portion dépend d’une expression inconnue |
| `query_params` | Noms de paramètres query, sans leurs valeurs |
| `body_params` | Noms de propriétés du corps identifiées, sans leurs valeurs |

Un chemin trouvé dans un appel réseau apporte une preuve différente d’une chaîne isolée. Une méthode inconnue ne devient pas automatiquement `GET`. Le défaut d’un appel `fetch` sans options peut en revanche être reconnu par l’adaptateur.

Les valeurs inconnues restent marquées comme dynamiques. Les URL observées sont normalisées sans changer la casse du chemin ni décoder les caractères réservés. Les valeurs des paramètres query sont masquées dans l’API ; leurs noms sont conservés. Les identifiants utilisateur dans l’autorité URL sont supprimés. Toute autre valeur reconnue comme secret est masquée avant sérialisation.

Le regroupement utilise le type, la méthode, la forme du chemin, les noms de paramètres et les parties dynamiques. Deux méthodes différentes ou deux formes dynamiques différentes restent distinctes. Les représentations ne fusionnent pas leurs sources : elles ajoutent des preuves au même résultat.

## Secrets potentiels

### Détecteurs intégrés

Le profil par défaut utilise **TruffleHog comme détecteur principal et jsluice en complément** ; aucun moteur de détection généraliste n’est réécrit dans JSMiner.

| Outil | Responsabilité dans JSMiner |
| --- | --- |
| [TruffleHog](https://github.com/trufflesecurity/trufflehog) | Détecteurs existants appliqués aux fichiers de l’analyse, via un binaire isolé et une sortie JSON normalisée |
| [jsluice](https://github.com/BishopFox/jsluice) | Matchers sur la structure JavaScript, en complément de son extraction d’endpoints |

L’original et les représentations transformées sont inspectés : une désobfuscation peut rendre visibles des chaînes absentes en clair dans l’entrée. Les résultats sont regroupés par famille normalisée et empreinte de valeur, en conservant les preuves de chaque détecteur. La même valeur trouvée deux fois ne devient pas deux secrets distincts pour la même famille. Les alias GitHub, clés API Google/Firebase et AWS sont normalisés ; les autres familles conservent leur nom de détecteur en minuscules. Une identité composite et une clé isolée ne sont pas fusionnées sans correspondance exacte de leurs valeurs.

Le mode de fichiers locaux de TruffleHog est utilisé avec vérification et recherche de mises à jour désactivées (`--no-verification`, `--no-update`), dans un worker sans réseau. Ces options sont documentées dans sa [référence CLI](https://github.com/trufflesecurity/trufflehog#usage). Les résultats non vérifiés sont conservés : filtrer seulement les résultats `verified` viderait artificiellement une analyse hors ligne. La détection ne teste aucun identifiant auprès d’un fournisseur.

Les faux positifs et les limites du mode non vérifié sont évalués sur des fixtures ; aucune promesse de rappel supérieur n’est faite avant comparaison. Le budget de TruffleHog est distinct de celui de jsluice. Les champs bruts pouvant contenir des valeurs ou extraits sont filtrés dans l’adaptateur.

### Format normalisé

| Champ | Sens |
| --- | --- |
| `kind` | Famille de détection |
| `rule_id` | Règle principale qualifiée par outil, versionnée avec le moteur |
| `masked_value` | Marqueur `[REDACTED]` ; aucune valeur originale |
| `fingerprint` | HMAC-SHA-256 de la valeur, avec clé propre au projet |
| `validation` | Toujours `not_performed` en v0.1 |

Le HMAC permet de regrouper les occurrences sans publier la valeur ou un hash simple susceptible de faciliter la recherche de petites valeurs. La version de clé entre dans l’identité de la vue normalisée. Les valeurs brutes restent confinées aux artefacts privés et au traitement interne.

Pour un secret, chaque preuve ajoute son propre `rule_id`, qualifié par outil, afin de conserver les règles d’origine après fusion. Le `rule_id` principal est celui de la preuve à plus forte confiance, puis le premier identifiant lexical en cas d’égalité. `evidence[].tool` permet de distinguer `trufflehog` de `jsluice`. La position reste `null` si l’outil ne fournit pas d’offset fiable dans le module conservé. Lorsqu’il faut limiter les preuves à cinq, une preuve par couple détecteur/règle est retenue en priorité et `evidence_count` signale la perte.

Le nom d’une variable, la structure d’une valeur et son contexte peuvent étayer une confiance. L’entropie seule ne prouve pas qu’il s’agit d’un secret. Aucune tentative d’utilisation n’est effectuée. La consultation du module nécessite `source:read`, car le source peut contenir la valeur originale.

## Opérations GraphQL

L’extracteur interne examine des documents statiques présents dans des chaînes ou templates reconnus. Il utilise un parseur GraphQL pour distinguer la syntaxe des simples ressemblances textuelles. Il ne reçoit pas de schéma distant et ne déclenche aucune introspection.

| Champ | Sens |
| --- | --- |
| `operation_type` | `query`, `mutation` ou `subscription` |
| `name` | Nom de l’opération, ou `null` si anonyme |
| `variables` | Liste de `{ name, type }` ; aucune valeur par défaut publiée |
| `root_fields` | Noms des champs de premier niveau identifiés, sans arguments |
| `document_hash` | SHA-256 d’une représentation canonique interne du document |
| `endpoint_id` | Référence à un endpoint conservé dans la réponse si l’association est prouvée, sinon `null` |

Les fragments seuls ne deviennent pas des opérations. Les documents incomplets ou interpolés qui ne peuvent pas être analysés statiquement entraînent un avertissement, pas une reconstruction inventée. Un hash de requête persistée sans document ne permet pas d’en déduire l’opération. Le document GraphQL complet reste accessible seulement dans les sources.

## Sous-domaines

Un sous-domaine est un nom observé strictement descendant d’un domaine de `reference_domains`. Pour `example.com`, `api.example.com` est admissible ; `example.com` lui-même et `example.com.other.test` ne le sont pas. La comparaison se fait sur les labels DNS normalisés, pas sur une sous-chaîne.

Le résultat expose `hostname` et `reference_domain`. Si plusieurs racines correspondent, retenir la plus spécifique. Les adresses IP, wildcards et noms incomplets sont exclus. Il n’y a ni résolution DNS ni affirmation de propriété. Avec `content`, un domaine ne peut pas être déduit de l’origine d’une capture non fournie.

## Confiance et exhaustivité

`high` signifie qu’une règle structurée fournit une preuve directe ; `medium` désigne une reconstruction statique partielle ; `low` une observation ambiguë. Ce niveau qualifie la détection, pas la gravité d’une vulnérabilité ni la validité d’un identifiant.

Une observation peut subsister quand un autre outil échoue. Une catégorie vide avec `coverage: complete` signifie uniquement « aucun résultat selon les traitements exécutés ». Une catégorie `not_requested`, `partial` ou `failed` ne permet pas cette conclusion.
