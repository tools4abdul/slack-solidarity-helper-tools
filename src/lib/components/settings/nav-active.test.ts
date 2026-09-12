import { describe, it, expect } from 'vitest';
import { pickActiveAnchorId, allAnchorIds, findParentId, type AnchorTop } from './nav-active.js';
import { SETTINGS_SECTIONS, APP_CONFIG_ROW_IDS, APP_CONFIG_SECTION_ID } from './sections.js';

const LINE = 120;

describe('pickActiveAnchorId', () => {
	it('returns null when there are no anchors', () => {
		expect(pickActiveAnchorId([], { line: LINE })).toBeNull();
	});

	it('returns null at the bottom of an empty list', () => {
		expect(pickActiveAnchorId([], { line: LINE, atBottom: true })).toBeNull();
	});

	it('falls back to the first anchor when the page is scrolled above them all', () => {
		const anchors: AnchorTop[] = [
			{ id: 'a', top: 300 },
			{ id: 'b', top: 900 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('a');
	});

	it('counts an anchor sitting exactly on the line as reached', () => {
		const anchors: AnchorTop[] = [
			{ id: 'a', top: -500 },
			{ id: 'b', top: LINE },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('b');
	});

	it('does not count an anchor one pixel below the line', () => {
		const anchors: AnchorTop[] = [
			{ id: 'a', top: -500 },
			{ id: 'b', top: LINE + 1 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('a');
	});

	it('picks the lowest anchor that is still above the line', () => {
		const anchors: AnchorTop[] = [
			{ id: 'a', top: -900 },
			{ id: 'b', top: -400 },
			{ id: 'c', top: -20 },
			{ id: 'd', top: 600 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('c');
	});

	it('keeps the entered anchor active while scrolling through a tall section', () => {
		// The whole reason this is rect math and not IntersectionObserver: the
		// ticker and welcome-DM rows are taller than a viewport, so there is no
		// intersection change to react to for thousands of pixels of scrolling.
		const anchors: AnchorTop[] = [
			{ id: 'tall', top: -2400 },
			{ id: 'next', top: 800 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('tall');
	});

	it('handles anchors that have all scrolled past without falling back to the first', () => {
		const anchors: AnchorTop[] = [
			{ id: 'a', top: -3000 },
			{ id: 'b', top: -2000 },
			{ id: 'c', top: -100 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('c');
	});

	it('is insensitive to input order', () => {
		const sorted: AnchorTop[] = [
			{ id: 'a', top: -900 },
			{ id: 'b', top: -20 },
			{ id: 'c', top: 600 },
		];
		const shuffled: AnchorTop[] = [sorted[2], sorted[0], sorted[1]];
		expect(pickActiveAnchorId(shuffled, { line: LINE })).toBe(
			pickActiveAnchorId(sorted, { line: LINE }),
		);
	});

	it('breaks a tie on top by taking the later entry in document order', () => {
		const anchors: AnchorTop[] = [
			{ id: 'first', top: -10 },
			{ id: 'second', top: -10 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE })).toBe('second');
	});

	it('selects the last anchor once the page is scrolled to the bottom', () => {
		// Short trailing sections (Excluded chapters) never reach the line, so
		// without this they could never be highlighted.
		const anchors: AnchorTop[] = [
			{ id: 'a', top: -4000 },
			{ id: 'b', top: -900 },
			{ id: 'last', top: 700 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE, atBottom: true })).toBe('last');
	});

	it('prefers the bottom rule over the line rule', () => {
		const anchors: AnchorTop[] = [
			{ id: 'a', top: -100 },
			{ id: 'last', top: 500 },
		];
		expect(pickActiveAnchorId(anchors, { line: LINE, atBottom: false })).toBe('a');
		expect(pickActiveAnchorId(anchors, { line: LINE, atBottom: true })).toBe('last');
	});
});

describe('allAnchorIds', () => {
	it('lists every id in document order, each parent before its own children', () => {
		expect(allAnchorIds(SETTINGS_SECTIONS)).toEqual([
			'chapter-channel-map',
			'coalition-channel-map',
			APP_CONFIG_SECTION_ID,
			...Object.values(APP_CONFIG_ROW_IDS),
			'info-commands',
			'allowed-users',
			'excluded-chapters',
			'zip-excluded-chapters',
			'van-turf-checkout',
			'van-chapter-folders',
			'van-blocklist',
			'theme',
		]);
	});

	it('returns just the parents for a flat tree', () => {
		expect(
			allAnchorIds([
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			]),
		).toEqual(['a', 'b']);
	});

	it('returns an empty list for an empty tree', () => {
		expect(allAnchorIds([])).toEqual([]);
	});
});

describe('findParentId', () => {
	it('maps an App config row back to the App config section', () => {
		expect(findParentId(SETTINGS_SECTIONS, APP_CONFIG_ROW_IDS.tickerSpeed)).toBe(
			APP_CONFIG_SECTION_ID,
		);
	});

	it('returns null for a top-level id', () => {
		expect(findParentId(SETTINGS_SECTIONS, APP_CONFIG_SECTION_ID)).toBeNull();
	});

	it('returns null for an unknown id', () => {
		expect(findParentId(SETTINGS_SECTIONS, 'not-a-section')).toBeNull();
	});
});
