---
title: Validation de phase 4
description: Acquisition URL autorisée, identité des étapes, réutilisation et conservation des artefacts.
---

## Périmètre

Validation du 30 septembre 2026, sur macOS arm64 avec Node.js 24.21.0, pnpm 10.33.0 et Docker/OrbStack, complétée par `pnpm check` dans l’image Linux amd64. Le périmètre de J4 couvre une capture HTTP(S) autorisée, les caches des étapes et la conservation des handles. Les serveurs HTTP utilisés par les tests sont des fixtures locales sur des ports éphémères.

Les images de workers restent `jsminer-jsluice:phase2` (protocole 3) et `jsminer-offline:phase3` (version composite `webcrack2.16.0-wakaru1.12.0-trufflehog3.97.9-static2`). La phase 4 modifie la capture, la supervision et le stockage, sans modifier leur code d’analyse hors ligne.

## Matrice de validation

| Domaine | Preuve automatisée |
| --- | --- |
| Autorisation | Origines exactes, refus par défaut, ports distincts, dérogation privée exclusivement côté serveur, authentification avant capture |
| Destination réseau | Classification IPv4/IPv6, refus des réponses DNS mixtes public/privé, une seule résolution puis connexion à l’adresse fixée, conservation de `Host` |
| Acquisition | Refus des redirections sans suivre leur cible, statuts autres que 200, transfert tronqué, HTML/XML, corps vide, UTF-8 invalide, charset incompatible |
| Compression et limites | gzip, deflate, Brotli ; plafonds sur corps chunked et après expansion ; compression inconnue ou invalide refusée |
| Arrêt | Timeout réseau et DNS, annulation de la capture, aucun worker démarré après l’échec, admission suivante disponible |
| Identité | BOM et CRLF conservés ; hash recalculé sur le corps décompressé avant le cache, y compris lors d’une seconde capture |
| Cache statique | Mêmes octets à deux URL, nouveau handle, nouvelle `base_url`, origine du CDN jamais utilisée comme base implicite |
| Invalidation | Contenu, identité/version/options de l’image, budgets de traitement, projet ; modification des références ne relance que `domains` |
| Filiation | Wakaru après webcrack et repli sur l’original ont des clés distinctes, même si les octets sont identiques ; preuves et manifestes conservés sur hit |
| Résilience | Succès réutilisés, sorties invalides/partielles et timeouts retentés ; cache altéré recalculé ; adaptateurs sans identité immuable non cachés |
| Stockage | Rétention fixe, éviction FIFO, handles actifs lisibles, quota refusé avant worker, tombstones privés, reprise après redémarrage, verrou exclusif et suppression des temporaires non publiés |
| Docker réel | Capture gzip vers jsluice ; second passage du profil complet servi depuis les caches avec résultats et sources identiques |

Les nouveaux scénarios résident dans `apps/api/test/phase4.test.mjs`, `packages/adapters/test/docker.test.mjs` et `apps/api/integration/phase4.test.mjs`. Ils complètent les tests de publication, permissions et nettoyage des phases précédentes.

## Commandes reproductibles

```sh
pnpm check
pnpm test:workers
docker build --platform linux/amd64 --target validate -t jsminer:phase4-validation .
pnpm --dir docs build
```

Résultats : **151 tests du workspace** (60 contrats, 16 adaptateurs, 75 API), **14 tests d’intégration Docker**, vérifications Linux amd64 et compilation des **15 pages** documentaires. Biome, contrats générés, OpenAPI, compilation et vérification des types sont inclus dans `pnpm check`.

## Revue avant commit

Six points corrigés lors de la revue du 30 septembre 2026 :

| Priorité | Problème | Correction et validation |
| --- | --- | --- |
| P1 | Une réponse de changement de protocole pouvait fermer la requête sans terminer la promesse de capture | Refus explicite de l’upgrade, fermeture de la socket et erreur `capture_status` ; fixture HTTP locale sous délai de test |
| P2 | L’annulation pouvait rendre la main avant la fermeture du transport et lancer une résolution DNS déjà annulée | Attente de fermeture de la requête, de la socket et du flux ; contrôle d’annulation avant DNS ; assertions sur les événements de fermeture |
| P2 | Un délai expiré pouvait être dépassé avant l’exécution du timer | Contrôle monotone avant/après DNS et après décodage ; fixture avec résolution retardée |
| P2 | La normalisation d’une URL configurée pouvait effacer son chemin avant validation | Validation de la syntaxe d’origine avant acceptation ; refus des chemins normalisés et des query/fragment vides |
| P2 | Un worker épinglé possédait un état de santé indépendant du superviseur | Partage du verrou de panne ; un nettoyage incertain interdit aussi les nouvelles inspections et exécutions du parent |
| P2 | Chaque tentative d’ajout au cache chargeait la liste entière des entrées, même sans éviction | Retour immédiat après le calcul du total si le quota est déjà respecté ; les tests d’éviction et de réservation restent passants |

Six tests de non-régression supplémentaires couvrent les comportements de capture, la configuration et le superviseur.

## Décisions et limites

- La politique de capture est commune aux projets de l’instance. `allow_private` est une dérogation par origine exacte ; elle inclut les adresses internes et link-local. La v0.1 ne propose ni règles par chemin ni authentification des ressources distantes.
- La capture ne suit aucun lien découvert, ne fait aucune vérification de secrets, et ne revalide pas le cache par ETag. Chaque demande URL recharge le corps avant de pouvoir réutiliser une analyse.
- Le nom DNS est validé une fois, puis l’adresse est fixée. Le délai applicatif couvre la résolution ; une résolution système déjà engagée peut toutefois finir après l’annulation, sans ouvrir de connexion HTTP.
- Les images doivent être inspectables, même sur cache. Le tag est résolu à chaque analyse ; une image reconstruite avec le même tag invalide les anciennes étapes. Options et règles embarquées sont couvertes par son ID immuable.
- Les sorties brutes du cache peuvent contenir sources et secrets. Elles restent privées, séparées des copies des handles ; masquage, HMAC, fusion et résolution des URL sont recalculés par requête.
- `cache_hit` décrit un outil entièrement réutilisé. Si seuls certains modules le sont, l’outil reste compté comme un miss ; les modules réussis sont néanmoins réutilisés.
- Le quota est logique : sources, réponses, manifestes et sorties du cache, avec marges de métadonnées. L’espace physique SQLite/WAL, Docker et le système de fichiers restent à surveiller côté hôte. La saturation du cache ne révoque aucun handle actif.
- Un seul processus possède le répertoire et une seule analyse est admise. Le cache distribué, la révalidation HTTP et les mesures de précision/coût du corpus restent hors de J4.
