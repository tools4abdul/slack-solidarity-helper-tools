import { describe, it, expect } from 'vitest';
import {
	driftAdvice,
	driftLabel,
	driftReport,
	type DriftKind,
	type DriftTurfRow,
} from './turf-drift.js';
import type { ClaimSnapshot } from './checkout.js';

const NOW = new Date('2026-09-05T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function turf(over: Partial<DriftTurfRow> = {}): DriftTurfRow {
	return {
		mapRouteId: 100,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		doorCount: 250,
		printedListNumber: '35536745-88712',
		vanDistributedTo: null,
		retiredAt: null,
		...over,
	};
}

function claim(over: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
	return {
		mapRouteId: 100,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: iso(NOW.getTime() - 5 * HOUR),
		expiresAt: iso(NOW.getTime() + 40 * HOUR),
		releasedAt: null,
		completedAt: null,
		...over,
	};
}

describe('driftReport', () => {
	it('reports nothing when the two systems agree', () => {
		// Neither side has it.
		expect(driftReport([turf()], [], NOW).items).toEqual([]);
		// Both sides have it.
		expect(driftReport([turf({ vanDistributedTo: 'Sam Rivera' })], [claim()], NOW).items).toEqual(
			[],
		);
	});

	// Proof that this campaign uses the export workflow at all. Without one of
	// these in the catalog the report returns `exports-unused` and says nothing,
	// which is correct behaviour and would make the rules below untestable — so
	// the fixtures that are ABOUT those rules carry one.
	const exported = () => turf({ mapRouteId: 999, vanDistributedTo: 'Avery Harbison' });

	it('flags turf claimed here but absent from MiniVAN', () => {
		const { items, claimedNotInMinivan } = driftReport([turf(), exported()], [claim()], NOW);
		expect(claimedNotInMinivan).toBe(1);
		expect(items.find((i) => i.kind === 'claimed-not-in-minivan')).toMatchObject({
			kind: 'claimed-not-in-minivan',
			turfName: 'Turf 01',
			heldBy: 'Dana',
			distributedTo: null,
		});
	});

	it('flags turf in MiniVAN that nobody claimed here', () => {
		const { items, inMinivanNotClaimed } = driftReport(
			[turf({ vanDistributedTo: 'Sam Rivera' })],
			[],
			NOW,
		);
		expect(inMinivanNotClaimed).toBe(1);
		expect(items[0]).toMatchObject({
			kind: 'in-minivan-not-claimed',
			heldBy: null,
			distributedTo: 'Sam Rivera',
		});
	});

	describe('what counts as "claimed"', () => {
		// A claim nobody holds any more is not drift — the turf really is free,
		// and reporting it would send an organizer after a volunteer who already
		// gave it back.
		it.each([
			['released', { releasedAt: iso(NOW.getTime() - HOUR) }],
			['completed', { completedAt: iso(NOW.getTime() - HOUR) }],
			['lapsed', { expiresAt: iso(NOW.getTime() - HOUR) }],
		])('ignores a %s claim', (_label, over) => {
			expect(driftReport([turf()], [claim(over)], NOW).items).toEqual([]);
		});

		// The mirror of the above: with VAN holding it and our claim dead, the
		// turf IS drifting — it reads as free here but is out over there.
		it('treats a dead claim plus a VAN export as drift', () => {
			const report = driftReport(
				[turf({ vanDistributedTo: 'Sam Rivera' })],
				[claim({ releasedAt: iso(NOW.getTime() - HOUR) })],
				NOW,
			);
			expect(report.items.map((i) => i.kind)).toEqual(['in-minivan-not-claimed']);
		});

		it('matches a claim to its own turf only', () => {
			const report = driftReport([turf({ mapRouteId: 100 })], [claim({ mapRouteId: 999 })], NOW);
			expect(report.items).toEqual([]);
		});
	});

	// A re-cut turf is gone from VAN, so "not in MiniVAN" is true and useless.
	// The catalog sync already releases claims on it; reporting it here would
	// bury the real rows under the consequences of a re-cut.
	it('skips retired turf in both directions', () => {
		const retired = { retiredAt: iso(NOW.getTime() - 48 * HOUR) };
		expect(driftReport([turf(retired)], [claim()], NOW).items).toEqual([]);
		expect(
			driftReport([turf({ ...retired, vanDistributedTo: 'Sam Rivera' })], [], NOW).items,
		).toEqual([]);
	});

	describe('ordering', () => {
		// Two people on one doorstep outranks one wasted morning.
		it('puts double-booked turf above dead list numbers', () => {
			const report = driftReport(
				[turf({ mapRouteId: 1 }), turf({ mapRouteId: 2, vanDistributedTo: 'Sam Rivera' })],
				[claim({ mapRouteId: 1 })],
				NOW,
			);
			expect(report.items.map((i) => i.kind)).toEqual([
				'in-minivan-not-claimed',
				'claimed-not-in-minivan',
			]);
		});

		it('ranks bigger turf first within a kind', () => {
			const report = driftReport(
				[
					turf({ mapRouteId: 1, doorCount: 50, vanDistributedTo: 'A' }),
					turf({ mapRouteId: 2, doorCount: 400, vanDistributedTo: 'B' }),
				],
				[],
				NOW,
			);
			expect(report.items.map((i) => i.mapRouteId)).toEqual([2, 1]);
		});

		it('breaks a tie stably', () => {
			const report = driftReport(
				[
					turf({ mapRouteId: 9, vanDistributedTo: 'A' }),
					turf({ mapRouteId: 2, vanDistributedTo: 'B' }),
				],
				[],
				NOW,
			);
			expect(report.items.map((i) => i.mapRouteId)).toEqual([2, 9]);
		});
	});

	// The distinction that keeps the pane honest, and the same shape as 7.5's
	// zero-delta pane: a null column means "no export" OR "we cannot read
	// exports", and those are opposite conclusions.
	describe('when VAN’s side cannot be read', () => {
		it('reports nothing and says why, rather than implying agreement', () => {
			const report = driftReport([turf()], [claim()], NOW, 'van-side-unavailable');
			expect(report).toEqual({
				visibility: 'van-side-unavailable',
				items: [],
				claimedNotInMinivan: 0,
				inMinivanNotClaimed: 0,
			});
		});

		it('would have found drift had the data been legible', () => {
			// Same inputs, visible: proves the empty result above is the
			// visibility flag talking, not an absence of drift.
			expect(
				driftReport([turf(), exported()], [claim()], NOW, 'visible').items.filter(
					(i) => i.kind === 'claimed-not-in-minivan',
				),
			).toHaveLength(1);
		});
	});

	it('reports whether the turf even has a list number', () => {
		const pick = (rows: Parameters<typeof driftReport>[0]) =>
			driftReport(rows, [claim()], NOW).items.find((i) => i.mapRouteId === 100)!;
		expect(pick([turf(), exported()]).hasListNumber).toBe(true);
		// canClaim refuses turf without a number, so a claimed row lacking one
		// means something upstream is wrong — worth surfacing, not hiding.
		expect(pick([turf({ printedListNumber: null }), exported()]).hasListNumber).toBe(false);
	});

	it('counts each kind separately', () => {
		const report = driftReport(
			[
				turf({ mapRouteId: 1 }),
				turf({ mapRouteId: 2 }),
				turf({ mapRouteId: 3, vanDistributedTo: 'Sam' }),
			],
			[claim({ mapRouteId: 1 }), claim({ mapRouteId: 2 })],
			NOW,
		);
		expect(report.claimedNotInMinivan).toBe(2);
		expect(report.inMinivanNotClaimed).toBe(1);
		expect(report.items).toHaveLength(3);
	});

	it('handles an empty catalog', () => {
		expect(driftReport([], [], NOW).items).toEqual([]);
	});
});

describe('driftLabel and driftAdvice', () => {
	const kinds: DriftKind[] = ['claimed-not-in-minivan', 'in-minivan-not-claimed'];

	it.each(kinds)('labels %s', (kind) => {
		expect(driftLabel(kind).length).toBeGreaterThan(0);
	});

	// A report is only useful if the next action is obvious from the row.
	it.each(kinds)('gives actionable advice for %s', (kind) => {
		expect(driftAdvice(kind).length).toBeGreaterThan(0);
	});

	it('tells the two apart', () => {
		expect(driftLabel('claimed-not-in-minivan')).not.toBe(driftLabel('in-minivan-not-claimed'));
		expect(driftAdvice('claimed-not-in-minivan')).not.toBe(driftAdvice('in-minivan-not-claimed'));
	});

	it('names the double-booking risk in the advice for the dangerous one', () => {
		expect(driftAdvice('in-minivan-not-claimed')).toContain('claimed twice');
	});
});

// ---------------------------------------------------------------------------
// The export workflow this campaign does not use
// ---------------------------------------------------------------------------

describe('driftReport: exports-unused', () => {
	// Verified live 2026-09-22: every printed list in the committee was
	// generated after the most recent MiniVAN export, so nothing could match.
	// Organizers hand out list NUMBERS, which load in MiniVAN with no export
	// record. Flagging every claim as "not in MiniVAN" under that workflow is
	// noise that buries the direction that matters.
	it('reports nothing when no turf has ever been exported', () => {
		const report = driftReport(
			[
				turf({ mapRouteId: 1, vanDistributedTo: null }),
				turf({ mapRouteId: 2, vanDistributedTo: null }),
			],
			[claim({ mapRouteId: 1 }), claim({ mapRouteId: 2 })],
			NOW,
		);

		expect(report.visibility).toBe('exports-unused');
		expect(report.items).toEqual([]);
		expect(report.claimedNotInMinivan).toBe(0);
	});

	// The moment one export lands, the check is meaningful again and comes back
	// on its own — no setting to remember.
	it('switches back on as soon as a single turf matches an export', () => {
		const report = driftReport(
			[
				turf({ mapRouteId: 1, vanDistributedTo: null }),
				turf({ mapRouteId: 2, vanDistributedTo: 'Avery Harbison' }),
			],
			[claim({ mapRouteId: 1 })],
			NOW,
		);

		expect(report.visibility).toBe('visible');
		// Turf 2 is exported and unclaimed, so it is drift in the other direction —
		// which is the point: with one real export the comparison works again.
		expect(report.items.map((i) => i.kind).sort()).toEqual([
			'claimed-not-in-minivan',
			'in-minivan-not-claimed',
		]);
	});

	// A retired row keeps whatever it was last distributed to. Counting that as
	// evidence would keep the check alive on the ghost of a workflow that has
	// stopped.
	it('does not count a retired turf as evidence the workflow is in use', () => {
		const report = driftReport(
			[
				turf({ mapRouteId: 1, vanDistributedTo: null }),
				turf({
					mapRouteId: 2,
					vanDistributedTo: 'Avery Harbison',
					retiredAt: '2026-09-01T00:00:00.000Z',
				}),
			],
			[claim({ mapRouteId: 1 })],
			NOW,
		);

		expect(report.visibility).toBe('exports-unused');
	});

	// The distinction that already existed and must survive: "we never looked"
	// outranks "we looked and it is unused".
	it('still reports van-side-unavailable when the key cannot read exports', () => {
		const report = driftReport(
			[turf({ mapRouteId: 1, vanDistributedTo: null })],
			[claim({ mapRouteId: 1 })],
			NOW,
			'van-side-unavailable',
		);

		expect(report.visibility).toBe('van-side-unavailable');
	});
});
