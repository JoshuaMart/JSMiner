---
title: Limitations et après v0.1
description: Couverture actuelle, contraintes de déploiement et évolutions possibles.
---

## Analyse

- Analyse statique d’un script : valeurs dynamiques, imports à l’exécution et certaines obfuscations peuvent rester inconnus.
- Aucun test d’accessibilité des endpoints, de validité des secrets ou de propriété des domaines.
- Un bundle peut dépasser le budget mémoire de webcrack ou contenir des modules que Wakaru ne sait pas déplier ; augmenter les budgets ne garantit pas une transformation complète.
- GraphQL sans schéma distant ni association à un endpoint (`endpoint_id: null`).
- Source maps non prises en charge ; aucun suivi des chunks ou fichiers découverts.
- Résultats tronqués sans pagination des observations omises ; les plafonds figurent dans la [référence API](/reference/api/#réponse-bornée).

## Couverture mesurée

La [qualification](/reference/qualification/) utilise neuf fixtures synthétiques, dont une seule famille de secrets. Elle ne représente pas les applications fortement obfusquées et ne mesure pas l’exactitude de tous les paramètres extraits.

Les huit profils obtiennent les mêmes comptes sur ce corpus. Un préfixe d’endpoint dynamique constitue un faux positif connu. Le stress de 2 Mio utilise un commentaire de remplissage : il vérifie le volume, pas une complexité AST équivalente. Ces mesures ne démontrent pas une précision générale ni des performances sous charge.

## Déploiement

- Une analyse et un worker à la fois, sans file persistante ni reprise de job. Les extracteurs traitent les modules par lot dans un conteneur ; un lot complexe peut encore dépasser son budget.
- Stockage local exclusif ; pas de partage entre serveurs ni de suppression administrative des handles actifs.
- Capture des URL publiques par défaut, sans redirection ni session navigateur ; restrictions réseau communes à tous les projets.
- Jetons lus au démarrage, sans API d’administration. Un accès distant nécessite un proxy TLS privé.
- Qualification sur macOS arm64 et socle Linux amd64 émulé. Windows, Linux arm64 et performances natives Linux non qualifiés.
- Le Dockerfile racine valide le socle ; son étage `runtime` conserve les dépendances de développement et ne fournit pas de client Docker. Ce n’est pas un déploiement complet.

## Pistes après v0.1

| Évolution | Travail à prévoir |
| --- | --- |
| Corpus représentatif | Bundles autorisés obfusqués, autres familles de secrets, annotations de méthodes/paramètres |
| Source maps fournies | Format, provenance et plafonds |
| Imports HAR/Burp | Conversion des captures existantes vers `content` |
| Comparaison de bundles | Distinguer changements de code et changements d’outils |
| Pagination des observations | Inventaire étendu sans agrandir les réponses |
| Jobs asynchrones et lots | Admission, persistance, reprise et annulation |
| Parallélisme | Mesurer mémoire et bénéfice, préserver le nettoyage |
| Revalidation HTTP | Cache d’acquisition séparé du cache des traitements |
| Packaging d’exploitation | Déploiement du superviseur, de Docker et du stockage |

Ces pistes ne sont pas implémentées et n’ont pas de date de livraison annoncée.
