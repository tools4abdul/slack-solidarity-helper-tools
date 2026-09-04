// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

declare module '*.geojson' {
	import type { FeatureCollection } from 'geojson';

	const value: FeatureCollection;
	export default value;
}

declare module '*.geojson?raw' {
	const value: string;
	export default value;
}

declare module '*.json' {
	const value: JsonValue;
	export default value;
}

declare global {
	namespace App {
		interface Locals {
			session: { slackUserId: string; slackUserName: string; isAdmin: boolean } | null;
		}
	}
}

export {};
