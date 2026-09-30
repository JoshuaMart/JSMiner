# Documentation JSMiner

Site Astro/Starlight en français. Le socle HTTP et les contrats sont disponibles ; le moteur d’analyse reste à implémenter.

## Commandes

Depuis ce répertoire :

| Commande | Usage |
| --- | --- |
| `pnpm install --frozen-lockfile` | Installer les dépendances verrouillées |
| `pnpm dev` | Démarrer le site en développement |
| `pnpm build` | Compiler le site dans `dist/` |
| `pnpm preview` | Consulter le build local |

Pour un agent qui lance le serveur en arrière-plan, suivre [AGENTS.md](AGENTS.md).

## Éditer le contenu

Les pages sont dans `src/content/docs/`. La navigation est définie dans `astro.config.mjs`. Chaque page possède un `title` et une `description`. L’accueil utilise MDX ; les autres pages utilisent Markdown.

Conserver la distinction entre contraintes du produit, choix proposés, fonctionnalités implémentées et pistes ultérieures. Relier les affirmations sur les outils externes à leur documentation amont. Les exemples doivent utiliser des données fictives et rester cohérents avec le contrat API.

Après modification, exécuter `pnpm build` et vérifier les liens internes. `packages/contracts/schema.json` à la racine du dépôt définit les structures canoniques ; les invariants transversaux sont dans son validateur TypeScript. OpenAPI et les types sont générés. Exécuter `pnpm check` à la racine pour contrôler leur synchronisation et les exemples JSON de la référence API.
