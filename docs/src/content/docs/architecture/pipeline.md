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

Wakaru n’est pas relancé sur chacun des modules de webcrack. Les extracteurs parcourent ensuite les représentations conservées, en commençant par l’original. Les doublons ajoutent des preuves au même résultat ; les sources reconstruites gardent leur propre provenance.

Les modules ne sont importés qu’après contrôle de l’encodage, du chemin et de la taille. Une observation ne référence jamais un module absent du manifeste.

## Admission et budgets

Une seule analyse est admise, avant lecture du corps HTTP ; les autres reçoivent `429` avec `Retry-After: 1`. Les workers et modules sont traités séquentiellement.

Le budget d’un extracteur couvre tous ses modules. Le délai global restant prévaut sur les budgets locaux, nettoyage des invocations compris. Un timeout ou une erreur laisse les autres outils poursuivre dans le temps disponible. Les [statuts](/reference/api/#statuts-et-couverture) signalent la couverture obtenue ; les [plafonds](/reference/configuration/#budgets) se configurent côté serveur.

## Isolation et nettoyage

Les conteneurs sont sans réseau, non privilégiés, avec une racine en lecture seule et un `/tmp` borné sans exécution de fichiers. Ils ne reçoivent ni volume hôte, ni socket Docker, ni jeton du service. Entrées et sorties sont bornées et validées.

Certaines désobfuscations évaluent des fragments dans le worker ; aucune exécution de ce type n’a lieu dans l’API. L’application n’est pas lancée dans un navigateur.

Le superviseur supprime chaque conteneur et vérifie sa disparition après succès, erreur, timeout ou annulation. Si le nettoyage reste incertain, l’instance bloque les nouvelles analyses et sa santé devient indisponible : voir le [diagnostic opérateur](/guides/operations/#vérifier-et-diagnostiquer).
