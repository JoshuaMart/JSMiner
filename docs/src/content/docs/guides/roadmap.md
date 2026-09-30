---
title: Feuille de route
description: Plan de développement avec sous-étapes à cocher, jalons de validation et décisions ouvertes.
---

## Suivi du développement

Les cases suivent l’avancement réel : une sous-étape est cochée lorsque son livrable est disponible et vérifié. Un jalon n’est coché qu’après validation de tous ses critères, avec une référence au commit ou au rapport correspondant. Tous les jalons de développement sont ouverts au démarrage.

Les jalons J1 à J5 sont ordonnés : le jalon précédent est requis pour valider le suivant. Les budgets restent provisoires jusqu’aux mesures de J5. Les cases se mettent à jour dans ce fichier Markdown.

## 1. Stabiliser les contrats

### 1.1. Préparer le socle

- [ ] Créer les espaces du service TypeScript, des adaptateurs et des contrats, séparés du site documentaire.
- [ ] Épingler Node.js 24 et pnpm ; ajouter les commandes de développement, de compilation et de vérification des types.
- [ ] Valider le framework HTTP, le pilote SQLite et les plateformes de déploiement sur un essai minimal.
- [ ] Définir l’authentification, les droits par projet et la configuration des budgets.

### 1.2. Formaliser les échanges

- [ ] Produire OpenAPI 3.1 et les schémas JSON à partir de la [référence API](/reference/api/).
- [ ] Décrire l’exclusivité `url`/`content`, les outils, les erreurs et les statuts de couverture.
- [ ] Décrire le manifeste paginé, les parents des modules et les lectures bornées en octets UTF-8.
- [ ] Fournir des exemples valides et invalides contrôlés automatiquement par les schémas.
- [ ] Confirmer la convention de hash de Fingerprinter sur des octets connus, incluant BOM et fins de ligne.

### Jalon J1 — Contrats et socle validés

- [ ] Une installation depuis un clone propre compile le socle et passe la vérification des types.
- [ ] Les exemples attendus sont acceptés ou refusés conformément au contrat, y compris les entrées ambiguës et les outils inconnus.
- [ ] La compatibilité du hash avec Fingerprinter et les choix d’accès/déploiement sont documentés avec leurs preuves.
- [ ] **J1 validé** — renseigner le commit ou rapport de validation.

## 2. Construire le parcours hors ligne minimal

### 2.1. Traiter une entrée locale

- [ ] Implémenter `POST /analyze` en mode `content`, sa validation et son admission bornée.
- [ ] Calculer le hash et conserver `original/bundle.js` dans un stockage privé.
- [ ] Construire le superviseur et le worker jsluice avec limites de temps, mémoire, processus et sorties.
- [ ] Normaliser les endpoints et secrets, masquer les valeurs sensibles et conserver leur provenance.
- [ ] Produire les statuts par outil et par catégorie, y compris pour une extraction sans observation.

### 2.2. Publier et consulter les artefacts

- [ ] Publier atomiquement les résultats et le manifeste sous un handle lié au projet.
- [ ] Implémenter la pagination de `GET /source/:handle` et la lecture ciblée de `GET /source/:handle/:path`.
- [ ] Appliquer les droits, l’expiration des handles et la purge des artefacts sans référence.
- [ ] Vérifier l’arrêt et le nettoyage du worker après succès, erreur, annulation ou délai.

### Jalon J2 — Parcours hors ligne utilisable

- [ ] Une fixture annotée produit les observations attendues, avec des références de modules valides.
- [ ] Une fixture sans observation termine avec succès et une couverture complète des catégories demandées.
- [ ] La réponse d’analyse respecte son plafond et ne contient ni code source ni valeur brute de secret.
- [ ] La lecture UTF-8, la pagination, l’isolation entre projets et l’expiration passent les tests d’intégration.
- [ ] Aucun worker ne reste actif après les scénarios d’arrêt ; un nettoyage non confirmé empêche de nouvelles admissions.
- [ ] **J2 validé** — renseigner le commit ou rapport de validation. Le mode URL et le profil complet restent à livrer.

## 3. Ajouter les transformations et extracteurs

### 3.1. Transformer les scripts

- [ ] Intégrer webcrack dans son worker Node.js isolé, avec version et options épinglées.
- [ ] Intégrer Wakaru et la chaîne webcrack → Wakaru sur le code agrégé validé.
- [ ] Implémenter le repli de Wakaru sur l’original lorsque webcrack échoue, dans le délai global restant.
- [ ] Conserver les représentations et leurs `parent_path` ; valider les fichiers avant publication.
- [ ] Déclencher l’extraction sur l’original et les représentations disponibles avec des budgets cumulés par extracteur.

### 3.2. Compléter les observations

- [ ] Intégrer TruffleHog sur les artefacts locaux, sans réseau, sans vérification et sans recherche de mises à jour.
- [ ] Fusionner ses secrets avec ceux de jsluice en conservant empreintes, règles et preuves.
- [ ] Ajouter l’extracteur GraphQL statique et le traitement explicite des documents incomplets.
- [ ] Ajouter les sous-domaines observés, classifiés selon `reference_domains`, sans résolution DNS.
- [ ] Appliquer le profil d’outils par défaut, les sélections explicites et le regroupement déterministe.

### Jalon J3 — Profil d’analyse complet

- [ ] Les fixtures prises en charge traversent la chaîne et conservent des parents et positions cohérents.
- [ ] Un échec webcrack laisse Wakaru traiter l’original ; un délai global épuisé donne un statut explicite.
- [ ] Un détecteur en erreur n’efface pas les observations de l’autre et rend la couverture concernée partielle.
- [ ] Les fixtures synthétiques de secrets, GraphQL et domaines produisent les résultats attendus sans trafic réseau des workers.
- [ ] Les plafonds de modules, d’artefacts et de réponse sont respectés et toute perte est signalée.
- [ ] **J3 validé** — renseigner le commit ou rapport de validation.

## 4. Compléter acquisition et cache

### 4.1. Acquérir une ressource autorisée

- [ ] Implémenter le mode `url` dans le composant de capture distinct des workers.
- [ ] Appliquer la politique de destination, le refus des redirections et les limites pendant lecture/décompression.
- [ ] Rejeter les réponses vides, manifestement HTML/XML ou non UTF-8 et publier des erreurs stables.
- [ ] Comparer le hash annoncé aux octets réellement reçus avant toute réutilisation du cache.

### 4.2. Réutiliser et conserver les résultats

- [ ] Construire les clés de cache versionnées par étape, options, règles, limites et entrée effective.
- [ ] Distinguer le cache statique de la vue dépendant de `base_url`, des domaines et du projet.
- [ ] Réutiliser les étapes réussies et retenter les étapes échouées ou incomplètes.
- [ ] Protéger les publications concurrentes et vérifier l’intégrité des artefacts réutilisés.
- [ ] Appliquer les quotas globaux, la réservation de capacité, la rétention et les tombstones.

### Jalon J4 — Acquisition et cache validés

- [ ] Le serveur HTTP de fixture confirme les limites, les erreurs d’acquisition et le refus des redirections.
- [ ] Les mêmes octets à deux URL réutilisent les étapes compatibles ; un contenu ou une version/options modifiés les invalident.
- [ ] Une nouvelle `base_url` recalcule les URL résolues sans reprendre une vue finale incorrecte.
- [ ] Wakaru après webcrack et Wakaru après repli utilisent des identités de traitement distinctes.
- [ ] Les artefacts des handles actifs résistent à l’éviction du cache ; expiration et saturation de quota sont prévisibles.
- [ ] **J4 validé** — renseigner le commit ou rapport de validation.

## 5. Qualifier la v0.1

### 5.1. Mesurer la qualité et le coût

- [ ] Constituer un corpus local annoté : scripts simples, bundles autorisés, syntaxes incomplètes et chaînes dynamiques.
- [ ] Fixer avant les mesures les seuils d’acceptation de qualité par catégorie et les objectifs de ressources.
- [ ] Mesurer précision, rappel et faux positifs pour chaque catégorie.
- [ ] Comparer l’original, chaque transformateur seul et la chaîne complète ; comparer jsluice seul et avec TruffleHog.
- [ ] Mesurer temps, pic mémoire et volume d’artefacts, puis ajuster les budgets documentés.

### 5.2. Qualifier l’exploitation

- [ ] Exécuter la matrice d’intégration ci-dessous et consigner les résultats reproductibles.
- [ ] Vérifier une installation et une exécution complètes depuis un environnement propre avec les versions épinglées.
- [ ] Documenter démarrage, configuration, diagnostic, arrêt, purge et limites connues du service.
- [ ] Synchroniser OpenAPI, exemples, documentation et comportement livré.

| Axe | Cas de validation |
| --- | --- |
| Qualité | Précision, rappel et faux positifs par catégorie |
| Coût | Temps, pic mémoire, volume d’artefacts et gain de chaque transformateur |
| Complémentarité | Original, chaque transformateur seul et chaîne complète ; jsluice seul et avec TruffleHog |
| Résilience | Timeout simulé, worker en erreur, sortie invalide, disque/quota saturé |
| Arrêt | Aucun worker restant après annulation ou délai |
| Compacité | Bundle volumineux et module sur une seule ligne ; plafonds respectés |
| Contrat | JSON sans code, secrets masqués, références de modules valides |
| Accès | Handle d’un autre projet inaccessible, expiration, chemins invalides refusés |
| Transport | Acquisition sur serveur de fixture local, redirection refusée, tailles compressées/décompressées bornées |

Ces tests qualifient le service sur des données contrôlées ; ils ne nécessitent aucune requête vers les endpoints ou secrets découverts. La documentation n’avance pas de chiffres de performance avant ces mesures.

### Jalon J5 — v0.1 prête à livrer

- [ ] J1 à J4 sont validés et leurs preuves sont référencées.
- [ ] Le rapport de corpus atteint les seuils fixés ; les limites de couverture restantes sont documentées.
- [ ] Les scénarios de panne, d’arrêt, de quotas et de contrôle d’accès passent sans worker abandonné ni fuite dans les réponses/journaux.
- [ ] Le parcours complet et le guide d’exploitation sont reproductibles depuis un environnement propre.
- [ ] **J5 validé** — renseigner le commit et le rapport de qualification avant de préparer la livraison v0.1.

## Extensions après la v0.1

Ces pistes n’entrent pas dans les critères de livraison de J5. Chaque extension conserve les invariants de provenance, de compacité et de contrôle des ressources.

- [ ] Définir un format explicite pour les source maps embarquées ou jointes.
- [ ] Ajouter des imports de captures HAR/Burp vers le contrat d’analyse.
- [ ] Permettre la comparaison de résultats entre versions d’un bundle.
- [ ] Paginer les observations au-delà de la réponse compacte.
- [ ] Définir des jobs asynchrones persistants et leur cycle de vie.

## Décision retenue

**TypeScript pour le service**, validé par le mainteneur. Le choix du langage est clos ; les détails d’exécution restent qualifiés par les essais ci-dessous.

## Décisions ouvertes

| Sujet | Proposition actuelle | Élément attendu |
| --- | --- | --- |
| Runtime du service | Node.js 24 pour l’API, l’orchestration et le worker webcrack isolé | Essai HTTP, stockage et supervision ; versions épinglées (J1) |
| Framework HTTP | Fastify | Essai du schéma et des limites de corps (J1) |
| Profil de transformation | webcrack → Wakaru par défaut, repli sur l’original | Mesure de la chaîne et de chaque outil seul sur corpus |
| Détection des secrets | TruffleHog hors ligne, complété par jsluice | Précision, rappel, coût et normalisation des sorties |
| Authentification | Instance privée, droits par projet | Contexte de déploiement et gestion des identités |
| Stockage | SQLite et fichiers privés | Volume et concurrence réellement nécessaires |
| Hash Fingerprinter | SHA-256 des octets analysés | Contrat du composant amont |
| Source maps | Après v0.1, fournies ou embarquées | Format d’entrée auxiliaire explicite |

Une décision devient acceptée lorsqu’elle est consignée dans la documentation avec ses conséquences ; une fonctionnalité devient implémentée lorsque ses critères de validation passent.
