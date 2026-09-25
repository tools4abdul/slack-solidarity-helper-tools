import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindForSlack = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack-solidarity-user.js', () => ({
	findSolidarityUserForSlack: mockFindForSlack,
}));

const { profileRegionFor, regionOf } = await import('./turf-profile.js');

const db = {} as never;

function user(over: Record<string, unknown> = {}) {
	return {
		id: 5,
		chapter_id: 71,
		chapter_ids: [71, 72],
		address: { city: 'Ann Arbor', state: 'MI', zip_code: '48104-1234' },
		...over,
	} as never;
}

describe('regionOf', () => {
	it('reads the five-digit ZIP and the chapter list', () => {
		expect(regionOf(user())).toEqual({ zip: '48104', chapterIds: [71, 72] });
	});

	// The app-wide rule (solidarity-chapter-ids.ts), so /turfs sends a member to
	// the same chapter the rest of the app puts them in.
	it('ignores a stale chapter_id when chapter_ids is set', () => {
		expect(regionOf(user({ chapter_id: 71, chapter_ids: [72] })).chapterIds).toEqual([72]);
	});

	it('falls back to chapter_id when chapter_ids is empty', () => {
		expect(regionOf(user({ chapter_id: 71, chapter_ids: [] })).chapterIds).toEqual([71]);
	});

	it('tolerates a profile with no address and no chapters', () => {
		expect(regionOf(user({ chapter_id: null, chapter_ids: undefined, address: null }))).toEqual({
			zip: null,
			chapterIds: [],
		});
	});

	it('drops a ZIP that is not a ZIP', () => {
		expect(regionOf(user({ address: { city: null, state: null, zip_code: 'N/A' } })).zip).toBe(
			null,
		);
	});
});

describe('profileRegionFor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it("reads the region off the caller's Solidarity account", async () => {
		mockFindForSlack.mockResolvedValue(user());
		expect(await profileRegionFor(db, 'U1')).toEqual({ zip: '48104', chapterIds: [71, 72] });
		expect(mockFindForSlack).toHaveBeenCalledWith(db, 'U1');
	});

	it('is null when no account is found', async () => {
		mockFindForSlack.mockResolvedValue(null);
		expect(await profileRegionFor(db, 'U1')).toBeNull();
	});

	it('is null, not a throw, when the lookup fails', async () => {
		mockFindForSlack.mockRejectedValue(new Error('503'));
		expect(await profileRegionFor(db, 'U1')).toBeNull();
	});
});
