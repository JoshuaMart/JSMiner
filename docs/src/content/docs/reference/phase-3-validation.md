---
title: Validation de la phase 3
description: Versions, chaîne de transformation et résultats des essais du profil hors ligne complet.
---

## Résultat

Le profil complet est intégré au parcours `content`. webcrack reçoit l’original ; Wakaru reçoit `webcrack/bundle.js` lorsqu’il a été conservé et n’est pas vide, sinon l’original avec `fallback_to_original`. Chaque extracteur parcourt l’original puis les représentations publiables. Le mode URL et la réutilisation du cache restent en phase 4.

## Versions et options

| Composant | Version / options |
| --- | --- |
| Runtime | Node.js 24.21.0 ; processus du worker lancé avec `--no-node-snapshot` |
| webcrack | 2.16.0 ; `jsx: false`, `unpack: true`, `unminify: true`, `deobfuscate: true`, `mangle: false` |
| Wakaru | 1.12.0 ; binaire fourni par npm, `--level standard` ; une sortie agrégée et un passage `--unpack` sur la même entrée |
| jsluice | Commit `0ddfab153e060a9eeaded4d8669233f7c071e7e4`, protocole 3 |
| TruffleHog | 3.97.9 ; `filesystem`, `--no-verification`, `--no-update`, `--concurrency=1`, `--results=unverified,unknown` |
| Extraction statique | `@babel/parser` 7.29.9 et `graphql` 17.0.2 |
| Images | `jsminer-jsluice:phase2` et `jsminer-offline:phase3`, identifiant immuable résolu avant chaque exécution |

Le fichier `workers/node/package-lock.json` verrouille les dépendances npm. Les deux SHA-256 des archives TruffleHog Linux sont fixés dans le Dockerfile ; sa licence accompagne le binaire. Références amont : [API webcrack](https://webcrack.netlify.app/docs/guide/api), [CLI Wakaru](https://github.com/pionxzh/wakaru/blob/v1.12.0/docs/cli.md), [TruffleHog 3.97.9](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.97.9).

## Vérifications

Essais effectués le 30 septembre 2026 avec l’API sur macOS arm64, le socle validé sous Linux amd64 et les workers réels sous Linux arm64 via Docker. La matrice complète des nouveaux workers sous Linux amd64 reste exécutée par la CI. Les fixtures n’utilisent que des chaînes synthétiques. Aucun serveur Astro n’a été démarré.

| Vérification | Résultat |
| --- | --- |
| `pnpm check` | Biome, contrats générés, OpenAPI, compilation, types et 126 tests passent : 60 contrats, 12 superviseur, 54 API |
| `pnpm test:workers` | 12 tests d’intégration Docker passent, dont 9 propres à la phase 3 |
| Validation Linux amd64 | `docker build --platform linux/amd64 --target validate .` exécute aussi `pnpm check` |
| Documentation | `pnpm --dir docs build` compile le site statique |
| JSX | JSX existant et appels React traversent les deux transformateurs réels |
| Chaîne réelle | Un chunk webpack donne cinq sources conservées, dont un module webcrack ; Wakaru utilise son agrégat et les parents sont présents au manifeste |
| Secrets synthétiques | GitHub détecté par jsluice et TruffleHog, fusionné en une observation masquée avec preuves des deux outils |
| GraphQL | Variables sans valeurs par défaut, alias ramenés au champ, fragments statiques, interpolation signalée et positions UTF-8 vérifiées sur les sources |
| Domaines | Frontières DNS, exclusion de l’apex et des wildcards, IDNA et choix de la racine la plus spécifique |
| Isolation | Réseau `none`, racine en lecture seule, UID 65532, limites mémoire/processus et `/tmp` borné ; aucun conteneur résiduel dans les essais de cycle de vie |
| Erreurs et limites | Repli, délai global, budget cumulé, conservation des autres résultats, chemins invalides, UTF-8 invalide, doublons, plafonds de sources, preuves et réponse |

La fixture avec cinq représentations produit dix preuves possibles pour le même secret. Les outils terminent avec succès mais la réponse est correctement `partial` avec `evidence_count`, puisque le contrat ne conserve que cinq preuves. Une preuve de chaque détecteur est préservée en priorité.

## Revue et corrections avant commit

Huit problèmes ont été corrigés et couverts par des régressions sur données synthétiques.

| Priorité | Problème | Correction / vérification |
| --- | --- | --- |
| P1 | Une substitution pouvait modifier `https:`, `?` ou `#` avant leur interprétation et laisser apparaître des identifiants ou valeurs query | Découpage de l’URL et suppression des identifiants avant masquage ; test des trois délimiteurs |
| P2 | Une exception ordinaire d’adaptateur annulait l’analyse entière | Conversion en `worker_failed`, poursuite des autres outils et repli Wakaru ; un nettoyage non confirmé reste bloquant |
| P2 | Un fragment GraphQL imbriqué manquant, cyclique ou ambigu pouvait produire une couverture complète | Règles de cohérence du document sans schéma distant ; résultat partiel et avertissement `incomplete_document` |
| P2 | Un grand tableau pouvait dépasser la limite d’arguments de la pile, avec des conversions répétées de préfixes UTF-8 | Parcours itératif sans spread et positions calculées seulement pour les candidats sous la limite de résultats ; tableau de 150 000 littéraux testé |
| P2 | La limite de 200 observations ne garantissait pas une enveloppe inférieure à 2 Mio | Accumulation bornée en octets dans les workers ; les observations complètes subsistent avec `finding_count` |
| P2 | Des fichiers JavaScript vides générés par Wakaru étaient refusés par le superviseur et jsluice | Conservation et lecture des modules vides, analyse jsluice valide ; un agrégat webcrack vide entraîne le repli |
| P2 | Le filtre de masquage examinait aussi les noms des champs JSON et les hashes générés | Filtrage sur les seules valeurs observées ; opérations et domaines sans valeur sensible conservés |
| P2 | La réservation initiale de stockage ne couvrait pas le manifeste de l’original | Marge initiale de 1 Kio pour le manifeste, avec refus avant lancement d’un worker lorsque la capacité est insuffisante |

Le protocole jsluice passe à **3**, et la version composite du worker Node finit par **`static2`**. `pnpm worker:build` reconstruit les images ; les anciennes versions sont refusées avant exécution. Les tests vérifient aussi que les diagnostics privés d’un outil ne sont pas sérialisés dans la réponse.

## Limites connues

- Un conteneur par module, sans parallélisme pour l’instant. Les délais incluent l’attente entre invocations ; ils ne garantissent pas l’extraction de milliers de modules. Les compteurs et couvertures rendent toute interruption visible.
- GraphQL analyse les chaînes et templates statiques de JavaScript/JSX. Pas d’exécution, d’assemblage dynamique, d’introspection distante ni d’association inventée à un endpoint : `endpoint_id` reste `null`.
- Les domaines proviennent de chaînes statiques contenant un nom ou une URL HTTP(S), sans résolution DNS. Les noms construits dynamiquement ne sont pas reconstruits.
- La détection non vérifiée de TruffleHog peut filtrer des faux positifs et manquer des valeurs. La fusion exige une famille et des valeurs canoniques identiques ; aucun rapprochement probabiliste de secrets composites.
- Les positions jsluice/TruffleHog restent `null`. Les positions GraphQL/domaines désignent le littéral dans la représentation analysée, pas le source d’origine d’une transformation.
- Les sorties des extracteurs sont bornées à 2 Mio. Le worker jsluice conserve son plafond d’entrée de 10 Mio ; un module transformé plus grand peut donc échouer pour cet outil. Le worker Node borne son enveloppe d’entrée à 64 Mio et ses fichiers temporaires à 128 Mio.
- Les noms des modules sont réattribués pour le stockage. Les sources servent à l’inspection ; les chemins d’import ne constituent pas un projet reconstruit exécutable.
- La qualification sur corpus, les mesures de rappel et de performance, ainsi que l’image d’exploitation du service restent au jalon J5.
