// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'JSMiner',
			defaultLocale: 'root',
			locales: { root: { label: 'Français', lang: 'fr' } },
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/JoshuaMart/JSMiner' }],
			sidebar: [
				{ label: 'Accueil', slug: 'index' },
				{
					label: 'Démarrer',
					items: [
						{ label: 'Installation', slug: 'guides/quickstart' },
						{ label: 'Exemples de requêtes', slug: 'guides/analysis' },
					],
				},
				{
					label: 'Référence',
					items: [
						{ label: 'Configuration', slug: 'reference/configuration' },
						{ label: 'API HTTP', slug: 'reference/api' },
						{ label: 'Modèle de résultats', slug: 'reference/results' },
						{ label: 'Outils intégrés', slug: 'reference/tools' },
					],
				},
				{
					label: 'Exploiter et contribuer',
					items: [
						{ label: 'Exploitation', slug: 'guides/operations' },
						{ label: 'Développement', slug: 'guides/development' },
						{ label: 'Tests et qualification', slug: 'reference/qualification' },
					],
				},
				{
					label: 'Architecture',
					items: [
						{ label: 'Pipeline et isolation', slug: 'architecture/pipeline' },
						{ label: 'Cache et sources', slug: 'architecture/storage' },
					],
				},
				{ label: 'Limitations et après v0.1', slug: 'guides/limitations' },
			],
		}),
	],
});
