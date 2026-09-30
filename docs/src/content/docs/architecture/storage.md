---
title: Cache et sources
description: Identité du contenu, cache des traitements, handles et accès borné aux artefacts.
---

## Deux identités distinctes

`script_hash` identifie les octets de l’entrée : `sha256:` suivi de 64 caractères hexadécimaux minuscules. Pour `content`, ce sont les octets UTF-8 de la chaîne après décodage JSON. Pour `url`, ce sont les octets du corps après décompression HTTP. La v0.1 exige un UTF-8 valide et conserve fins de ligne, BOM et espaces. Aucune mise en forme ne précède le hash.

La convention Fingerprinter a été vérifiée au commit `32142b243f02b45432d79ac31d2dc223eb20e7f3` : SHA-256 hexadécimal minuscule **sans préfixe**, calculé sur le **corps CDP complet**, après `Network.getResponseBody` et décodage base64 éventuel. La branche texte utilise les octets UTF-8 de la chaîne déjà décodée par Chrome. Le code Go ne retire pas de BOM et ne normalise pas les fins de ligne ; le navigateur a toutefois pu transformer le contenu avant CDP. Voir les [preuves et limites](/reference/phase-1-validation/#fingerprinter--convention-vérifiée).

La limite de 2 MiB reste réservée aux détecteurs et n’intervient plus dans le hash des scripts. Fingerprinter exige un chargement signalé terminé et omet le hash en cas de corps vide, d’échec, d’annulation ou de dépassement de sa limite de hash de **32 MiB**. Il ne publie jamais volontairement le hash d’un préfixe. CDP ne fournit cependant pas de preuve de complétude du corps retourné.

**Décision : conserver le hash intégral de JSMiner.** Le client ajoute `sha256:` à un hash Fingerprinter disponible pour en faire une assertion sur les octets soumis. JSMiner conserve son plafond d’entrée de 10 MiB et recalcule le hash. Sans hash amont, ou si l’identité des octets n’est pas établie, le client peut omettre le champ facultatif `script_hash`. L’ancienne convention tronquée, antérieure au correctif, ne doit pas être réutilisée comme identité de contenu complet ; les anciens hashes nécessitent une nouvelle capture ou doivent être ignorés.

Un hash fourni reste une assertion contrôlée par recalcul, jamais une preuve d’autorisation ni un moyen de lire le cache sans fournir l’entrée. Le serveur répond `409 script_hash_mismatch` si les octets diffèrent, avant toute consultation du cache.

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

L’implémentation utilise un HMAC propre au projet sur un tableau JSON ordonné `step-cache-v1` / `normalization-v4`. L’identité Docker contient le digest local immuable, le protocole, la version et les options du superviseur ; le digest inclut les règles et options embarquées dans l’image. Le contenu exact de l’enveloppe, la filiation de transformation et les budgets de traitement complètent cette identité.

Le hash seul ne suffit pas : une mise à jour d’un outil peut produire d’autres observations sur les mêmes octets.

## Cache en deux niveaux

Le cache des étapes conserve des résultats statiques indépendants du contexte de navigation. Une extraction sur un module transformé utilise le hash de ce module et l’identité de sa transformation. Les clés sont calculées par étape, indépendamment des autres outils demandés ; les domaines de référence sont triés avant sérialisation.

Le plan ordonné des transformations et l’entrée effective font aussi partie de l’identité. Wakaru sur `webcrack/bundle.js` et Wakaru sur l’original après un repli ne partagent pas la même clé d’étape. Les versions de détecteurs, règles et options hors ligne de TruffleHog participent à sa clé d’extraction.

La vue exposée au client ajoute `base_url`, les domaines de référence, le projet propriétaire et les règles de masquage. Deux requêtes portant sur les mêmes octets mais des bases URL différentes peuvent réutiliser l’extraction brute ; elles recalculent les URL résolues. Le détecteur `domains` inclut la liste de référence dans sa propre clé : modifier cette liste relance ce détecteur, mais conserve les autres extractions compatibles. Elles ne partagent pas aveuglément une réponse finale.

En mode URL, l’entrée doit être acquise avant de savoir si son contenu est en cache. Une revalidation HTTP est un mécanisme séparé, reporté après la v0.1.

## Succès, échecs et concurrence

Les étapes terminées avec succès peuvent être réutilisées. Un échec, un timeout ou une sortie tronquée n’est pas mémorisé comme un succès complet. Une nouvelle requête retente les étapes incomplètes ; les réussites indépendantes restent réutilisables.

La publication passe par un répertoire temporaire, un manifeste validé et une transaction de métadonnées. Une clé en cours de traitement est protégée contre les écritures concurrentes. Une entrée est publiée par fichier temporaire, renommage puis insertion SQLite atomique sous le verrou exclusif du stockage. Les fichiers non indexés sont nettoyés au redémarrage. Avant réutilisation, la taille et le SHA-256 sont comparés aux métadonnées, puis le protocole de sortie est validé à nouveau. Une entrée absente ou corrompue est recalculée. Les copies du cache restent privées (`0600`) et peuvent contenir des secrets bruts ; seule la vue masquée est exposée par l’analyse.

## Handles et manifeste

Un `handle` est un identifiant aléatoire opaque rattaché au projet authentifié. Il ne contient ni chemin local ni secret ; le connaître ne donne pas de droit supplémentaire. Chaque requête crée un nouveau handle, même sur cache. Le manifeste est immuable jusqu’à expiration.

Exemples de chemins logiques :

```text
original/bundle.js
webcrack/bundle.js
webcrack/modules/m0.js
wakaru/modules/m0.js
```

Chaque entrée possède un chemin logique, une origine, un hash, une taille, un nombre de lignes et un `parent_path` vers son entrée de transformation (`null` pour l’original). Le parent est conservé tant que le handle est valide. Les noms suggérés par les outils peuvent être conservés pour l’affichage ; ils ne deviennent pas directement des chemins du stockage.

Les chemins API sont comparés au manifeste après un décodage unique contrôlé. Chemins absolus, segments `.` ou `..`, séparateurs ambigus et octets nuls sont refusés. Une lecture ne suit aucun lien symbolique et ne peut pas sortir du répertoire autorisé.

## Rétention et confidentialité

Valeurs par défaut : expiration fixe après 24 heures pour les handles, rétention maximale de 24 heures après création pour les entrées de cache, quota local global de 1 GiB à ajuster. Une lecture ne prolonge pas un handle. Une entrée du cache peut être évincée ; les artefacts d’un handle valide sont conservés séparément jusqu’à son expiration.

La capacité est réservée avant admission. Si le quota est insuffisant, la requête est refusée plutôt que d’invalider silencieusement un handle actif. Aucune route de suppression administrative n’est exposée en v0.1.

La purge supprime sources, résultats sensibles, index et temporaires devenus inutiles. Un tombstone minimal permet de répondre `410` au propriétaire pendant 24 heures supplémentaires ; ensuite, `404`. Les consultations interprojets retournent toujours `404`.

Les résultats et sources utilisent `Cache-Control: no-store` pour les caches HTTP. Le cache interne reste privé. Le droit `analysis:read` donne accès aux résultats masqués ; `source:read` donne accès aux sources qui peuvent contenir les valeurs originales. Les journaux excluent corps de scripts, secrets et valeurs de paramètres URL. Un agent consommateur traite le texte des sources comme une donnée, même lorsqu’il contient des instructions apparentes.
