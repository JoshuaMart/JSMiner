---
title: Outils et inspirations
description: Capacités vérifiées des outils envisagés et idées retenues des projets existants.
---

## Méthode

Étude documentaire effectuée le 30 septembre 2026 à partir des README et de la documentation officielle des projets. Aucun benchmark ni test d’intégration n’a été exécuté. Les capacités annoncées ne constituent pas une garantie sur tous les bundles. Les versions exactes seront épinglées pendant l’essai d’intégration.

## Outils du pipeline

| Outil | Rôle documenté | Décision proposée |
| --- | --- | --- |
| [webcrack](https://github.com/j4k0xb/webcrack) | Désobfuscation de motifs obfuscator.io, déminification, dépliage webpack/Browserify | Préparation isolée avant Wakaru dans le profil par défaut |
| [Wakaru](https://github.com/pionxzh/wakaru) | Dépliage et récupération de syntaxe à partir de code minifié/transpilé ; plusieurs formats de bundles | Reconstruction après webcrack ; repli sur l’original en cas d’échec |
| [jsluice](https://github.com/BishopFox/jsluice) | Extraction Go fondée sur tree-sitter, URLs et secrets | Endpoints et détection complémentaire de secrets |
| [TruffleHog](https://github.com/trufflesecurity/trufflehog) | Détection de secrets, sources de fichiers locaux et sortie JSON ; vérification désactivable | Détecteur principal proposé, sans réseau |

Les transformateurs sont complémentaires, avec certaines capacités communes. Wakaru documente explicitement une préparation possible par webcrack pour les obfuscations prises en charge. Cela justifie le profil webcrack → Wakaru, sans promettre que chaque étape améliore chaque bundle. Le gain et le coût restent à mesurer. Le service accepte aussi une transformation sans découpage en modules.

jsluice fournit notamment méthode, noms de paramètres et contexte d’extraction ; certaines expressions inconnues sont représentées par `EXPR`. L’adaptateur doit préserver l’incertitude sans confondre une chaîne littérale avec une portion dynamique. Ses sorties peuvent inclure du code et des valeurs sensibles : elles doivent être filtrées avant la réponse publique. Aucun support natif de l’inventaire GraphQL demandé n’est supposé ; un extracteur dédié est prévu.

## Détection des secrets

Le service réutilise des moteurs existants. TruffleHog est proposé pour ses détecteurs spécialisés ; jsluice apporte l’analyse du contexte JavaScript. Leur combinaison reste à comparer sur le corpus local, notamment lorsque la vérification distante est désactivée.

[Gitleaks](https://github.com/gitleaks/gitleaks) constitue une alternative pour scanner des fichiers avec des règles configurables et produire un rapport JSON. Il reste une option de comparaison, sans ajouter un troisième détecteur au profil initial. L’adaptateur de secrets permet de remplacer un outil sans modifier la forme de `secrets[]`.

Le fonctionnement hors ligne et la fusion des preuves sont décrits dans le [modèle de résultats](/reference/results/#secrets-potentiels).

## GAP Burp Extension

[GAP](https://github.com/xnl-h4ck3r/GAP-Burp-Extension) regroupe la recherche de liens, paramètres potentiels et mots propres à une application. Ses modes peuvent être activés séparément et son usage s’appuie sur le périmètre Burp.

**Idées retenues :** conserver le lien entre endpoint, paramètres et origine ; permettre une sélection des analyses pour maîtriser leur coût. La génération de listes de mots et l’interface Burp ne sont pas nécessaires au cœur de JSMiner.

## xnLinkFinder

[xnLinkFinder](https://github.com/xnl-h4ck3r/xnLinkFinder) documente plusieurs entrées hors ligne, dont fichiers, exports Burp/ZAP/Caido et HAR. Il expose aussi des filtres de périmètre et regroupe les secrets avec leurs sources.

**Idées retenues :** provenance multiple, regroupement des doublons et séparation entre import de captures et analyse. Les imports d’archives pourront alimenter le même contrat `content`. Le crawling, les répétitions réseau et la recherche en mémoire navigateur restent hors du service initial.

## PortSwigger js-miner

[js-miner](https://github.com/PortSwigger/js-miner) distingue des analyses passives et actives. Il documente la recherche de secrets avec un signal d’entropie, de sous-domaines, d’URL cloud, d’endpoints et la reconstruction à partir de source maps.

**Idées retenues :** observations assorties d’un niveau de confiance, sous-domaines observés et prise en charge future de source maps fournies. Les recherches actives de `.map` et les vérifications auprès d’un registre ne sont pas reprises. Une URL cloud peut d’abord rester une ressource classifiée sans constituer une vulnérabilité.

## Priorités issues de l’étude

| Priorité | Proposition JSMiner | Justification |
| --- | --- | --- |
| v0.1 | Preuves sans extraits, chemins de modules | Vérifier un résultat sans grossir la réponse |
| v0.1 | Paramètres associés aux endpoints | Préserver la structure utile de l’observation |
| v0.1 | Déduplication avec toutes les origines conservables | Réduire le bruit entre représentations |
| v0.1 | Statut par outil et par catégorie | Rendre les absences interprétables |
| Après v0.1 | Source maps embarquées/fournies | Récupérer une représentation plus fidèle quand disponible |
| Après v0.1 | Import de captures | Réutiliser des données déjà collectées |

Ces choix sont une synthèse pour JSMiner, pas des fonctionnalités attribuées aux dépôts cités. Aucun code externe n’est copié dans cette documentation. Avant toute intégration ou redistribution, enregistrer le commit retenu, sa licence et les notices applicables, sans supposer qu’une idée réutilisable autorise la copie de son implémentation.
