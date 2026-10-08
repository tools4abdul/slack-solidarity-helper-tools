import { describe, it, expect } from 'vitest';
import { chaptersFromChannelMap, labelCustomChapters, turfChapters } from './chapter-list.js';

describe('chaptersFromChannelMap', () => {
	it('collapses a chapter that has several channels into one option', () => {
		// The production shape that broke /turfs/organizer and /turfs/activity:
		// chapter_channel_map is keyed by channel, and every chapter had two.
		const entries = [
			{ chapterId: 1305, channelId: 'C1', name: 'Washtenaw for Abdul' },
			{ chapterId: 1305, channelId: 'C2', name: 'Washtenaw for Abdul' },
			{ chapterId: 1306, channelId: 'C3', name: 'Wayne for Abdul' },
			{ chapterId: 1306, channelId: 'C4', name: 'Wayne for Abdul' },
		];

		expect(chaptersFromChannelMap(entries)).toEqual([
			{ chapterId: 1305, name: 'Washtenaw for Abdul' },
			{ chapterId: 1306, name: 'Wayne for Abdul' },
		]);
	});

	it('yields ids unique enough to key an {#each} block', () => {
		// The property that actually matters. A duplicate key throws
		// `each_key_duplicate` at hydration time, which kills the whole page's
		// client-side app rather than just the picker.
		const entries = Array.from({ length: 64 }, (_, i) => ({
			chapterId: 1300 + Math.floor(i / 2),
			channelId: `C${i}`,
			name: `Chapter ${1300 + Math.floor(i / 2)}`,
		}));

		const chapters = chaptersFromChannelMap(entries);
		const ids = chapters.map((c) => c.chapterId);

		expect(chapters).toHaveLength(32);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('sorts by name, not by id or insertion order', () => {
		const entries = [
			{ chapterId: 9, channelId: 'C1', name: 'Wayne County' },
			{ chapterId: 1, channelId: 'C2', name: 'Washtenaw County' },
			{ chapterId: 5, channelId: 'C3', name: 'Ingham County' },
		];

		expect(chaptersFromChannelMap(entries).map((c) => c.name)).toEqual([
			'Ingham County',
			'Washtenaw County',
			'Wayne County',
		]);
	});

	it('keeps the first name when two rows spell a chapter differently', () => {
		const entries = [
			{ chapterId: 1305, channelId: 'C1', name: 'Washtenaw for Abdul' },
			{ chapterId: 1305, channelId: 'C2', name: 'washtenaw for abdul' },
		];

		expect(chaptersFromChannelMap(entries)).toEqual([
			{ chapterId: 1305, name: 'Washtenaw for Abdul' },
		]);
	});

	it('returns nothing for an empty map rather than throwing', () => {
		expect(chaptersFromChannelMap([])).toEqual([]);
	});
});

describe('turfChapters', () => {
	const map = [
		{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
		{ chapterId: 71, channelId: 'C2', name: 'Washtenaw County' },
		{ chapterId: 72, channelId: 'C3', name: 'Wayne County' },
		{ chapterId: 1, channelId: 'C4', name: 'Michigan (statewide)' },
	];

	it('is the deduplicated, sorted map less the hidden chapters', () => {
		expect(turfChapters(map, new Set([1]))).toEqual([
			{ chapterId: 71, name: 'Washtenaw County' },
			{ chapterId: 72, name: 'Wayne County' },
		]);
	});

	it('shows every chapter while none is hidden', () => {
		expect(turfChapters(map, new Set())).toEqual(chaptersFromChannelMap(map));
	});

	// A chapter hidden and later dropped from the map has nothing to hide.
	it('ignores a hidden id that is not in the map', () => {
		expect(turfChapters(map, new Set([999]))).toHaveLength(3);
	});
});

describe('turf-only chapters', () => {
	const entries = [
		{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
		{ chapterId: 72, channelId: 'C2', name: 'Wayne County' },
	];
	const custom = [{ chapterId: -1, name: 'Ann Arbor outreach' }];

	it('merges them in, sorted by name with the mapped chapters', () => {
		expect(chaptersFromChannelMap(entries, custom)).toEqual([
			{ chapterId: -1, name: 'Ann Arbor outreach' },
			{ chapterId: 71, name: 'Washtenaw County' },
			{ chapterId: 72, name: 'Wayne County' },
		]);
	});

	it('offers them on /turfs alongside the chapters left visible', () => {
		expect(turfChapters(entries, new Set([71]), custom)).toEqual([
			{ chapterId: -1, name: 'Ann Arbor outreach' },
			{ chapterId: 72, name: 'Wayne County' },
		]);
	});
});

// A real chapter can come to share a custom entry's name after it was added —
// a Solidarity rename, a chapter newly given a channel. The pickers must still
// tell the two apart.
describe('labelCustomChapters', () => {
	it('marks a custom entry whose name a real chapter has, ignoring case', () => {
		expect(
			labelCustomChapters(
				[
					{ chapterId: -1, name: 'Wayne County' },
					{ chapterId: -2, name: 'Outreach' },
				],
				['  wayne county ', 'Washtenaw County'],
			),
		).toEqual([
			{ chapterId: -1, name: 'Wayne County (custom)' },
			{ chapterId: -2, name: 'Outreach' },
		]);
	});

	it('labels a collision in the /turfs picker', () => {
		const entries = [{ chapterId: 72, channelId: 'C2', name: 'Wayne County' }];
		expect(turfChapters(entries, new Set(), [{ chapterId: -1, name: 'Wayne County' }])).toEqual([
			{ chapterId: 72, name: 'Wayne County' },
			{ chapterId: -1, name: 'Wayne County (custom)' },
		]);
	});
});
