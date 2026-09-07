import { describe, it, expect, beforeEach } from 'vitest';
import { startWalk, finishWalk, listWalks, _resetWalkProgressForTests } from './walk-progress.js';

beforeEach(() => _resetWalkProgressForTests());

describe('walk progress', () => {
	it('reports nothing when no walk is running', () => {
		expect(listWalks()).toEqual([]);
	});

	it('tracks the rows and total of a walk until it finishes', () => {
		const report = startWalk('roster', 'Reading the Solidarity roster');
		report(100, 19026);

		expect(listWalks()).toMatchObject([
			{ label: 'Reading the Solidarity roster', fetched: 100, total: 19026 },
		]);

		report(200, 19026);
		expect(listWalks()[0]!.fetched).toBe(200);

		finishWalk('roster');
		expect(listWalks()).toEqual([]);
	});

	it('keeps a null total when upstream will not say how many rows exist', () => {
		startWalk('actions', 'Reading recent activity')(300, null);
		expect(listWalks()[0]!.total).toBeNull();
	});

	// The autocomplete caches de-duplicate concurrent fetches, so two callers
	// can register the same walk; that must not show the admin two bars.
	it('replaces rather than duplicates a walk registered twice', () => {
		startWalk('roster', 'Reading the Solidarity roster');
		startWalk('roster', 'Reading the Solidarity roster')(50, 19026);

		expect(listWalks()).toHaveLength(1);
		expect(listWalks()[0]!.fetched).toBe(50);
	});

	it('ignores a page reported after the walk finished', () => {
		const report = startWalk('roster', 'Reading the Solidarity roster');
		finishWalk('roster');
		report(999, 19026);

		expect(listWalks()).toEqual([]);
	});

	it('lists concurrent walks oldest first', () => {
		startWalk('a', 'First')(1, null);
		startWalk('b', 'Second')(1, null);

		expect(listWalks().map((s) => s.label)).toEqual(['First', 'Second']);
	});
});
