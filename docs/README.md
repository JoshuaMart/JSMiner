# Documentation JSMiner

Site Astro/Starlight en français consacré à l’installation, à l’API, à l’exploitation et au développement de JSMiner. Ce workspace est indépendant de celui du service et possède son propre lockfile.

## Commandes

Depuis `docs/` :

| Commande | Usage |
| --- | --- |
| `pnpm install --frozen-lockfile` | Installer les dépendances verrouillées |
| `pnpm dev` | Démarrer le site en développement |
| `pnpm build` | Compiler dans `dist/` |
| `pnpm preview` | Consulter le build local |

Pour un agent qui lance un serveur en arrière-plan, suivre [AGENTS.md](AGENTS.md).

## Organisation éditoriale

Les pages publiées sont dans `src/content/docs/` ; leur navigation est dans `astro.config.mjs`. Chaque page possède un `title` et une `description`. L’accueil utilise MDX, les autres pages Markdown.

- Les guides répondent à une tâche : installer, analyser, exploiter ou développer.
- La référence décrit la configuration, les routes, les résultats, les outils et la qualification.
- L’architecture explique le pipeline et le stockage.
- [Limitations et après v0.1](src/content/docs/guides/limitations.md) regroupe les limites actuelles et les pistes non implémentées.

Décrire le comportement livré au présent. Vérifier les valeurs contre le code, `apps/api/config.schema.json` et `packages/contracts/schema.json`. Ne pas présenter une proposition future comme une fonctionnalité disponible. Les exemples utilisent des données fictives et restent cohérents avec le contrat.

## Validation d’une modification

Construire le site avec `pnpm build`, puis vérifier les routes, les ancres et la navigation. À la racine du dépôt, `pnpm check` contrôle notamment les exemples JSON de la référence API. Ces cinq blocs sont associés dans l’ordre à `AnalyzeRequest`, `AnalyzeResponse`, `ManifestResponse`, `SourceResponse` et `ErrorResponse` ; conserver cette correspondance ou adapter le test avec le contrat.

Une modification documentaire n’exige pas de relancer tout le corpus Docker, sauf si les instructions ou résultats changent et nécessitent une nouvelle preuve.
