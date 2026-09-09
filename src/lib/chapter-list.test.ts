import { describe, it, expect } from 'vitest';
import { chaptersFromChannelMap } from './chapter-list.js';

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
