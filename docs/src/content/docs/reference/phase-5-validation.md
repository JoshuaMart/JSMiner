---
title: Qualification de phase 5
description: Corpus annoté, mesures de qualité et ressources, et validation du parcours d’exploitation v0.1.
---

## Périmètre et preuves

Qualification locale du **30 septembre 2026** du moteur issu de `bdb1980` (J4), sur **Apple M4 Pro, 14 cœurs, 48 Gio de RAM, macOS arm64, Node.js 24.21.0 et Docker/OrbStack**. Les vérifications du socle sont également exécutées sous Linux amd64. Les [rapports J1](/reference/phase-1-validation/), [J2](/reference/phase-2-validation/), [J3](/reference/phase-3-validation/) et [J4](/reference/phase-4-validation/) restent les preuves des incréments précédents.

Les seuils ont été fixés dans `qualification/policy.json` **avant les mesures**. Le corpus `qualification/corpus.json` contient neuf fixtures écrites pour le projet : appels HTTP simples, fragments GraphQL, frontières de domaines/IDNA, secret GitHub synthétique, bundle webpack contrôlé, syntaxe incomplète, chaînes dynamiques, cas négatif et UTF-8/BOM/query. Aucun endpoint découvert n’est appelé, aucun secret n’est vérifié. Les workers restent sans réseau.

Les données mesurées sont conservées dans `qualification/results/2026-09-30.json`, avec les hashes du corpus et de la politique, les IDs des images, les 72 analyses comparées, le stress et le parcours d’installation. Le code du banc est dans `qualification/` ; les rapports d’une nouvelle exécution vont dans `.local/qualification/`.

## Qualité mesurée et seuils

Les métriques comptent les observations uniques : valeur d’endpoint après masquage, famille/empreinte du secret, type/nom d’opération GraphQL et hostname. Elles ne mesurent ni l’exactitude des méthodes/paramètres, ni la calibration de confiance, ni la validité contre un schéma GraphQL distant. Les cas incomplets et dynamiques restent dans ces mesures.

| Catégorie | Vrais positifs | Faux positifs | Manqués | Précision | Rappel | Seuil précision / rappel |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Endpoints | 11 | 1 | 0 | 91,7 % | 100 % | 90 % / 85 % |
| Secrets | 1 | 0 | 0 | 100 % | 100 % | 100 % / 90 % |
| GraphQL | 3 | 0 | 0 | 100 % | 100 % | 100 % / 90 % |
| Sous-domaines | 3 | 0 | 0 | 100 % | 100 % | 100 % / 90 % |

**Ces résultats concernent uniquement ce petit corpus synthétique.** Le test de secrets ne couvre qu’une valeur et une famille GitHub ; il ne permet pas d’estimer le rappel sur les autres familles. Le corpus ne contient pas d’application fortement obfusquée représentative d’un usage réel. Il qualifie les parcours et formats, sans démontrer une précision générale de 100 %.

Les huit profils obtiennent les mêmes comptes. Le faux positif est le préfixe littéral d’un endpoint dynamique, remonté en plus de l’expression. Il reste une observation de faible confiance à vérifier par le consommateur. Les erreurs de syntaxe et interpolations GraphQL conservent les statuts partiels attendus.

Les essais initiaux ont corrigé deux conventions du **banc**, sans modifier les seuils ni le moteur : `REDACTED` pour les valeurs de query, et l’acceptation des résultats partiels dont seule la liste des preuves est tronquée (`evidence_count`). Le cas GitHub peut avoir six preuves et en conserver cinq, conformément au contrat.

La revue a ensuite renforcé les preuves de qualification : matrice complète sans doublon, liste exacte des outils, comptes conformes aux annotations et mesures positives et finies. Les images sont résolues une fois puis exécutées par ID immuable ; les hashes du corpus et des seuils sont contrôlés dans chaque processus. Un rapport commence en échec, les écritures sont atomiques et un verrou interdit deux qualifications concurrentes. L’annulation attend la fin des processus puis nettoie leurs conteneurs. La fixture volumineuse n’est chargée que pour le stress, afin de ne pas perturber la mémoire du petit corpus. **Les 72 analyses ont été intégralement remesurées après ces corrections**, sans réutiliser de mesure initiale.

## Coût des profils

Un processus API neuf, un stockage vide et le cache applicatif désactivé sont utilisés pour chaque analyse. La durée inclut lancements et nettoyage Docker, mais pas la construction des images. Il s’agit d’un passage par cas/profil, pas de percentiles de charge en production. Les images et le cache de pages de l’OS peuvent être chauds.

Le pic worker est le maximum du cgroup de chaque conteneur, enfants et petit wrapper de mesure compris, lu via [`memory.peak`](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html). Le pic du processus API provient de [`process.resourceUsage().maxRSS`](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage). Il exclut le démon Docker. Toute mesure mémoire manquante fait échouer le contrôle. Le volume d’artefacts du tableau est le total logique des neuf analyses, marges de métadonnées comprises.

| Profil | Médiane | Maximum | Pic worker | Pic API | Artefacts, neuf cas |
| --- | ---: | ---: | ---: | ---: | ---: |
| `original-jsluice` | 1.026 s | 1.663 s | 107.5 Mio | 93.1 Mio | 90.8 Kio |
| `original-combined` | 2.302 s | 2.532 s | 416.3 Mio | 93.7 Mio | 92.7 Kio |
| `webcrack-jsluice` | 2.430 s | 3.329 s | 50.2 Mio | 93.9 Mio | 97.9 Kio |
| `webcrack-combined` | 4.927 s | 7.028 s | 387.4 Mio | 94.0 Mio | 99.9 Kio |
| `wakaru-jsluice` | 3.088 s | 3.298 s | 71.4 Mio | 93.7 Mio | 101.1 Kio |
| `wakaru-combined` | 6.786 s | 7.151 s | 387.4 Mio | 93.9 Mio | 103.1 Kio |
| `chain-jsluice` | 4.494 s | 5.241 s | 54.2 Mio | 94.0 Mio | 108.2 Kio |
| `chain-combined` | 9.525 s | 11.816 s | 393.7 Mio | 94.0 Mio | 110.1 Kio |

GraphQL et domaines restent actifs dans les huit profils. `combined` ajoute TruffleHog à jsluice ; `chain` applique webcrack puis Wakaru. Tous les extracteurs conservent aussi l’original.

Sur ce corpus, les transformations améliorent les représentations disponibles sans ajouter de découverte ; TruffleHog confirme le secret déjà trouvé par jsluice. La chaîne complète est plus coûteuse. Ce résultat ne suffit pas à supprimer ces outils du profil par défaut : leurs apports sur d’autres syntaxes et familles ne sont pas mesurés ici. Le champ `tools` permet de choisir explicitement un parcours rapide.

## Ressources et stress

Les objectifs fixés avant mesure sont : **90 s** par analyse, **1 Gio** au pic par worker, **512 Mio** au pic pour l’API du banc, **64 Mio** d’artefacts et **256 Kio** de réponse. Le seuil API est un objectif de qualification, pas une limite mémoire imposée au processus hôte.

Le test supplémentaire utilise un bundle webpack contrôlé, complété par un commentaire de **2 Mio sur une seule ligne**. Il valide l’ingestion volumineuse, les cinq modules conservés, la compacité et une lecture de source limitée à 64 Kio. Ce remplissage n’est pas un test de complexité AST équivalente à 2 Mio de logique applicative.

Résultat : **12,404 s**, **408,4 Mio** au pic worker, **139,2 Mio** au pic API, **4,01 Mio** d’artefacts logiques, **2 496 octets** de réponse. Les outils réussissent ; aucune mesure mémoire ne manque et aucun worker ne reste après traitement.

**Budgets conservés.** Le plafond worker de 1 Gio laisse une marge sur les pics observés (jusqu’à 416,3 Mio sur le corpus), mais ces quelques fixtures ne justifient pas de le réduire. Les plafonds de temps, de modules, de réponse et d’artefacts restent ceux de J4. Le quota global de 1 Gio et la rétention de 24 h conviennent à une instance de validation à analyse unique ; leur capacité réelle dépendra du volume de scripts conservés. Le [guide d’exploitation](/guides/operations/) distingue quotas logiques et espace physique.

## Exploitation et matrice de validation

| Axe | Preuve |
| --- | --- |
| Qualité / complémentarité / coût | 72 analyses, huit profils, scoring micro et mesures de chaque conteneur |
| Volume et compacité | Bundle de 2 Mio, lecture bornée, réponse JSON validée sans source |
| Pannes | Tests d’erreur/timeout/sortie invalide et quotas J2–J4 ; nouveau test de saturation réelle des pages SQLite avec rollback des artefacts puis reprise |
| Arrêt | Annulation HTTP, nettoyage Docker et arrêt du processus ; aucun conteneur abandonné dans les intégrations |
| Accès | Authentification, projets distincts, chemins, expiration et tombstones |
| Transport | Fixtures HTTP locales, limites avant/après décompression et refus des redirections |
| Purge | Commande hors ligne sous verrou, refus d’un stockage actif ou absent, conservation des handles valides |
| Installation propre | Copie dans un workspace temporaire sans dépendances/configuration, installation verrouillée, build, serveur réel, capture gzip, profil complet, hit du cache, sources, isolation des projets, arrêt et purge |

Le parcours propre utilise les images de production déjà construites depuis leurs versions/lockfiles épinglés ; il ne simule pas une installation de Docker ni une machine dépourvue de cache de téléchargement. Une nouvelle construction d’images fait partie de la procédure reproductible. Le workflow manuel `.github/workflows/qualification.yml` enchaîne ces vérifications et conserve uniquement les rapports, sans exporter les jetons.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm worker:build
pnpm test:workers
pnpm qualify:build
pnpm qualify
pnpm qualify:stress
pnpm qualify:clean
docker build --platform linux/amd64 --target validate -t jsminer:phase5-validation .
pnpm --dir docs build
```

La suite comprend **161 tests locaux** : 60 contrats, 16 adaptateurs, 78 API et 7 tests du banc, plus **14 intégrations Docker**. Le site documentaire comporte **17 pages**. Les exécutions sont consignées avec les rapports ; la qualification J5 et sa revue permettent de préparer la livraison v0.1, sans publier de version ni déployer de service.
