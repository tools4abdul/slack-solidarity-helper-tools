import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
	// Extra hostnames the dev server answers to, comma-separated — an HTTPS
	// tunnel (ngrok, Cloudflare) in front of `npm run dev`, which Sign in with
	// Apple needs because it will not return to localhost. Vite refuses any
	// Host it does not know, so without this the tunnel gets "Blocked request".
	// Read from .env.local like the app's other settings; dev only.
	const env = loadEnv(mode, process.cwd(), '');
	const allowedHosts = (env.DEV_ALLOWED_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter((host) => host !== '');

	return {
		plugins: [sveltekit()],
		server: { allowedHosts },
		test: {
			projects: [
				{
					extends: true,
					test: {
						name: 'server',
						include: [
							'src/**/*.{test,spec}.{js,ts}',
							'mobilize-migrator/**/*.{test,spec}.{js,ts}',
							'scripts/**/*.{test,spec}.{js,ts}',
						],
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						environment: 'node',
						// The plan audit (scripts/plan-audit/run.ts) records every
						// statement the tests send; nothing else loads it.
						setupFiles: process.env.PLAN_AUDIT ? ['scripts/plan-audit/record.ts'] : [],
					},
				},
				// Component tests mount into a DOM, which needs Svelte's browser
				// build: the default server build has no `mount`.
				{
					extends: true,
					resolve: { conditions: ['browser'] },
					test: {
						name: 'client',
						include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						environment: 'jsdom',
					},
				},
			],
		},
	};
});
