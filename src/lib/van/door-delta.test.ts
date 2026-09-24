import { describe, it, expect } from 'vitest';
import {
	doorDelta,
	planDoorDeltas,
	refreshLandedSince,
	measuredAgainst,
	renderUnsyncedNudge,
	type CompletionCandidate,
	type ReplacementRoute,
} from './door-delta.js';

const NOW = new Date('2026-09-12T18:00:00.000Z');
const APP = 'https://example.test';

function candidate(over: Partial<CompletionCandidate> = {}): CompletionCandidate {
	return {
		checkoutId: 1,
		mapRouteId: 100,
		slackUserId: 'U1',
		slackUserName: 'Dana',
		completedAt: '2026-09-12T12:00:00.000Z',
		claimDoorCount: 250,
		turfName: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		doorCount: 190,
		lastRefreshedAt: '2026-09-12T14:00:00.000Z',
		mapRegionId: 10,
		retiredAt: null,
		...over,
	};
}

function replacement(over: Partial<ReplacementRoute> = {}): ReplacementRoute {
	return {
		mapRouteId: 200,
		mapRegionId: 10,
		name: 'Turf 01',
		doorCount: 190,
		lastRefreshedAt: '2026-09-12T14:00:00.000Z',
		firstSeenAt: '2026-09-12T14:30:00.000Z',
		...over,
	};
}

const plan = (
	completions: CompletionCandidate[],
	over: { horizonMs?: number; replacements?: ReplacementRoute[] } = {},
) => planDoorDeltas({ completions, now: NOW, appUrl: APP, ...over });

describe('refreshLandedSince', () => {
	it('is true only for a refresh after the completion', () => {
		expect(refreshLandedSince(candidate())).toBe(true);
	});

	it('is false for a refresh that predates the completion', () => {
		// It could not have seen the volunteer's knocks, so reading a delta off it
		// would report zero for someone who synced perfectly.
		expect(refreshLandedSince(candidate({ lastRefreshedAt: '2026-09-12T09:00:00.000Z' }))).toBe(
			false,
		);
	});

	it('is false when VAN has never reported a refresh time', () => {
		expect(refreshLandedSince(candidate({ lastRefreshedAt: null }))).toBe(false);
	});

	it('is false when either timestamp is unreadable', () => {
		expect(refreshLandedSince(candidate({ lastRefreshedAt: 'junk' }))).toBe(false);
		expect(refreshLandedSince(candidate({ completedAt: 'junk' }))).toBe(false);
	});
});

describe('doorDelta', () => {
	it('is the doors that left across the claim', () => {
		expect(doorDelta(candidate())).toBe(60);
	});

	it('is null when we never recorded what the turf started at', () => {
		expect(doorDelta(candidate({ claimDoorCount: null }))).toBeNull();
	});

	it('clamps a turf that grew to zero rather than reporting negative doors', () => {
		expect(doorDelta(candidate({ claimDoorCount: 100, doorCount: 140 }))).toBe(0);
	});
});

describe('planDoorDeltas', () => {
	it('stamps a delta when the doors moved, with no message', () => {
		expect(plan([candidate()])).toEqual([{ kind: 'measured', checkoutId: 1, delta: 60 }]);
	});

	it('nudges the volunteer when nothing moved', () => {
		const actions = plan([candidate({ doorCount: 250 })]);
		expect(actions).toHaveLength(1);
		const [action] = actions;
		if (action.kind !== 'unsynced') throw new Error('wrong action');
		expect(action.delta).toBe(0);
		expect(action.slackUserId).toBe('U1');
		expect(action.text).toContain('Sync');
	});

	it('waits rather than guessing while no refresh has landed', () => {
		expect(plan([candidate({ lastRefreshedAt: null })])).toEqual([]);
	});

	it('gives up on a completion older than the horizon', () => {
		// A "did you sync?" nudge about turf walked last month is noise, and a
		// zero stamped without evidence is an accusation.
		expect(plan([candidate({ completedAt: '2026-08-01T12:00:00.000Z' })])).toEqual([]);
	});

	it('leaves a completion we cannot measure unstamped', () => {
		expect(plan([candidate({ claimDoorCount: null })])).toEqual([]);
	});

	it('ignores a completion whose timestamp is unreadable', () => {
		expect(plan([candidate({ completedAt: 'junk' })])).toEqual([]);
	});

	it('handles a page of mixed completions', () => {
		const actions = plan([
			candidate({ checkoutId: 1 }),
			candidate({ checkoutId: 2, doorCount: 250 }),
			candidate({ checkoutId: 3, lastRefreshedAt: null }),
		]);
		expect(actions.map((a) => [a.checkoutId, a.kind])).toEqual([
			[1, 'measured'],
			[2, 'unsynced'],
		]);
	});
});

describe('the nudge text', () => {
	it('asks rather than accuses, and says what to do', () => {
		const text = renderUnsyncedNudge({
			turfName: 'Turf 01',
			regionName: 'Ann Arbor',
			chapterId: 71,
			appUrl: APP,
		});
		expect(text).toContain('Did MiniVAN finish syncing?');
		expect(text).toContain('*Sync*');
		// The out for the case where the volunteer did everything right.
		expect(text).toContain('If you already synced, nothing is wrong');
		expect(text).toContain(`${APP}/turfs?chapter=71`);
	});
});

// A VAN re-cut retires the walked route and returns a new one with a new id, so
// the measurement has to follow the turf to its replacement. Before this, every
// completion's route was retired by the time any re-cut landed, its row never
// updated again, and nothing was ever measured.
describe('measuring a re-cut turf against its replacement', () => {
	const retired = (over: Partial<CompletionCandidate> = {}) =>
		candidate({
			retiredAt: '2026-09-12T14:30:00.000Z',
			// The retired row's own figures are frozen at the last read before
			// the re-cut, so they must NOT be what is measured.
			doorCount: 250,
			lastRefreshedAt: '2026-09-10T00:00:00.000Z',
			...over,
		});

	it('credits the doors that left between the claim and the replacement', () => {
		expect(plan([retired()], { replacements: [replacement({ doorCount: 190 })] })).toEqual([
			{ kind: 'measured', checkoutId: 1, delta: 60 },
		]);
	});

	it('nudges when the replacement came back with every door still in it', () => {
		const [action] = plan([retired()], { replacements: [replacement({ doorCount: 250 })] });
		expect(action!.kind).toBe('unsynced');
	});

	it('matches names loosely, as the reconciliation does', () => {
		const measured = measuredAgainst(retired(), [replacement({ name: '  turf   01 ' })]);
		expect(measured?.doorCount).toBe(190);
	});

	it('takes a route first seen after the completion as evidence of the re-cut', () => {
		const measured = measuredAgainst(retired(), [
			replacement({ lastRefreshedAt: null, firstSeenAt: '2026-09-12T14:30:00.000Z' }),
		]);
		expect(refreshLandedSince(measured!)).toBe(true);
	});

	// The replacement already existed before the volunteer finished, so the cut
	// that produced it could not have seen their knocks.
	it('waits when the replacement predates the completion', () => {
		expect(
			plan([retired()], {
				replacements: [
					replacement({
						lastRefreshedAt: '2026-09-12T08:00:00.000Z',
						firstSeenAt: '2026-09-12T08:30:00.000Z',
					}),
				],
			}),
		).toEqual([]);
	});

	it.each([
		['no replacement at all', []],
		['a replacement in another region', [replacement({ mapRegionId: 11 })]],
		['a differently named route', [replacement({ name: 'Turf 02' })]],
		['two routes with the same name', [replacement(), replacement({ mapRouteId: 201 })]],
	])('leaves it unmeasured with %s, rather than guessing', (_label, replacements) => {
		expect(plan([retired()], { replacements })).toEqual([]);
	});

	it('still measures a route VAN updated in place', () => {
		expect(plan([candidate()], { replacements: [] })).toEqual([
			{ kind: 'measured', checkoutId: 1, delta: 60 },
		]);
	});
});
