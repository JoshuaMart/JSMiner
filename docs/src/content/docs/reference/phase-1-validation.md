---
title: Validation de la phase 1
description: Preuves de validation du socle, des contrats et limite concernant Fingerprinter.
---

Rapport du **30 septembre 2026**. **Phase 1 terminée — J1 validé.** Le socle, les contrats et la convention de hash Fingerprinter sont vérifiés. Aucun point de phase 1 ne reste ouvert.

## Livrables

- Workspaces `apps/api`, `packages/contracts` et `packages/adapters`, séparés du site documentaire.
- Node.js 24.21.0 et pnpm 10.33.0 épinglés ; Fastify 5.12.5, SQLite intégré à Node.js et TypeScript 6.0.3.
- JSON Schema 2020-12 canonique, OpenAPI 3.1.1 et types générés, validation sans coercition du corps ni suppression de champs.
- Authentification opaque avec projet et permissions définis côté serveur, configuration bornée et initialisation privée.
- Interfaces des adaptateurs ; aucune exécution d’analyse, capture distante ou publication d’artefacts.

## Vérifications réalisées

| Vérification | Résultat |
| --- | --- |
| `pnpm check` sur macOS arm64 | Biome sans diagnostic, génération synchronisée, OpenAPI sans avertissement, compilation, types et 74 tests réussis |
| Installation depuis un clone temporaire propre du contenu à livrer | Lockfile figé, aucune dépendance ni sortie compilée copiée ; `pnpm check` réussi |
| Docker Linux amd64, Node.js 24.21.0 | Installation verrouillée, compilation, types et 74 tests réussis, sous émulation, avec les fixtures actualisées au correctif `32142b2` |
| Contrats | 60 tests : exemples valides/invalides, exclusivité d’entrée, plafonds UTF-8, source, couverture, cache, preuves et hash locaux |
| API et configuration | 14 tests : droits, identité projet, erreurs, transport, paramètres de routes, budgets, credentials privés et démarrage invalide |
| HTTP réel | Socket éphémère sur boucle locale, lecture authentifiée de `/health`, fermeture puis connexion refusée |
| SQLite | Base temporaire sur disque, migration et réouverture idempotentes |
| Documentation | Compilation de 12 pages réussie et aucun lien interne cassé ; avertissements Astro/Starlight existants non bloquants |

Les essais HTTP ferment leurs sockets et les fichiers temporaires sont supprimés. Aucun serveur Astro n’est nécessaire pour ces tests. Le workflow `.github/workflows/ci.yml` reproduit les contrôles ; son exécution sur GitHub reste à observer après publication des changements.

## Correctifs après revue

Les trois écarts relevés ont des tests de régression : une transformation incomplète dégrade la couverture des catégories demandées, un extracteur réussi doit avoir analysé tous les modules disponibles, et les statuts globaux restent cohérents. Les deux routes de sources acceptent les handles jusqu’à 128 caractères. Le corps JSON est reçu sous forme d’octets bornés puis décodé strictement en UTF-8 avant le parseur JSON Fastify ; les octets invalides donnent `422`, sans altération silencieuse du contenu.

Biome 2.5.14 contrôle désormais le code et les tests du service dans `pnpm check`, y compris en CI et dans la validation Docker. Les fichiers générés gardent leur contrôle de synchronisation dédié.

## Fingerprinter : convention vérifiée

Code inspecté dans le dépôt local fourni, propre au commit **`32142b243f02b45432d79ac31d2dc223eb20e7f3`** (`fix(browser): hash complete CDP script bodies`). Cette vérification remplace celle du commit `da5805e3` qui identifiait seulement les 2 premiers MiB.

- [`buildScripts`, `pool.go`](https://github.com/JoshuaMart/Fingerprinter/blob/32142b243f02b45432d79ac31d2dc223eb20e7f3/internal/browser/pool.go#L767).
- [`scriptHash`, `script_hash.go`](https://github.com/JoshuaMart/Fingerprinter/blob/32142b243f02b45432d79ac31d2dc223eb20e7f3/internal/browser/script_hash.go).
- [`ScriptResource`, `models.go`](https://github.com/JoshuaMart/Fingerprinter/blob/32142b243f02b45432d79ac31d2dc223eb20e7f3/internal/models/models.go#L55).

### Convention observée

1. Seuls les scripts dont le chargement a été signalé terminé sont candidats au hash.
2. Le corps vient de CDP `Network.getResponseBody`, sans nouvelle acquisition. Le base64 est décodé lorsqu’il est signalé ; sinon la chaîne CDP fournit ses octets UTF-8.
3. SHA-256 porte sur **tout ce corps**, sans troncature ni normalisation. Le champ `scripts[].hash` contient 64 hexadécimaux minuscules, **sans `sha256:`**.
4. Un corps vide, indisponible, invalide en base64, une annulation ou un dépassement de la limite de hash de **32 MiB** ne produit aucun hash. La limite historique de 2 MiB des détecteurs reste indépendante et inchangée.

Le décodage base64 et le hash utilisent une lecture par blocs. La limite de 32 MiB borne le traitement local, mais pas la mémoire du transport CDP, qui a déjà matérialisé sa réponse. L’événement de fin de chargement ne permet pas de détecter une éventuelle troncature silencieuse par un fournisseur CDP.

### Preuve reproductible

`packages/contracts/examples/hash-vectors.json` conserve les cinq vecteurs ASCII, BOM, LF, CRLF et Unicode, et quatre cas autour de l’ancienne limite : exactement 2 MiB, deux suffixes différents après un préfixe identique de 2 MiB, caractère UTF-8 traversant cette frontière. Les hashes Fingerprinter et JSMiner correspondent au contenu complet ; les deux suffixes produisent des hashes distincts.

```sh
python3 scripts/verify-fingerprinter-hash.py /chemin/vers/Fingerprinter
```

**21 sous-cas de compatibilité réussis** avec Go 1.27.1 sur macOS arm64, plus les tests amont `TestScriptHash*`, `TestBuildScriptsRequiresFinishedLoad` et `TestDetectorLimitsUnchanged`. Ceux-ci couvrent notamment la limite de 32 MiB, les annulations, les chargements incomplets et la conservation des limites des détecteurs.

Le script vérifie que HEAD correspond au commit des fixtures, l’exporte dans un répertoire temporaire et y ajoute `packages/contracts/compat/fingerprinter_hash_test.go`. Il appelle les vraies fonctions `buildScripts` et `scriptHash` via Rod 0.116.2, en remplaçant uniquement le transport CDP par des réponses synthétiques. Les branches texte/base64 sont testées pour les neuf vecteurs, puis les cas vide, base64 invalide et corps indisponible. Le dépôt original reste inchangé ; aucun navigateur ni requête réseau n’est utilisé. Python 3.12+ et les dépendances Go déjà en cache sont requis.

Le test Node.js vérifie les mêmes hashes et le préfixe du contrat JSMiner. La CI Node.js ne relance pas le dépôt Go externe ; elle conserve ces fixtures et leur provenance. La vérification amont doit être relancée et sa provenance mise à jour après revue si Fingerprinter évolue. Le build distant signalé par le mainteneur n’est pas couvert par cette validation locale.

### Compatibilité retenue

Pour des octets identiques, ajouter `sha256:` adapte le format sans modifier le hash, y compris au-delà de 2 MiB. JSMiner conserve son plafond d’entrée de 10 MiB. Le BOM et les fins de ligne **déjà présents dans la réponse CDP** sont préservés. Le décodage HTTP/charset/BOM effectué auparavant par Chrome n’est pas qualifié par ces tests : une acquisition HTTP séparée peut donc fournir des octets différents.

Le client peut omettre `script_hash` si le hash amont est absent ou l’identité des octets incertaine. S’il le fournit, JSMiner devra toujours recalculer le hash ; le contrat prévoit `409 hash_mismatch` en cas de différence. Les anciens hashes calculés sur un préfixe nécessitent une nouvelle capture ou doivent être ignorés ; ajouter le préfixe textuel `sha256:` ne corrige pas leur contenu.

J1 reste validé ; cette mise à jour confirme la correction de la troncature sans prétendre qu’une intégration d’analyse est déjà réalisée.

## Limites de cette phase

Les réponses métier illustrent le contrat futur. Les routes `/analyze` et `/source` sont des points d’entrée validés répondant `501`. Les tests de permissions ne constituent pas une preuve d’isolation de handles, puisqu’aucun handle n’est créé. La capture, les workers, le cache, la pagination effective, les lectures de fichiers, la purge et les plafonds de ressources des outils appartiennent aux étapes suivantes.
