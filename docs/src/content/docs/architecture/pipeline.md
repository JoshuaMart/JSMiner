---
title: Pipeline et isolation
description: Ordre des traitements, gestion des échecs et confinement des workers.
---

## Composants

L’API TypeScript/Node.js utilise Fastify pour HTTP et SQLite pour les métadonnées. Elle pilote les [workers Docker](/reference/tools/) et conserve les sources dans des fichiers privés. Astro/Starlight sert uniquement la documentation.

```text
Authentification et admission
  → content ou capture URL autorisée
  → validation UTF-8 et vérification du hash
  → original conservé
  → webcrack → Wakaru, si sélectionnés
  → extracteurs sur l’original et les représentations conservées
  → normalisation, regroupement et masquage
  → publication du manifeste, des sources et du handle
```

Une étape complète en cache peut remplacer l’exécution du worker. Les [règles de réutilisation](/architecture/storage/#cache-des-traitements) sont propres à chaque outil et à son entrée.

## Transformations et extraction

webcrack reçoit l’original. Wakaru reçoit `webcrack/bundle.js` si les deux outils sont sélectionnés et si ce module est exploitable ; sinon, il reçoit l’original. Un repli après échec de webcrack produit `fallback_to_original`.

Si le dépliage Wakaru échoue après une transformation valide, le bundle est conservé avec le statut `partial` et le code `unpack_failed`. Si la commande de dépliage échoue, ses fichiers ne sont pas importés.

Wakaru n’est pas relancé sur chacun des modules de webcrack. Chaque extracteur reçoit en un lot les représentations absentes du cache, dans un seul conteneur. jsluice, GraphQL et domaines les traitent séquentiellement, en commençant par l’original ; TruffleHog scanne les fichiers du lot en une seule invocation. Les doublons ajoutent des preuves au même résultat ; les sources reconstruites gardent leur propre provenance.

Les résultats complets de chaque module gardent leur provenance et leur propre entrée de cache. Après un timeout ou un arrêt mémoire, les résultats déjà reçus et validés sont conservés ; une sortie de module inachevée est ignorée. TruffleHog ne confirme les fichiers sans résultat qu’après la fin réussie de son scan. Un lot entièrement en cache ne crée aucun conteneur.

Les modules ne sont importés qu’après contrôle de l’encodage, du chemin et de la taille. Une observation ne référence jamais un module absent du manifeste.

## Admission et budgets

`POST /analyze` réserve une place avant lecture du corps HTTP ; à saturation, il retourne `429` avec `Retry-After: 1`. Les jobs partagent cette capacité et attendent dans une file SQLite bornée. Le prochain job servi est celui qui a été servi le moins récemment ; les scripts d’un même job démarrent dans l’ordre soumis. La file ne garantit pas l’équité entre projets face à des appels synchrones continus.

Plusieurs scripts peuvent être analysés simultanément selon les plafonds d’analyses, de workers et de mémoire. Les outils d’un script restent séquentiels. Chaque analyse réserve aussi sa capacité de stockage ; le cache ne peut pas emprunter les réservations des analyses en cours. La récupération des conteneurs abandonnés est partagée et terminée avant le lancement du premier worker.

Le budget d’un extracteur couvre tous ses modules. Le délai global restant prévaut sur les budgets locaux, nettoyage des invocations compris. Un timeout ou une erreur laisse les autres outils poursuivre dans le temps disponible. Les [statuts](/reference/api/#statuts-et-couverture) signalent la couverture obtenue ; les [plafonds](/reference/configuration/#budgets) se configurent côté serveur.

## Isolation et nettoyage

Les conteneurs sont sans réseau, non privilégiés, avec une racine en lecture seule et un `/tmp` borné sans exécution de fichiers. Ils ne reçoivent ni volume hôte, ni socket Docker, ni jeton du service. Entrées et sorties sont bornées et validées : au plus 2 000 modules, 128 Mio d’entrée encodée et 32 Mio de sortie par lot, avec 2 Mio de résultats par module. Les plafonds de la réponse HTTP restent distincts.

Certaines désobfuscations évaluent des fragments dans le worker ; aucune exécution de ce type n’a lieu dans l’API. L’application n’est pas lancée dans un navigateur.

Le superviseur supprime chaque conteneur et vérifie sa disparition après succès, erreur, timeout ou annulation. Si le nettoyage reste incertain, l’instance bloque les nouvelles analyses et sa santé devient indisponible : voir le [diagnostic opérateur](/guides/operations/#vérifier-et-diagnostiquer).
