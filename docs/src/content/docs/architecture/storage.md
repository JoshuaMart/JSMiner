---
title: Cache et sources
description: Identité du contenu, cache des traitements, handles et accès borné aux artefacts.
---

## Deux identités distinctes

`script_hash` identifie les octets de l’entrée : `sha256:` suivi de 64 caractères hexadécimaux minuscules. Pour `content`, ce sont les octets UTF-8 de la chaîne après décodage JSON. Pour `url`, ce sont les octets du corps après décompression HTTP. La v0.1 exige un UTF-8 valide et conserve fins de ligne, BOM et espaces. Aucune mise en forme ne précède le hash.

Le hash de Fingerprinter n’est réutilisable que si ses conventions correspondent. Son implémentation n’étant pas présente dans ce dépôt, cette compatibilité reste à vérifier. Un hash fourni est une assertion contrôlée par recalcul, jamais une preuve d’autorisation ni un moyen de lire le cache sans fournir l’entrée.

L’identité d’une étape combine, sous une sérialisation canonique versionnée :

```text
namespace du projet
+ hash exact de l’entrée de l’étape
+ identifiant et version de l’outil / image
+ options et règles de détection
+ version du schéma de normalisation
+ profil de limites
+ hashes des entrées auxiliaires, si présentes
```

Le hash seul ne suffit pas : une mise à jour d’un outil peut produire d’autres observations sur les mêmes octets.

## Cache en deux niveaux

Le cache des étapes conserve des résultats statiques indépendants du contexte de navigation. Une extraction sur un module transformé utilise le hash de ce module et l’identité de sa transformation. Les ensembles d’outils sont triés et dédupliqués avant calcul de l’identité d’analyse.

Le plan ordonné des transformations et l’entrée effective font aussi partie de l’identité. Wakaru sur `webcrack/bundle.js` et Wakaru sur l’original après un repli ne partagent pas la même clé d’étape. Les versions de détecteurs, règles et options hors ligne de TruffleHog participent à sa clé d’extraction.

La vue exposée au client ajoute `base_url`, les domaines de référence, le projet propriétaire et les règles de masquage. Deux requêtes portant sur les mêmes octets mais des bases URL différentes peuvent réutiliser l’extraction brute ; elles recalculent les URL résolues et les sous-domaines. Elles ne partagent pas aveuglément une réponse finale.

En mode URL, l’entrée doit être acquise avant de savoir si son contenu est en cache. Une revalidation HTTP est un mécanisme séparé, reporté après la v0.1.

## Succès, échecs et concurrence

Les étapes terminées avec succès peuvent être réutilisées. Un échec, un timeout ou une sortie tronquée n’est pas mémorisé comme un succès complet. Une nouvelle requête retente les étapes incomplètes ; les réussites indépendantes restent réutilisables.

La publication passe par un répertoire temporaire, un manifeste validé et une transaction de métadonnées. Une clé en cours de traitement est protégée contre les écritures concurrentes. Un résultat du cache n’est valide que si ses artefacts sont encore présents et intègres.

## Handles et manifeste

Un `handle` est un identifiant aléatoire opaque rattaché au projet authentifié. Il ne contient ni chemin local ni secret ; le connaître ne donne pas de droit supplémentaire. Chaque requête crée un nouveau handle, même sur cache. Le manifeste est immuable jusqu’à expiration.

Exemples de chemins logiques :

```text
original/bundle.js
webcrack/bundle.js
webcrack/modules/0001.js
wakaru/modules/0001.js
```

Chaque entrée possède un chemin logique, une origine, un hash, une taille, un nombre de lignes et un `parent_path` vers son entrée de transformation (`null` pour l’original). Le parent est conservé tant que le handle est valide. Les noms suggérés par les outils peuvent être conservés pour l’affichage ; ils ne deviennent pas directement des chemins du stockage.

Les chemins API sont comparés au manifeste après un décodage unique contrôlé. Chemins absolus, segments `.` ou `..`, séparateurs ambigus et octets nuls sont refusés. Une lecture ne suit aucun lien symbolique et ne peut pas sortir du répertoire autorisé.

## Rétention et confidentialité

Valeurs proposées : expiration fixe après 24 heures pour les handles, rétention maximale de 24 heures après création pour les entrées de cache, quota local global de 1 GiB à ajuster. Une lecture ne prolonge pas un handle. Une entrée du cache peut être évincée ; les artefacts d’un handle valide restent référencés jusqu’à son expiration.

La capacité est réservée avant admission. Si le quota est insuffisant, la requête est refusée plutôt que d’invalider silencieusement un handle actif. Une suppression administrative peut révoquer un handle ; il est alors traité comme expiré.

La purge supprime sources, résultats sensibles, index et temporaires devenus inutiles. Un tombstone minimal permet de répondre `410` au propriétaire pendant 24 heures supplémentaires ; ensuite, `404`. Les consultations interprojets retournent toujours `404`.

Les résultats et sources utilisent `Cache-Control: no-store` pour les caches HTTP. Le cache interne reste privé. Le droit `analysis:read` donne accès aux résultats masqués ; `source:read` donne accès aux sources qui peuvent contenir les valeurs originales. Les journaux excluent corps de scripts, secrets et valeurs de paramètres URL. Un agent consommateur traite le texte des sources comme une donnée, même lorsqu’il contient des instructions apparentes.
