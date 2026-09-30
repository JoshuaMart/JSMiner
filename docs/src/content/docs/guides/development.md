---
title: Développement et configuration
description: Installer le socle Node.js, démarrer l’API privée et faire évoluer les contrats.
---

## Installation

Le workspace du service utilise **Node.js 24.21.0 et pnpm 10.33.0**. pnpm sélectionne le Node.js déclaré par `useNodeVersion` sans remplacer celui du système. `docs/` conserve son workspace et son lockfile indépendants.

Depuis la racine, avec pnpm 10.33.0 installé et un moteur Docker local accessible :

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm worker:build
pnpm test:workers
pnpm config:init
JSMINER_CONFIG="$PWD/.local/config.json" pnpm dev
```

`config:init` crée `.local/` en mode `0700`, puis `config.json` et `token` en mode `0600`. Le jeton contient 32 octets aléatoires encodés en base64url ; seule son empreinte SHA-256 est placée dans la configuration. Le jeton n’est pas affiché. Un répertoire existant n’est jamais écrasé.

```sh
curl --fail -H "Authorization: Bearer $(cat .local/token)" http://127.0.0.1:3000/health
```

`/health` répond `200` avec `phase: 5` lorsque le stockage est utilisable et que le superviseur n’est pas bloqué. Il ne démarre pas de worker et ne garantit pas la disponibilité de Docker ou de l’image. `POST /analyze` traite `content` et les URL autorisées ; les routes `/source` consultent les artefacts publiés. Sans origine configurée, le mode `url` répond `403 destination_denied`. L’arrêt par `Ctrl+C` annule l’analyse active, attend le nettoyage, puis ferme HTTP et SQLite.

Les images `jsminer-jsluice:phase2` et `jsminer-offline:phase3` se construisent avec `pnpm worker:build`. Le service résout son identifiant immuable et vérifie les étiquettes de version jsluice et de protocole (version 3) avant chaque exécution. Reconstruire l’image après une mise à jour du worker. Le worker reçoit uniquement le script sur stdin : aucun volume, socket Docker, secret de service ou réseau. Les limites mémoire, CPU, processus et sorties s’appliquent au conteneur. Le moteur Docker est piloté par le service hôte ; son accès est réservé à l’opérateur.

Après `pnpm build`, le démarrage compilé est :

```sh
JSMINER_CONFIG="$PWD/.local/config.json" pnpm --filter @jsminer/api start
```

## Authentification et projets

La configuration est validée par `apps/api/config.schema.json`. `JSMINER_CONFIG` est obligatoire ; aucune identité anonyme ou clé par défaut n’est acceptée. Chaque requête fournit `Authorization: Bearer <jeton>`. Le projet et les droits viennent exclusivement de la configuration serveur ; `project_id` est interdit dans une demande d’analyse.

| Route | Droits nécessaires |
| --- | --- |
| `GET /health` | `analysis:read` |
| `POST /analyze` | `analysis:write` et `analysis:read` |
| Routes `/source` | `source:read` |

Chaque entrée de `tokens` contient `sha256` (64 caractères hexadécimaux minuscules), `project_id` et `permissions`. Un jeton appartient à un seul projet ; plusieurs jetons peuvent partager ce projet avec des droits différents. Les empreintes sont comparées avec `timingSafeEqual`. Retirer une entrée ou remplacer son empreinte, puis redémarrer, révoque le jeton. Il n’y a ni rechargement automatique ni API de gestion des identités.

L’identité du projet, les permissions et l’isolation des handles sont testées. Un handle d’un autre projet répond `404`, même expiré. Les clés du cache sont également cloisonnées par projet.

## Configuration et budgets

`database` est un chemin relatif au fichier de configuration, ou un chemin absolu. Son répertoire parent doit exister et être privé. `:memory:` est réservé aux essais. Le socle utilise `node:sqlite`, le journal WAL et une migration versionnée idempotente ; les handles et leurs manifestes sont indexés depuis la migration 2, les entrées de cache depuis la migration 3.

`host` vaut `127.0.0.1` par défaut et peut devenir `0.0.0.0` pour un conteneur privé. `port` vaut `3000`. Les journaux HTTP sont désactivés ; le démarrage et les erreurs fatales produisent seulement des messages génériques.

Les clés facultatives de `budgets` reprennent les [budgets du pipeline](/architecture/pipeline/#budgets-proposés). Chaque valeur est un entier positif et peut uniquement réduire son plafond. Les valeurs manquantes reçoivent leurs valeurs par défaut. Une clé inconnue, des empreintes de jetons dupliquées ou des budgets incohérents font échouer le démarrage.

Le service réserve la capacité avant lecture du corps HTTP et admet une seule analyse active et un seul worker à la fois ; une seconde analyse reçoit `429` avec `Retry-After: 1`. Les plafonds HTTP, script, artefacts et réponse sont appliqués, ainsi que les budgets cumulés par extracteur, limités au temps global restant. Le nettoyage dispose de son budget distinct. La capture dispose de `capture_ms` et consomme aussi le budget global `analysis_ms`.

`artifact_directory` désigne un répertoire privé (`0700`), par défaut `<database>.artifacts`. Il contient des fichiers `0600`, une clé HMAC persistante et un verrou SQLite exclusif (`.lease.sqlite`). Le système libère le verrou à la fin du processus, même après un crash ; ne jamais supprimer ce fichier pendant une exécution. Le mode `:memory:` utilise un stockage temporaire supprimé à la fermeture, sauf répertoire explicite. Ne pas supprimer `.key` : elle stabilise les empreintes par projet et signe les curseurs. Sauvegarder ensemble SQLite et le répertoire d’artefacts.

Une réservation initiale couvre le source, le plafond de réponse et 8 Kio par handle, plus 1 Kio réservé au manifeste initial. Les transformations sont limitées à la capacité restante, avec une marge pour leur manifeste ; le quota est revérifié avant publication. Les fichiers deviennent visibles après renommage puis indexation SQLite. Le quota comptabilise ces artefacts et le manifeste ; la taille physique des fichiers SQLite/WAL, des images et des journaux Docker relève du stockage de l’hôte. Le cache compte également dans le quota global ; chaque entrée réserve 8 Kio de marge pour ses métadonnées. L’éviction libère les copies du cache sans toucher aux sources des handles actifs.

La rétention commence à la publication (24 h par défaut). La purge s’exécute au démarrage, à l’admission, lors d’un accès expiré et au plus toutes les 60 secondes. Un tombstone fournit `410` au propriétaire pendant 24 h après expiration, puis `404`. Les handles encore valides restent intacts.

`worker_image` désigne l’image jsluice et `offline_worker_image` l’image des cinq autres outils. Ces paramètres concernent des images locales construites par l’opérateur. Aucune image n’est téléchargée durant une analyse. Au premier traitement Docker, le superviseur récupère les conteneurs orphelins portant l’étiquette du stockage. Un nettoyage incertain bloque les nouvelles analyses et rend `/health` indisponible. Après résolution du problème Docker, redémarrer le service avec le même stockage pour reprendre la récupération. Les erreurs brutes du worker et du démon sont supprimées.

## Contrats et vérifications

`packages/contracts/schema.json` est la source canonique des structures JSON. `pnpm contracts:generate` produit OpenAPI 3.1.1 et les types TypeScript. `pnpm contracts:check` refuse un artefact généré périmé. Modifier directement les fichiers générés est inutile : ils seront remplacés.

JSON Schema contrôle les structures, types, enums et bornes. `validateContract` complète ces règles pour compter les octets UTF-8, refuser les caractères de substitution isolés et vérifier les relations entre statuts, couverture, preuves et références. OpenAPI seul ne peut pas exprimer ces contraintes transversales. Les exemples de la référence API sont également testés.

| Commande | Vérification |
| --- | --- |
| `pnpm check` | Biome, génération à jour, OpenAPI, compilation, types et tests |
| `pnpm lint` | Lint, format et ordre des imports ; avertissements refusés |
| `pnpm lint:fix` | Corrections automatiques sûres de Biome |
| `pnpm format` | Formatage automatique |
| `pnpm build` | Compilation des trois packages |
| `pnpm typecheck` | Types des trois packages |
| `pnpm test` | Tests sur le code compilé ; exécuter `pnpm build` avant |
| `pnpm worker:build` | Construction des deux images de workers |
| `pnpm test:qualification` | Tests du scoring et des contrôles du banc |
| `pnpm qualify` | Mesures du corpus ; requiert `pnpm qualify:build` et les workers de production |
| `pnpm qualify:stress` | Bundle contrôlé de 2 Mio, ressources et lectures bornées |
| `pnpm qualify:clean` | Installation verrouillée dans un workspace temporaire et parcours HTTP complet |
| `pnpm storage:purge` | Purge hors ligne des expirés ; exige un stockage existant et disponible |
| `pnpm test:workers` | Intégration Docker réelle, extraction et cycle de vie ; requiert le build Node et l’image |
| `docker build --platform linux/amd64 --target validate -t jsminer:validation .` | Installation verrouillée et vérifications sur Linux amd64 |

Biome **2.5.14** est épinglé avec le preset `recommended`. Sa [configuration](https://biomejs.dev/guides/configure-biome/) est dans `biome.json` : code, tests, scripts JavaScript et JSON du service sont contrôlés. Le workspace documentaire, les sorties compilées, les fichiers privés `.local/` et les dépendances sont exclus. Les types et OpenAPI générés restent contrôlés par `contracts:check`, sans reformatage par Biome. La CI et le Dockerfile exécutent `pnpm check`, donc le lint y est bloquant.

## Plateformes et déploiement

Le socle est vérifié sur macOS arm64 et sur Linux amd64 dans Docker, ce dernier étant émulé sur la machine de développement. Linux amd64, instance unique et stockage local privé, est la cible initiale. Windows, Linux arm64 et la performance native Linux ne sont pas qualifiés.

Le Dockerfile sert à qualifier le socle ; son étage `runtime` utilise un utilisateur non privilégié, mais conserve les dépendances de développement. Ce n’est pas encore une image d’exploitation du moteur. Le service de phase 5 se lance sur l’hôte avec Docker disponible. Le Dockerfile racine ne fournit pas de client Docker et ne suffit donc pas à déployer le moteur complet. Les deux images de workers possèdent leurs Dockerfiles séparés. Tout accès distant passe par un proxy TLS privé ; ne transmettre les jetons en HTTP clair que sur la boucle locale.

Le [rapport de phase 5](/reference/phase-5-validation/) mesure le corpus et le parcours depuis un workspace propre ; le [guide d’exploitation](/guides/operations/) couvre diagnostic, arrêt et purge. Le [rapport de phase 4](/reference/phase-4-validation/) consigne les tests d’acquisition et de cache. Le [rapport de phase 3](/reference/phase-3-validation/) consigne les versions, les tests du profil complet et ses limites. Le [rapport de phase 2](/reference/phase-2-validation/) documente le socle du parcours hors ligne. Le [rapport de phase 1](/reference/phase-1-validation/) décrit les vérifications réalisées et les conditions de compatibilité avec le hash Fingerprinter.

La vérification amont est séparée de la CI Node.js et ne nécessite pas de navigateur : avec Python 3.12+, Go compatible avec le `go.mod` amont et les dépendances Go déjà en cache, exécuter `python3 scripts/verify-fingerprinter-hash.py /chemin/vers/Fingerprinter`. Le dépôt amont doit être propre ; le script exige le commit consigné dans les fixtures, le teste dans un répertoire temporaire et affiche le commit vérifié et ne modifie pas le dépôt original. Une nouvelle version doit être comparée au commit consigné dans les fixtures avant de mettre à jour la preuve.

## Workers de phase 3

L’image `jsminer-offline:phase3` contient webcrack 2.16.0, Wakaru 1.12.0, TruffleHog 3.97.9, `@babel/parser` 7.29.9 et `graphql` 17.0.2. Le lockfile npm du worker est indépendant du workspace pnpm : `npm ci` s’exécute lors de la construction de l’image. Les archives TruffleHog Linux arm64/amd64 ont un SHA-256 fixé dans le Dockerfile. Le superviseur vérifie la version composite `webcrack2.16.0-wakaru1.12.0-trufflehog3.97.9-static2` et le protocole 1 avant chaque démarrage.

Les conteneurs disposent uniquement d’un `/tmp` en mémoire de 128 Mio, sans exécution de fichiers depuis ce volume. Aucun fichier hôte n’est monté. Le contenu entre sur stdin ; les sources transformées reviennent en base64 dans une enveloppe JSON bornée, jamais dans `POST /analyze`. Le service vérifie encodage, chemins, doublons et budgets avant import. Les noms de modules sont internes (`modules/m0.js`, etc.), sans conserver les chemins arbitraires générés par les outils.

Le moteur exécute séquentiellement les transformations puis les extracteurs. Un conteneur traite un module par invocation ; le coût de démarrage et de nettoyage consomme le délai disponible pour le module suivant. Cette première implémentation privilégie les budgets explicites ; elle n’exploite pas encore le plafond de deux workers simultanés. Un gros bundle peut donc donner une couverture partielle même sans erreur de syntaxe.


## Acquisition URL et cache

Ajouter à la configuration les origines exactes à autoriser (protocole, hôte et port) :

```json
{
  "capture": {
    "origins": [{ "origin": "https://assets.example.com", "allow_private": false }],
    "wire_bytes": 10485760
  },
  "cache": {
    "enabled": true,
    "retention_ms": 86400000,
    "max_bytes": 268435456
  }
}
```

Ce fragment complète la configuration existante ; il ne remplace pas `database` et `tokens`. Les valeurs présentées sont celles par défaut, sauf `origins` qui est vide par défaut. Une origine ne contient ni chemin, ni identifiants, ni query, ni fragment ; une barre finale est acceptée. Les permissions de capture sont communes aux projets de cette instance. Tous les détenteurs des droits d’analyse peuvent utiliser les origines configurées.

`allow_private: false` exige des adresses publiques : toutes les réponses DNS sont vérifiées, puis une adresse est fixée pour la connexion. Les plages privées, locales, de métadonnées, réservées et de transition IPv6 sont refusées. `allow_private: true` est une dérogation opérateur pour cette origine exacte, par exemple un serveur de fixture sur la boucle locale ; elle autorise également les adresses internes et link-local. Aucun champ de la requête d’analyse ne peut activer cette dérogation. Les chemins sont refusés même lorsque leur normalisation donnerait `/`. Le nom d’origine reste utilisé pour `Host` et la vérification TLS.

Une annulation attend la fermeture de la requête, de la socket et du flux avant de libérer l’analyse. Les changements de protocole sont refusés explicitement. La capture fait un seul GET, sans navigateur, cookie, authentification distante, proxy d’environnement ou redirection. Seul le statut 200 est accepté. `gzip`, `deflate` et `br` sont décompressés en flux ; les encodages empilés ne sont pas pris en charge. `capture.wire_bytes` borne le corps reçu avant décompression (10 Mio maximum), et `budgets.script_bytes` borne les octets décodés. Les en-têtes sont limités à 16 Kio. Un corps vide, HTML/XML manifeste, un UTF-8 invalide ou un charset déclaré incompatible est rejeté. Un MIME absent ou atypique est accepté si le corps satisfait ces contrôles.

Le cache est activé par défaut, avec un plafond de 256 Mio pris sur le quota global. Il peut être désactivé ou réduit ; sa rétention ne peut dépasser 24 h. Seules les sorties complètes et validées sont conservées. Les règles et options sont fixées dans les images : reconstruire une image change son ID Docker, donc les clés du cache, même si son tag ne change pas. Les images doivent rester disponibles pour vérifier leur identité, même sur un hit.

La capacité maximale du handle en cours est réservée avant les workers. Les copies du cache sont évincées, de la plus ancienne à la plus récente, pour respecter cette réservation. Si la place restante ne permet pas une nouvelle entrée, le résultat est servi sans ajout au cache. Les handles utilisent leurs propres copies des sources. Un cache absent, expiré ou corrompu entraîne un recalcul. Une lecture ne prolonge pas sa durée de vie. Le verrou du stockage et l’admission unique interdisent les publications concurrentes sur cette instance ; le partage du répertoire entre plusieurs serveurs n’est pas pris en charge.
