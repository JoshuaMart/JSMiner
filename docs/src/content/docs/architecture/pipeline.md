---
title: Pipeline et isolation
description: Acquisition, traitements indépendants, budgets et gestion des résultats partiels.
---

## TypeScript et runtimes

**TypeScript et Node.js 24 sont retenus pour l’API et l’orchestration.** Le socle Node.js 24.21.0, Fastify et SQLite a passé l’essai HTTP/stockage de [phase 1](/reference/phase-1-validation/). La vérification de types `tsc --noEmit` fait partie de `pnpm check`. Le worker Node.js et sa supervision sont vérifiés par les fixtures de [phase 3](/reference/phase-3-validation/).

Le [README de webcrack](https://github.com/j4k0xb/webcrack) annonce Node.js 22/24 et une dépendance à `isolated-vm`. Utiliser Node.js 24 pour l’API et ce worker limite le nombre de runtimes JavaScript à maintenir et à qualifier. Le worker reste un processus isolé : l’API le pilote au travers du même contrat d’artefacts que les autres outils.

Wakaru utilise un binaire autonome ; jsluice et TruffleHog sont également invoqués comme outils externes isolés. Les versions et options sont épinglées dans les workers. Le site documentaire conserve son environnement Astro/pnpm actuel ; pnpm 10.33.0 est épinglé pour le service. Un autre runtime pourra être réévalué si les mesures mettent en évidence un besoin concret.

## Responsabilités

```text
Client / capture Fingerprinter
             |
       API : validation, admission, autorisation
             |
       content OU acquisition URL bornée
             |
       octets immuables + hash vérifié
             |
       cache des étapes compatibles
             |
       original conservé et analysable
             |
       webcrack : désobfuscation / dépliage
             |
       code validé, sinon original
             |
       Wakaru : reconstruction / dépliage
             |
       original + représentations conservées
             |
       jsluice / TruffleHog / GraphQL / domaines
                    |
       normalisation, regroupement, masquage
                    |
       résultats compacts + manifeste + handle
```

webcrack et Wakaru sont complémentaires, avec un recouvrement sur le dépliage et la déminification. Le premier traite notamment certaines obfuscations ; le second récupère une syntaxe lisible à partir de code minifié ou transpilé. [Wakaru documente la possibilité de préparer son entrée avec webcrack](https://github.com/pionxzh/wakaru#works-with-other-tools).

Le profil par défaut sélectionne les deux. Lorsque les deux sont demandés, webcrack traite l’original, puis Wakaru reçoit son code agrégé validé et non vide, conservé sous `webcrack/bundle.js`. Wakaru n’est pas relancé séparément sur chaque module de webcrack. Si webcrack échoue ou ne produit aucun code agrégé utilisable, Wakaru reçoit l’original et l’avertissement `fallback_to_original` est enregistré. Le repli reste soumis au délai global ; si ce délai est épuisé, Wakaru est `skipped` avec `global_deadline`.

Si un seul transformateur est sélectionné, il reçoit l’original. Chaque outil conserve son propre budget et son état ; l’échec de webcrack n’annule donc pas Wakaru. Les options de génération doivent préserver un JavaScript accepté par l’étape suivante ; les cas JSX et syntaxes particulières font partie de l’essai d’intégration.

L’extraction sur l’original reste disponible même si tous les transformateurs échouent. Les représentations produites ensuite sont analysées dans le budget restant. Un fichier JavaScript ordinaire constitue un module `original/bundle.js` même si aucun bundle n’a pu être déplié.

Les transformations précèdent les extracteurs et les modules sont traités séquentiellement. L’original reste le premier module fourni à chaque extracteur. TruffleHog est proposé pour la détection principale des secrets, avec les matchers JavaScript de jsluice en complément. Ils examinent uniquement les fichiers de l’analyse en cours ; leurs résultats sont regroupés avec leur provenance. Le [modèle de résultats](/reference/results/#secrets-potentiels) précise ce partage.

## Acquisition

Le mode `content` fournit une chaîne UTF-8. Le mode `url` utilise un composant de capture distinct, sans navigateur, limité à HTTP(S) et aux destinations autorisées côté serveur. La configuration traite explicitement les adresses internes, locales et de métadonnées ; un paramètre utilisateur ne peut pas élargir ces droits.

Les redirections sont refusées en v0.1. La destination réseau effectivement utilisée est contrôlée, y compris lors de la résolution DNS. Les tailles sont bornées pendant la lecture et après décompression ; `Content-Length` reste indicatif. Une réponse HTML/XML manifeste, un corps vide ou un encodage non UTF-8 est refusé. Un type MIME atypique peut produire un avertissement sans suffire à rejeter un script valide.

Une URL trouvée dans le script est une donnée. Elle ne déclenche aucune requête. L’acquisition d’une source map distante est hors du pipeline initial.

## Adaptateurs

Chaque adaptateur annonce son identifiant, sa version, ses capacités, ses options normalisées et sa version de schéma de sortie. Il reçoit uniquement les fichiers nécessaires et écrit dans un espace dédié. Le superviseur valide le manifeste et les résultats avant publication.

Les sorties standard et d’erreur sont bornées. Les objets JSON d’un outil externe ne sont jamais transmis directement à l’API. Les adaptateurs retirent les champs de code ou de contexte présents dans certaines sorties.

## Budgets proposés

Valeurs initiales configurées par l’opérateur. `MiB` signifie 1 048 576 octets.

| Ressource | Valeur initiale |
| --- | --- |
| Script, après décodage du transport | 10 MiB |
| Corps JSON HTTP | 64 MiB, pour couvrir l’échappement de `content` |
| Acquisition | 12 s |
| webcrack | 25 s |
| Wakaru | 25 s |
| jsluice, toutes représentations cumulées | 15 s |
| TruffleHog, toutes représentations cumulées | 15 s |
| Extracteur GraphQL, toutes représentations | 5 s |
| Extracteur de domaines, toutes représentations | 3 s |
| Travail global, acquisition et publication incluses | 90 s |
| Arrêt et vérification du nettoyage | 10 s supplémentaires réservées |
| Mémoire / CPU / processus par worker | 1 GiB / 2 CPU / 128 processus |
| Artefacts de sources par analyse | 64 MiB, 2 000 modules maximum |
| Réponse JSON d’analyse | 256 KiB |
| Lecture d’un module | 64 KiB par réponse |

Le délai global prévaut sur chaque budget local. Le budget d’un extracteur n’est pas remis à zéro pour chaque module. Les plafonds de stockage et de résultats s’appliquent pendant la production, avant d’accumuler toute la sortie en mémoire.

Les budgets locaux sont des maxima, pas des durées toutes garanties dans les 90 secondes. Le chevauchement de l’extraction et des transformations, la concurrence et le coût de TruffleHog devront être mesurés sur corpus ; le contrat indique toute couverture incomplète.

Une limite atteinte produit un statut et une couverture explicites. Les modules intégralement écrits et validés peuvent être conservés ; un fichier partiellement écrit n’est pas publié comme un module complet. Une observation dont la source n’a pas pu être conservée ne reçoit pas de lien fictif.

## Ordonnancement et erreurs

Une seule analyse active et au plus deux workers simultanés sont proposés pour commencer. Les admissions supplémentaires reçoivent `429` avec `Retry-After` ; aucune file illimitée n’est créée. Le déploiement réserve de la mémoire au superviseur en plus des workers.

Un timeout, une erreur de parsing ou un dépassement mémoire affecte l’outil concerné. Les autres traitements poursuivent leur travail dans le budget global. Les états sont définis dans le [contrat API](/reference/api/).

Un simple délai sur une promesse ne garantit pas l’arrêt du calcul. Le superviseur termine l’ensemble du worker et vérifie sa disparition après succès, erreur, délai ou annulation du client. Si l’arrêt ne peut pas être confirmé, l’instance cesse d’accepter du travail et retourne une erreur d’infrastructure. Cette défaillance de confinement est distincte d’un outil qui échoue normalement.

## Isolation

Les workers ont un réseau désactivé, un utilisateur non privilégié, une racine en lecture seule et un stockage temporaire borné. Ils ne reçoivent ni socket Docker, ni secrets du service, ni accès aux autres analyses. Les fichiers générés restent non fiables : chemins, liens symboliques, tailles et types sont validés avant import.

L’analyse n’exécute pas l’application cible. Certaines fonctions de désobfuscation peuvent toutefois évaluer des fragments : [l’API de webcrack décrit une fonction sandbox d’évaluation](https://webcrack.netlify.app/docs/guide/api.html#browser-usage-sandbox). L’isolement du moteur JavaScript ne remplace pas celui du worker. Aucun adaptateur ne doit utiliser un `eval` dans le processus de l’API.

## Mesures de qualification

Les [mesures J5](/reference/phase-5-validation/) conservent les budgets de la v0.1 : le corpus synthétique passe les seuils et le stress contrôlé de 2 Mio atteint environ 408 Mio par worker et 139 Mio pour l’API. Le profil complet coûte davantage sans gain de rappel sur ces neuf cas ; ils ne représentent pas les applications fortement obfusquées. Le plafond de 1 Gio par worker et les 90 s d’analyse gardent une marge ; le seuil API de 512 Mio est un objectif du banc, pas une limite imposée au processus serveur.
