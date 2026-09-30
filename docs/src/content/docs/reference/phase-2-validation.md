---
title: Validation de la phase 2
description: Preuves, commandes de reproduction et limites du parcours hors ligne avec jsluice.
---

## Périmètre livré

La phase 2 fournit `POST /analyze` en mode `content`, un worker jsluice isolé, des résultats normalisés et le stockage privé des sources. Le hash porte sur tous les octets UTF-8, sans modification du BOM ni des fins de ligne. Un hash annoncé différent est refusé avant extraction.

Le service reste en TypeScript avec Node.js 24.21.0. Le petit exécutable Go de `workers/jsluice` encapsule la bibliothèque Go jsluice au commit `0ddfab153e060a9eeaded4d8669233f7c071e7e4` ; il ne remplace pas le runtime du service. Son build utilise Go 1.26.1, les dépendances sont verrouillées dans `go.mod` et `go.sum`.

La sélection `tools: ["jsluice"]` exécute les détecteurs d’endpoints et de secrets. Le profil par défaut conserve les outils prévus au contrat : ceux des phases suivantes portent `skipped / tool_unavailable`, ce qui rend explicitement l’analyse partielle. Le mode URL reste indisponible et le cache répond toujours `miss`.

## Vérifications du 30 septembre 2026

| Vérification | Preuve reproductible |
| --- | --- |
| Lint, contrats, compilation et types | `pnpm check` ; Biome et OpenAPI sans erreur |
| Contrats et service | 105 tests : 60 contrats, 12 superviseur, 33 API/stockage |
| Extraction réelle | `pnpm worker:build` puis `pnpm test:workers` ; 3 tests d’intégration, sans test ignoré |
| Installation Linux amd64 | `docker build --platform linux/amd64 --target validate -t jsminer:phase2-validation .` |
| Documentation | `pnpm --dir docs build` ; aucune instance Astro de développement démarrée |

Les tests locaux utilisent macOS arm64 avec Docker via OrbStack. Le conteneur jsluice s’exécute sur le noyau Linux de Docker. Le Dockerfile racine vérifie séparément le workspace Node sur Linux amd64 émulé. La CI exécute aussi le build du worker et les tests d’intégration sur Ubuntu ; son résultat distant doit être consulté après un push.

### Extraction et compacité

Les fixtures réelles sont dans `apps/api/integration/workers.test.mjs`. Un appel `fetch` et un secret synthétique produisent un endpoint dédupliqué et un secret masqué, avec référence à `original/bundle.js`. Une boucle infinie et un `throw` dans le script n’entravent pas l’analyse : le contenu est parsé, jamais exécuté. Une fixture sans observation termine `complete` avec la couverture endpoints/secrets complète. Une syntaxe incomplète, y compris une ponctuation manquante signalée par tree-sitter, et une sortie dépassant le nombre maximal d’observations donnent `partial`. Les endpoints déjà extraits sont conservés lorsque seule leur liste est tronquée.

Le protocole privé JSONL (version 2 de l’adaptateur) est validé avant utilisation. Le superviseur refuse une image portant une autre version de protocole. Il refuse les champs inattendus, une version différente, une terminaison absente et les sorties supérieures à 2 Mio. Les contextes et fragments de code fournis par jsluice sont exclus. Les secrets sont remplacés par `[REDACTED]`, accompagnés d’une empreinte HMAC propre au projet et de `validation: not_performed`. Aucun secret ni endpoint découvert n’est contacté.

Les valeurs de paramètres d’URL et fragments sont retirés ; les identifiants d’autorité sont supprimés. Les secrets détectés sont également masqués dans les observations d’endpoints. Une liste de secrets tronquée interdit la publication d’endpoints dont le masquage ne pourrait plus être assuré. Le plafond de réponse est vérifié sur le JSON UTF-8 sérialisé et toute réduction produit une troncature explicite. Les tests abaissent ce plafond à 2 000 octets.

### Sources et conservation

Les tests API et SQLite vérifient la restitution exacte d’un source contenant BOM, CRLF, accents et emoji en lectures de quatre octets au maximum. Un offset au milieu d’un caractère donne `422`, un offset hors fichier `416`. Les droits `source:read` restent nécessaires. Le hash et la taille sont revérifiés avant lecture ; un fichier altéré ou un lien symbolique est refusé.

Un manifeste synthétique de cinq modules vérifie la pagination et les curseurs signés, liés au projet et au handle. La phase 2 ne produit réellement qu’un module original par analyse ; les représentations supplémentaires arriveront en phase 3.

Les fixtures vérifient l’isolation entre projets, l’expiration, la suppression des fichiers, le tombstone propriétaire de 24 heures, les quotas, le redémarrage avec conservation des handles et de la clé HMAC, ainsi que la suppression des fichiers de staging abandonnés. La publication utilise le renommage du répertoire privé puis l’insertion SQLite comme point de visibilité. Les autres analyses ne peuvent pas lire le staging.

### Isolation et arrêt

Les tests inspectent de vrais conteneurs : réseau `none`, système de fichiers en lecture seule, aucun montage, utilisateur non privilégié, capacités supprimées, limites CPU/mémoire/processus et journal Docker désactivé. Le script est transmis par stdin. Le worker de test du cycle de vie est une image distincte supprimée après le test.

Un succès jsluice, une sortie en erreur, un débordement de sortie, un délai dépassé et une annulation sont suivis de la suppression du conteneur. Une recherche Docker par étiquette confirme l’absence de worker restant. Une déconnexion HTTP et la fermeture du serveur déclenchent aussi l’annulation.

Les pannes de confirmation du nettoyage sont injectées dans les tests du superviseur. Elles bloquent les nouvelles admissions, empêchent la publication d’un handle et rendent le service indisponible. Un redémarrage récupère les conteneurs portant l’étiquette du même stockage avant la première analyse jsluice.

## Revue et corrections avant commit

| Priorité | Constat | Correction et vérification |
| --- | --- | --- |
| P1 | L’admission après décodage JSON ne bornait pas les corps HTTP reçus simultanément | Réservation avant lecture du corps ; test avec requête encore en cours d’envoi, refus `429` et libération après déconnexion |
| P1 | Le verrou PID et sa suppression pouvaient rompre l’exclusivité du stockage | Verrou SQLite exclusif sur `.lease.sqlite`, fermeture idempotente ; tests de contention, crash de processus et réouverture |
| P2 | La récupération Docker pouvait continuer à lancer des commandes après son délai | Échéance commune vérifiée avant chaque commande ; test à horloge contrôlée et blocage si récupération non confirmée |
| P2 | Une annulation avant création pouvait bloquer inutilement le superviseur | Distinction entre création réellement tentée et arrêt avant commande ; tests de timeout et annulation pendant la préparation |
| P2 | La recherche de nœuds `ERROR` ignorait certaines ponctuations manquantes | Vérification `HasError` de l’arbre syntaxique ; fixture réelle de fonction incomplète |
| P2 | Une troncature des seuls endpoints supprimait aussi tous les résultats déjà extraits | Signal distinct pour les secrets tronqués ; conservation des endpoints lorsque leur masquage est assuré |
| P2 | Une déduplication trop large supprimait une navigation ou des paramètres de corps distincts | Suppression des seuls résultats dont les métadonnées sont couvertes par une observation plus précise ; fixture dédiée |
| P1 | Un échec de suppression pendant un rollback pouvait laisser un artefact non comptabilisé sans bloquer le service | Erreur de nettoyage explicite propagée au contrôle des admissions ; test du blocage après rollback non confirmé |
| P2 | Un `?` dans une valeur de query pouvait supprimer les paramètres suivants | Découpage au premier séparateur uniquement et test des noms de paramètres restitués |

La lecture privée borne également les octets effectivement lus et refuse les fichiers spéciaux sans attendre sur leur ouverture. Les limites par catégorie du protocole worker sont vérifiées avant normalisation. Les corrections ne changent pas le périmètre des phases suivantes.

## Limites conservées

- `complete` décrit l’exécution des détecteurs demandés, pas l’absence certaine de secrets ou d’endpoints non détectés. Jsluice applique ses règles statiques ; TruffleHog et la qualification du corpus restent à livrer.
- Les localisations sont `null` : le wrapper n’invente pas de positions à partir des fragments reconstruits par jsluice.
- Les transformations, GraphQL et sous-domaines relèvent de la phase 3 ; acquisition URL et cache de la phase 4.
- La phase 2 n’admet qu’une analyse à la fois et ne partage pas les fichiers entre handles. Son quota comptabilise les artefacts avec une réserve de métadonnées ; la capacité physique SQLite/WAL et Docker reste à dimensionner sur l’hôte.
- Le déploiement du service hôte avec Docker local est le parcours fourni. Le Dockerfile racine reste une image de qualification du workspace, pas une distribution complète du moteur.
