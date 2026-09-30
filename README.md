# JSMiner

Service en cours de conception pour analyser des scripts JavaScript et produire un inventaire compact d’endpoints, de secrets potentiels, d’opérations GraphQL et de sous-domaines observés.

**État : préparation du développement.** Aucune API d’analyse n’est encore implémentée. TypeScript est retenu pour le service. Node.js 24 est proposé pour l’API, l’orchestration et le worker webcrack, avec des binaires isolés pour Wakaru, jsluice et TruffleHog. Leur intégration reste à valider.

## Documentation

Le site Astro/Starlight est dans `docs/` et son contenu est en français.

```sh
cd docs
pnpm install --frozen-lockfile
pnpm dev
```

La commande affiche l’adresse locale. Pour compiler le site : `pnpm build` depuis `docs/`.

- [Vision et périmètre](docs/src/content/docs/guides/vision.md)
- [Pipeline et isolation](docs/src/content/docs/architecture/pipeline.md)
- [Contrat API](docs/src/content/docs/reference/api.md)
- [Modèle de résultats](docs/src/content/docs/reference/results.md)
- [Cache et sources](docs/src/content/docs/architecture/storage.md)
- [Outils et inspirations](docs/src/content/docs/research/tools.md)
- [Retour sur le prototype](docs/src/content/docs/research/prototype.md)
- [Feuille de route](docs/src/content/docs/guides/roadmap.md)

## Principes

`POST /analyze` accepte un script ou une URL autorisée et retourne des résultats structurés avec un `handle`. Le code est conservé séparément : `GET /source/:handle` liste les modules et `GET /source/:handle/:path` permet une lecture ciblée. Le cache repose sur le contenu et la configuration des outils. Les erreurs individuelles sont visibles et n’effacent pas les résultats obtenus.
