---
title: Exemples de requêtes
description: Requêtes curl pour analyser du JavaScript et consulter ses sources.
---

Après l’[installation](/guides/quickstart/), exécutez les exemples depuis la racine du dépôt, dans le même terminal :

```sh
JSMINER_URL=http://127.0.0.1:3000
JSMINER_TOKEN=$(cat .local/token)
```

Les champs, statuts et erreurs sont détaillés dans la [référence API](/reference/api/).

## Analyser un extrait

`base_url` résout les chemins relatifs, sans contacter cette adresse. Cet exemple utilise uniquement jsluice et sauvegarde la réponse pour les lectures de sources ci-dessous.

```sh
curl --fail-with-body "$JSMINER_URL/analyze" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"content":"fetch(\"/api/profile\");","tools":["jsluice"],"base_url":"https://app.example.com/"}' \
  -o .local/analysis.json
```

Vérifiez `status` et `tools` dans la réponse : un HTTP `200` peut contenir une analyse partielle ou échouée.

## Analyser une URL

Remplacez l’URL fictive par celle de votre script. Les URL publiques sont acceptées par défaut ; une [liste restrictive](/reference/configuration/#capture-url) reste configurable. Sans `tools`, le profil complet est utilisé.

```sh
curl --fail-with-body "$JSMINER_URL/analyze" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://assets.example.com/app.js","base_url":"https://app.example.com/"}'
```

## Choisir les traitements

Une liste explicite remplace le profil par défaut. Ici, seul l’extracteur GraphQL analyse le contenu :

```sh
curl --fail-with-body "$JSMINER_URL/analyze" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"content":"const doc = gql`query Viewer { viewer { id } }`;","tools":["graphql"]}'
```

Les [outils intégrés](/reference/tools/) donnent les autres identifiants disponibles.

## Extraire les sous-domaines observés

`reference_domains` définit les racines à retenir. L’URL présente dans cet extrait n’est pas appelée.

```sh
curl --fail-with-body "$JSMINER_URL/analyze" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"content":"fetch(\"https://api.example.com/v1\");","tools":["domains"],"reference_domains":["example.com"]}'
```

## Lister les modules

Récupérez le handle de la première réponse, puis demandez son manifeste :

```sh
JSMINER_HANDLE=$(pnpm exec node -p 'JSON.parse(require("node:fs").readFileSync(".local/analysis.json", "utf8")).handle')
curl --fail-with-body "$JSMINER_URL/source/$JSMINER_HANDLE?limit=50" \
  -H "Authorization: Bearer $JSMINER_TOKEN"
```

Si `next_cursor` n’est pas `null`, reprenez avec sa valeur :

```sh
JSMINER_CURSOR='remplacer par next_cursor'
curl --fail-with-body --get "$JSMINER_URL/source/$JSMINER_HANDLE" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  --data-urlencode "cursor=$JSMINER_CURSOR" --data-urlencode 'limit=50'
```

## Consulter les sources

Demandez un fragment de l’original. Pour une observation précise, utilisez son `evidence[].module_path` à la place de `original/bundle.js`.

```sh
curl --fail-with-body --get "$JSMINER_URL/source/$JSMINER_HANDLE/original/bundle.js" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  --data-urlencode 'offset=0' --data-urlencode 'max_bytes=16384'
```

Si `next_offset` n’est pas `null`, reprenez avec cet offset en octets UTF-8 :

```sh
JSMINER_OFFSET='remplacer par next_offset'
curl --fail-with-body --get "$JSMINER_URL/source/$JSMINER_HANDLE/original/bundle.js" \
  -H "Authorization: Bearer $JSMINER_TOKEN" \
  --data-urlencode "offset=$JSMINER_OFFSET" --data-urlencode 'max_bytes=16384'
```

Les lectures nécessitent `source:read` et peuvent exposer des secrets présents dans le code original.
