---
title: Vision et périmètre
description: Objectifs, invariants et périmètre de la première version de JSMiner.
---

## Objectif

Faciliter la revue de scripts appartenant à une application auditée : transformer des bundles volumineux en résultats consultables, traçables et limités en taille. Un consommateur humain ou logiciel doit pouvoir retrouver le module qui justifie chaque observation sans recevoir tout le bundle dans son contexte.

Une chaîne trouvée dans un script est une **observation statique**. Elle ne prouve ni qu’un endpoint existe encore, ni qu’un secret fonctionne, ni qu’un sous-domaine répond.

## Invariants issus du besoin

- `POST /analyze` accepte exactement une entrée parmi `url` et `content`, ainsi qu’une sélection `tools`.
- La réponse contient `endpoints`, `secrets`, `gql_operations`, `subdomains` et un `handle`.
- La réponse d’analyse ne contient aucun code source, déplié ou original, ni sortie brute d’un outil.
- La consultation des sources passe par un manifeste, puis par un module précis.
- Le hash Fingerprinter du corps CDP complet peut servir d’assertion, après adaptation du préfixe ; JSMiner le vérifie toujours sur les octets réellement analysés.
- Chaque outil dispose de limites propres ; ses erreurs sont rapportées individuellement.

## Périmètre proposé pour la v0.1

Une requête traite un script. Le mode `content` est prioritaire pour réutiliser une capture existante. Le mode `url` acquiert une ressource explicitement autorisée par la configuration du service. L’analyse fonctionne ensuite hors réseau.

Le moteur conserve l’original, tente les transformations sélectionnées et extrait les informations de chaque représentation exploitable. Les doublons sont regroupés sans perdre leur provenance. GraphQL et les domaines reposent sur des extracteurs internes identifiés dans le contrat.

Le déploiement initial vise une instance privée à concurrence bornée. Astro sert la documentation ; l’API et les workers forment des composants distincts.

## Hors périmètre initial

Le service ne parcourt pas automatiquement les endpoints ou chunks découverts, ne teste pas les secrets et n’exécute pas l’application dans un navigateur. Il ne réalise ni introspection GraphQL distante, ni résolution DNS des résultats, ni recherche de fichiers `.map` par supposition. Les imports HAR/Burp, l’analyse par lots et les tâches asynchrones persistantes sont des extensions possibles.

Les source maps embarquées pourront être inspectées lors d’un incrément ultérieur. Leur récupération distante ne doit pas devenir un effet implicite de l’analyse d’un script.

## Critères de réussite

| Besoin | Critère observable |
| --- | --- |
| Préserver le contexte | Réponse bornée, sans source ni extrait ; lecture ciblée des modules |
| Résister à un outil défaillant | Résultats partiels conservés et état de chaque outil présent |
| Reproduire une analyse | Hash, versions, options, règles et limites enregistrés |
| Retrouver une observation | Référence vers un module et position lorsque disponible |
| Maîtriser les ressources | Temps, mémoire, processus, fichiers et sortie bornés |
| Mesurer l’utilité | Corpus local annoté, précision et rappel par catégorie, coût par outil |

Les budgets documentés sont des valeurs de départ à mesurer, pas des performances déjà démontrées.
