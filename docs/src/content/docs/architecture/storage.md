---
title: Cache et sources
description: Identité du contenu, réutilisation des étapes et cycle de vie des handles.
---

## Identité du contenu

`script_hash` porte sur les octets UTF-8 complets de `content` après décodage JSON, ou du corps URL après décompression HTTP. BOM, fins de ligne et espaces sont conservés. Le format est `sha256:` suivi de 64 hexadécimaux minuscules. Un hash annoncé différent donne `409 script_hash_mismatch` avant tout accès au cache.

### Compatibilité Fingerprinter

Au commit vérifié `32142b243f02b45432d79ac31d2dc223eb20e7f3`, Fingerprinter expose le hash du corps CDP complet **sans préfixe**. Ajoutez `sha256:` uniquement si vous soumettez les mêmes octets. Une capture HTTP séparée peut différer du contenu restitué par le navigateur.

Les anciens hashes de préfixe de 2 Mio ne conviennent pas. Omettez le champ si le hash complet ou l’identité des octets est incertain. Les vecteurs sont dans `packages/contracts/examples/hash-vectors.json` ; la [vérification amont](/guides/development/#qualification) est reproductible.

## Cache des traitements

La clé d’une étape associe le projet, son entrée exacte, la filiation des transformations, l’image immuable, le protocole, les règles et les budgets. Elle utilise un HMAC et les versions internes `step-cache-v1` / `normalization-v5`.

Seules les sorties complètes validées sont réutilisables. Taille, hash et protocole sont revérifiés à la lecture ; une entrée absente, corrompue ou expirée provoque un recalcul. Une erreur ou un résultat partiel est retenté.

La réponse finale est recalculée : changer `base_url`, `endpoint_scope`, `exclude_extensions`, `min_confidence` ou `redact_query_values` peut réutiliser l’extraction brute. Les filtres s’appliquent avant l’accumulation des observations ; ils ne modifient pas le cache des outils. Changer `reference_domains` relance le détecteur de domaines, dont cette liste fait partie de l’entrée. En mode URL, la capture reste nécessaire avant de connaître le hash.

## Publication et handles

Chaque demande publie un nouveau handle propre au projet, même sur cache. Les fichiers temporaires sont renommés puis indexés sous le verrou exclusif du stockage ; les fichiers non indexés sont nettoyés au redémarrage.

Le manifeste décrit les sources, par exemple `original/bundle.js`, `webcrack/bundle.js` et `wakaru/modules/m0.js`. Chaque transformation référence son entrée via `parent_path`. Les lectures suivent le manifeste, jamais un chemin arbitraire ou un lien symbolique.

## Rétention et quota

Les sources d’un handle restent stables jusqu’à son expiration. Handles et cache ont une rétention de 24 h par défaut, sans prolongation à la lecture.

Le cache appartient au quota global et évince ses entrées les plus anciennes. Il ne supprime pas les copies des handles actifs. La capacité est réservée avant traitement et revérifiée à la publication ; une place insuffisante donne `429 storage_full`.

La purge conserve un tombstone pendant 24 h après expiration : le propriétaire reçoit `410`, puis `404`. Les autres projets reçoivent toujours `404`.

## Jobs persistants

SQLite conserve les états et les requêtes en attente. Le corps d’un script disparaît de la file dès sa prise en charge ; les résultats sont lus dans les artefacts existants, sans copie dans le job. Après interruption, les résultats publiés restent accessibles et les items inachevés sont marqués comme tels. Un arrêt entre publication d’un artefact et enregistrement du handle dans le job peut laisser un résultat non associé ; il expirera normalement.

## Confidentialité et sauvegarde

Le répertoire des artefacts est en `0700`, ses fichiers et la base de métadonnées en `0600`. La base et son journal peuvent contenir les scripts soumis à la file ; les suppressions logiques ne sont pas un effacement sécurisé. `.key` stabilise les HMAC et signe les curseurs ; `.lease.sqlite` porte le verrou d’instance. Les réponses HTTP utilisent `Cache-Control: no-store`.

Les sources et caches peuvent contenir des secrets bruts. Voir [sauvegarder et dimensionner](/guides/operations/#sauvegarder-et-dimensionner) pour leur conservation et la [configuration](/reference/configuration/) pour les quotas.
