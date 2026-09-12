import { describe, it, expect } from 'vitest';
import {
	SETTINGS_SECTIONS,
	APP_CONFIG_ROW_IDS,
	APP_CONFIG_SECTION_ID,
	SECTION_IDS,
	type SettingsNavItem,
} from './sections.js';

function flatten(tree: readonly SettingsNavItem[]): SettingsNavItem[] {
	return tree.flatMap((item) => [item, ...(item.children ?? [])]);
}

describe('SETTINGS_SECTIONS', () => {
	it('has one top-level entry per section the page renders', () => {
		expect(SETTINGS_SECTIONS).toHaveLength(11);
	});

	it('uses unique ids across the whole tree', () => {
		// Duplicates would make `document.getElementById` pick one arbitrarily and
		// leave the other nav entry permanently un-highlightable.
		const ids = flatten(SETTINGS_SECTIONS).map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('uses ids that are valid, stable URL fragments', () => {
		for (const item of flatten(SETTINGS_SECTIONS)) {
			expect(item.id).toMatch(/^[a-z][a-z0-9-]*$/);
		}
	});

	it('gives every entry a non-empty label', () => {
		for (const item of flatten(SETTINGS_SECTIONS)) {
			expect(item.label.trim()).not.toBe('');
		}
	});

	it('nests children only under App config', () => {
		const withChildren = SETTINGS_SECTIONS.filter((item) => item.children);
		expect(withChildren.map((item) => item.id)).toEqual([APP_CONFIG_SECTION_ID]);
	});

	it('keeps APP_CONFIG_ROW_IDS in lockstep with the App config children', () => {
		// This is the guard that fires when someone adds a SettingsRow to
		// AppConfigEditor and forgets to give the sidebar an entry for it.
		const appConfig = SETTINGS_SECTIONS.find((item) => item.id === APP_CONFIG_SECTION_ID);
		expect(appConfig?.children?.map((child) => child.id)).toEqual(
			Object.values(APP_CONFIG_ROW_IDS),
		);
	});

	it('exposes every top-level id through SECTION_IDS', () => {
		expect(SETTINGS_SECTIONS.map((item) => item.id)).toEqual(Object.values(SECTION_IDS));
	});
});
