---
title: Tests et qualification
description: Reproduire le banc et comprendre la portée des mesures.
---

## Exécuter

Depuis la racine, avec Docker disponible :

```sh
pnpm check
pnpm worker:build
pnpm test:workers
pnpm qualify:build
pnpm qualify
pnpm qualify:stress
pnpm qualify:clean
```

| Étape | Vérification |
| --- | --- |
| `check` | Lint, contrats, compilation, types et tests locaux |
| `test:workers` | Outils réels et nettoyage Docker |
| `qualify:build` | Images instrumentées depuis les images de production locales |
| `qualify` | Neuf fixtures × huit profils, soit 72 analyses |
| `qualify:stress` | Bundle contrôlé de 2 Mio et lectures bornées |
| `qualify:clean` | Installation temporaire et parcours HTTP complet, avec images déjà construites |

Le workflow manuel `.github/workflows/qualification.yml` reproduit ces étapes. Les rapports vont dans `.local/qualification/`. Évitez toute autre charge Docker pendant les mesures.

Un verrou interdit deux qualifications simultanées. Les rapports commencent en échec et sont remplacés atomiquement. Après un crash non intercepté, inspectez les processus et conteneurs avant de retirer manuellement `.local/qualification/.lock`.

## Méthode

Les scripts du corpus sont synthétiques. Chaque analyse utilise un processus neuf, un stockage vide et le cache applicatif désactivé. Images, corpus et seuils sont identifiés par hash ; matrice complète et mesures valides sont obligatoires.

Les huit profils croisent original/webcrack/Wakaru/chaîne avec jsluice seul ou accompagné de TruffleHog. GraphQL et domaines restent actifs. Le scoring compte les observations uniques : précision `TP/(TP+FP)`, rappel `TP/(TP+FN)` ; un dénominateur vide donne `null`.

Les délais incluent Docker et son nettoyage. Le pic worker vient du cgroup ; le pic API du maximum RSS, hors démon Docker. Les volumes d’artefacts sont logiques. Les caches de pages et images peuvent être chauds.

## Seuils et résultats

`qualification/policy.json` fixe les seuils avant mesure. La qualité est exigée sur `chain-combined` ; les ressources sont contrôlées sur tous les profils. Les fixtures incomplètes restent dans le scoring mais pas dans le contrôle de réussite de tous les outils. Sur les autres, seule une troncature de preuves `evidence_count` est admise si tous les outils réussissent.

| Catégorie | Seuil précision / rappel | Résultat |
| --- | --- | --- |
| Endpoints | 90 % / 85 % | 91,7 % / 100 % |
| Secrets | 100 % / 90 % | 100 % / 100 % |
| GraphQL | 100 % / 90 % | 100 % / 100 % |
| Sous-domaines | 100 % / 90 % | 100 % / 100 % |

Le rapport `qualification/results/2026-09-30.json` conserve les 72 mesures, le stress, l’annulation et l’installation propre. Il a été produit sur Apple M4 Pro/macOS arm64, Node.js 24.21.0 et Docker/OrbStack ; le socle a aussi été testé sous Linux amd64 émulé.

Les objectifs de ressources sont 90 s, 1 Gio par worker, 512 Mio pour l’API, 64 Mio d’artefacts et 256 Kio de réponse. Le seuil API est un objectif du banc, pas une limite imposée au serveur. Les [limites du corpus](/guides/limitations/#couverture-mesurée) interdisent de généraliser ces scores.

## Jobs et concurrence

`apps/api/integration/jobs.test.mjs` soumet quatre scripts synthétiques locaux (1 600 fonctions chacun) à webcrack et GraphQL, cache désactivé. Il vérifie la réponse asynchrone, les résultats individuels, une seule récupération initiale Docker et l’absence de conteneurs résiduels.

Mesure locale du 1er octobre 2026, macOS arm64 avec Docker :

| Analyses simultanées | Premier résultat | Lot terminé | Pic de conteneurs |
| --- | ---: | ---: | ---: |
| 1 | 1,24 s | 4,07 s | 1 |
| 2 | 1,03 s | 2,05 s | 2 |

Il s’agit d’un essai fonctionnel unique, sans cache applicatif ; les images étaient déjà disponibles. Il ne mesure pas le pic mémoire réel et ne prédit pas le gain sur des bundles obfusqués. Chaque conteneur avait un plafond de 2 Gio, avec une enveloppe totale configurée de 4 Gio. Le défaut reste une analyse simultanée.
