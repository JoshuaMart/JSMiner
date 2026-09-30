---
title: Retour sur le prototype
description: Éléments utiles et changements d’architecture tirés du prototype Python fourni.
---

## Nature du matériau

Cette revue porte sur l’extrait Python fourni avec la demande, dont la docstring commence par « Bounded script retrieval through capture, then offline static analysis. ». Il s’agit d’une lecture du code, sans exécution. Les dépendances `mapta`, l’image `mapta-jsanalysis:dev`, le code du worker et Fingerprinter ne sont pas présents dans ce dépôt.

L’extrait orchestre la récupération et l’analyse de plusieurs scripts dans un scan. Il ne constitue pas encore le moteur d’extraction ni le contrat HTTP de JSMiner.

## Éléments à conserver

| Élément observé | Intérêt pour JSMiner |
| --- | --- |
| `fetch_asset` et `context.can_request` | Séparer acquisition autorisée et traitement local |
| Lecture `max_bytes + 1` et délai de capture | Détecter les dépassements sans télécharger sans limite |
| Refus des redirections dans le runner | Éviter une destination finale implicite |
| Worker sans réseau, quotas et système en lecture seule | Limiter le périmètre du traitement |
| Bloc `finally` et vérification de suppression | Ne pas abandonner un calcul après timeout |
| Écriture des découvertes à chaque étape | Préserver les résultats déjà acquis |
| Limites de scripts, tentatives et candidats | Distinguer quantité de succès et quantité de travail |
| Extraction des noms de paramètres | Conserver des informations structurées utiles |

## Adaptations nécessaires

### Identité du cache

Le répertoire `scripts/<hash>` est calculé à partir de l’URL, tronqué à 16 caractères hexadécimaux. Il sert au classement des fichiers ; ce n’est pas un cache par contenu. Deux URL peuvent héberger les mêmes octets, et une URL peut changer. JSMiner doit conserver le SHA-256 complet du script ainsi qu’une identité de traitement versionnée.

### Frontière du worker

L’extrait impose un délai au conteneur global, mais ne démontre pas de budget propre à chaque outil. Le code du worker n’étant pas fourni, sa stratégie reste inconnue. La v0.1 doit exposer la réussite, le timeout ou l’erreur de chaque traitement, puis agréger les résultats valides.

Le montage `/work:ro` est cohérent pour l’entrée ; un service de consultation de modules doit aussi prévoir une sortie bornée et validée. Un JSON sur stdout contenant le code déplié serait incompatible avec le contrat compact.

### Source maps

`source_map` recherche une directive, puis essaie un fichier `.map` adjacent en son absence. Cette seconde étape ajoute une requête par supposition. La première version de JSMiner conserve une acquisition explicite d’un seul script ; les maps embarquées ou fournies seront traitées séparément.

Le prototype vérifie la version 3 et la présence de `sourcesContent`. Une future intégration devra aussi borner le nombre de sources et leur taille cumulée, traiter les entrées `null`, éviter les chemins sortant du stockage et ne pas promettre un source original quand la map ne contient que des correspondances de positions. Le contrôle après décodage base64 mérite aussi un contrôle préalable de taille encodée.

### Exploration et couplage au scan

Les boucles sur `chunks`, `appBases` et `scripts` réinjectent des candidats dans une file. La construction de `remote-entry.js` et le traitement des routes appartiennent à l’orchestration du scan. Les séparer permet à JSMiner d’analyser une entrée sans déclencher d’exploration supplémentaire.

De même, `add_surface` et les écritures SQL sont spécifiques à MAPTA. JSMiner produit des observations ; l’application appelante décide comment les stocker dans son inventaire.

### Contrat et erreurs

Le test `modules >= 1` peut exclure un script ordinaire pourtant exploitable. Conserver systématiquement `original/bundle.js` règle cette ambiguïté. Les exceptions Python doivent devenir des codes stables et des statuts par étape, sans fuite de stdout ou de chemins locaux.

Le prototype distingue déjà `JSAnalysisCleanupError` des erreurs ordinaires. Cette distinction est pertinente : un arrêt non vérifié peut compromettre la maîtrise des ressources du service entier.

### Résolution des URL

Le helper `_url` résout souvent les chemins avec `context.target`. Un service indépendant ne connaît pas nécessairement ce document de référence. Le contrat introduit donc `base_url` explicitement et conserve les chemins non résolus quand cette information manque. Les URL relatives au protocole sont traitées comme des observations à normaliser, sans acquisition automatique.

## Ce qui reste à vérifier

Le calcul réel du hash dans Fingerprinter, les protections réseau de `context.can_request`, le contenu de l’image d’analyse et les schémas exacts de ses résultats ne peuvent pas être déduits de cet extrait. Ils devront être documentés avant de déclarer une compatibilité avec MAPTA.
