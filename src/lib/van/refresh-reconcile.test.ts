import { describe, it, expect } from 'vitest';
import {
	planReconciliation,
	findReplacement,
	renderListNumberChanged,
	renderRecutReplaced,
	type ReconcileClaim,
	type RecutClaim,
	type ReconcileTurf,
	type ReplacementTurf,
} from './refresh-reconcile.js';

const NOW = new Date('2026-09-12T18:00:00.000Z');
const APP = 'https://example.test';

function turf(over: Partial<ReconcileTurf> = {}): ReconcileTurf {
	return {
		mapRouteId: 100,
		mapRegionId: 10,
		chapterId: 7,
		name: 'Turf 01',
		regionName: 'Cambridge North',
		printedListNumber: '35536745-88712',
		doorCount: 250,
		retiredAt: null,
		...over,
	};
}

function claim(over: Partial<ReconcileClaim> = {}): ReconcileClaim {
	return {
		checkoutId: 1,
		mapRouteId: 100,
		slackUserId: 'U1',
		slackUserName: 'Dana',
		issuedListNumber: '35536745-88712',
		turf: turf(),
		...over,
	};
}

function recutClaim(over: Partial<RecutClaim> = {}): RecutClaim {
	return {
		checkoutId: 2,
		mapRouteId: 56456,
		slackUserId: 'U1',
		slackUserName: 'Dana',
		releasedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
		turf: { mapRegionId: 508413, chapterId: 7, name: 'Turf 01', regionName: 'Cambridge North' },
		...over,
	};
}

function replacement(over: Partial<ReplacementTurf> = {}): ReplacementTurf {
	return {
		mapRouteId: 56502,
		mapRegionId: 508413,
		name: 'Turf 01',
		printedListNumber: '99999999-11111',
		doorCount: 180,
		retiredAt: null,
		claimed: false,
		...over,
	};
}

function plan(over: Partial<Parameters<typeof planReconciliation>[0]> = {}) {
	return planReconciliation({
		claims: [],
		recut: [],
		replacements: [],
		now: NOW,
		appUrl: APP,
		...over,
	});
}

describe('planReconciliation — live claims', () => {
	it('does nothing while the number still matches', () => {
		expect(plan({ claims: [claim()] })).toEqual([]);
	});

	it('adopts the number silently when we have no record of issuing one', () => {
		const actions = plan({ claims: [claim({ issuedListNumber: null })] });
		expect(actions).toEqual([
			{ kind: 'adopt-list-number', checkoutId: 1, listNumber: '35536745-88712' },
		]);
	});

	it('DMs the new number when VAN regenerated the printed list', () => {
		const actions = plan({
			claims: [claim({ turf: turf({ printedListNumber: '77777777-22222' }) })],
		});
		expect(actions).toHaveLength(1);
		const [action] = actions;
		expect(action.kind).toBe('list-number-changed');
		if (action.kind !== 'list-number-changed') throw new Error('wrong action');
		expect(action.slackUserId).toBe('U1');
		expect(action.listNumber).toBe('77777777-22222');
		expect(action.text).toContain('77777777-22222');
	});

	it('says nothing when the printed list disappears entirely', () => {
		// There is no stamp that would make this DM idempotent, and nothing about
		// the volunteer's walk has changed — MiniVAN already has their doors.
		expect(plan({ claims: [claim({ turf: turf({ printedListNumber: null }) })] })).toEqual([]);
	});

	it('releases and explains a turf a refresh emptied', () => {
		const actions = plan({ claims: [claim({ turf: turf({ doorCount: 0 }) })] });
		expect(actions).toHaveLength(1);
		expect(actions[0].kind).toBe('walked-out');
	});

	it('prefers "walked out" to a number change when both apply', () => {
		const actions = plan({
			claims: [claim({ turf: turf({ doorCount: 0, printedListNumber: '77777777-22222' }) })],
		});
		expect(actions.map((a) => a.kind)).toEqual(['walked-out']);
	});

	it('releases a live claim on a retired route without a DM, leaving the notice to the next pass', () => {
		const actions = plan({
			claims: [claim({ turf: turf({ retiredAt: '2026-09-12T17:00:00.000Z', doorCount: 0 }) })],
		});
		expect(actions).toEqual([{ kind: 'release-retired', checkoutId: 1 }]);
	});
});

describe('planReconciliation — re-cut claims', () => {
	it('hands over the replacement route and tells the holder', () => {
		const actions = plan({ recut: [recutClaim()], replacements: [replacement()] });
		expect(actions).toHaveLength(1);
		const [action] = actions;
		if (action.kind !== 'recut-replaced') throw new Error('wrong action');
		expect(action.replacement.mapRouteId).toBe(56502);
		expect(action.slackUserName).toBe('Dana');
		expect(action.text).toContain('99999999-11111');
	});

	it('falls back to "it is gone" when nothing replaced it', () => {
		const actions = plan({ recut: [recutClaim()] });
		expect(actions.map((a) => a.kind)).toEqual(['recut-gone']);
	});

	it('falls back to "it is gone" when the pairing is ambiguous', () => {
		// Two routes with the same name in one region: we cannot tell which piece
		// of ground the volunteer was standing on, and guessing puts two people on
		// one block.
		const actions = plan({
			recut: [recutClaim()],
			replacements: [replacement(), replacement({ mapRouteId: 56503 })],
		});
		expect(actions.map((a) => a.kind)).toEqual(['recut-gone']);
	});

	it('stamps an old re-cut without DMing about it', () => {
		const actions = plan({
			recut: [recutClaim({ releasedAt: '2026-08-01T00:00:00.000Z' })],
			replacements: [replacement()],
		});
		expect(actions).toEqual([{ kind: 'recut-stale', checkoutId: 2 }]);
	});

	it('stamps a claim whose release timestamp is unreadable', () => {
		const actions = plan({ recut: [recutClaim({ releasedAt: 'junk' })] });
		expect(actions).toEqual([{ kind: 'recut-stale', checkoutId: 2 }]);
	});
});

describe('findReplacement', () => {
	const target = recutClaim();

	it('matches across casing and inner whitespace', () => {
		expect(findReplacement(target, [replacement({ name: 'turf  01' })])?.mapRouteId).toBe(56502);
	});

	it('will not cross regions', () => {
		expect(findReplacement(target, [replacement({ mapRegionId: 999 })])).toBeNull();
	});

	it('ignores a retired candidate', () => {
		expect(
			findReplacement(target, [replacement({ retiredAt: '2026-09-12T00:00:00Z' })]),
		).toBeNull();
	});

	it('ignores a candidate someone else already holds', () => {
		expect(findReplacement(target, [replacement({ claimed: true })])).toBeNull();
	});

	it('never pairs a route to itself', () => {
		expect(findReplacement(target, [replacement({ mapRouteId: target.mapRouteId })])).toBeNull();
	});
});

describe('the DM text', () => {
	it('leads with the number a volunteer has to type', () => {
		const text = renderListNumberChanged({
			turf: turf({ printedListNumber: '77777777-22222' }),
			listNumber: '77777777-22222',
			appUrl: APP,
		});
		expect(text.split('\n').slice(0, 4).join('\n')).toContain('77777777-22222');
		expect(text).toContain(`${APP}/turfs?chapter=7`);
	});

	it('says what to do when the replacement has no list number yet', () => {
		const text = renderRecutReplaced({
			oldName: 'Turf 01',
			replacement: replacement({ printedListNumber: null }),
			regionName: 'Cambridge North',
			chapterId: 7,
			appUrl: APP,
		});
		expect(text).toContain('no MiniVAN list number yet');
		expect(text).toContain('Ask an organizer');
	});
});
