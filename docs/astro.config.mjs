// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
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
					label: 'Le projet',
					items: [
						{ label: 'Vision et périmètre', slug: 'guides/vision' },
						{ label: 'Feuille de route', slug: 'guides/roadmap' },
					],
				},
				{
					label: 'Architecture',
					items: [
						{ label: 'Pipeline et isolation', slug: 'architecture/pipeline' },
						{ label: 'Cache et sources', slug: 'architecture/storage' },
					],
				},
				{
					label: 'Référence',
					items: [
						{ label: 'Contrat API', slug: 'reference/api' },
						{ label: 'Modèle de résultats', slug: 'reference/results' },
					],
				},
				{
					label: 'Étude préalable',
					items: [
						{ label: 'Outils et inspirations', slug: 'research/tools' },
						{ label: 'Retour sur le prototype', slug: 'research/prototype' },
					],
				},
			],
		}),
	],
});
