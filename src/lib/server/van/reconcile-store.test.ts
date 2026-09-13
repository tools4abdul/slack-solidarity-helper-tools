import { describe, it, expect, vi, beforeEach } from 'vitest';

// Typed with the real signature so `mock.calls[0][1]` is the message text
// rather than a tuple of nothing.
const mockSendDm = vi.hoisted(() =>
	vi.fn(async (slackUserId: string, text: string, logTag: string) =>
		Boolean(slackUserId && text && logTag),
	),
);
vi.mock('../slack-dm.js', () => ({ sendDm: mockSendDm }));

import { reconcileClaims } from './reconcile-store.js';

const NOW = new Date('2026-09-12T18:00:00.000Z');
const APP = 'https://app.example';

/**
 * A recording stub of the drizzle chains this module uses.
 *
 * Reads are answered in call order: live claims, re-cut claims, then (only when
 * there are re-cut claims) the replacement candidates and the claims on them.
 */
function makeDb(reads: unknown[][] = [], insertWins = true) {
	const queue = [...reads];
	const updates: Array<Record<string, unknown>> = [];
	const inserts: Array<Record<string, unknown>> = [];

	function query(rows: unknown[]) {
		const thenable = Promise.resolve(rows) as unknown as Record<string, unknown>;
		for (const method of ['from', 'where', 'innerJoin']) thenable[method] = () => thenable;
		return thenable;
	}

	const db = {
		select: () => query(queue.shift() ?? []),
		insert: () => ({
			values: (row: Record<string, unknown>) => {
				inserts.push(row);
				return {
					onConflictDoNothing: () => ({
						returning: async () => (insertWins ? [{ id: 99 }] : []),
					}),
				};
			},
		}),
		update: () => ({
			set: (patch: Record<string, unknown>) => {
				updates.push(patch);
				return { where: async () => undefined };
			},
		}),
	};
	return { db: db as never, updates, inserts };
}

function liveClaim(over: Record<string, unknown> = {}) {
	return {
		checkoutId: 1,
		mapRouteId: 100,
		slackUserId: 'U1',
		slackUserName: 'Dana',
		issuedListNumber: '35536745-88712',
		mapRegionId: 10,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		printedListNumber: '35536745-88712',
		doorCount: 250,
		retiredAt: null,
		...over,
	};
}

function recutRow(over: Record<string, unknown> = {}) {
	return {
		checkoutId: 2,
		mapRouteId: 56456,
		slackUserId: 'U1',
		slackUserName: 'Dana',
		releasedAt: '2026-09-12T17:55:00.000Z',
		mapRegionId: 508413,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		...over,
	};
}

function replacementRow(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 56502,
		mapRegionId: 508413,
		name: 'Turf 01',
		printedListNumber: '99999999-11111',
		doorCount: 180,
		retiredAt: null,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockSendDm.mockResolvedValue(true);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('reconcileClaims — a list number that changed', () => {
	it('DMs the holder and records the number they now have', async () => {
		const { db, updates } = makeDb([[liveClaim({ printedListNumber: '77777777-22222' })], []]);

		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });

		expect(result.listNumbersChanged).toBe(1);
		expect(mockSendDm).toHaveBeenCalledOnce();
		expect(mockSendDm.mock.calls[0][0]).toBe('U1');
		expect(mockSendDm.mock.calls[0][1]).toContain('77777777-22222');
		expect(updates).toEqual([{ issuedListNumber: '77777777-22222' }]);
	});

	it('leaves the record alone when Slack would not take the message', async () => {
		mockSendDm.mockResolvedValue(false);
		const { db, updates } = makeDb([[liveClaim({ printedListNumber: '77777777-22222' })], []]);

		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });

		// Unstamped, so the next tick tries again. The DM is the only way the
		// volunteer learns their number stopped working.
		expect(result.dmFailed).toBe(1);
		expect(result.listNumbersChanged).toBe(0);
		expect(updates).toEqual([]);
	});

	it('adopts a number silently when there is no record of what we issued', async () => {
		const { db, updates } = makeDb([[liveClaim({ issuedListNumber: null })], []]);
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.numbersAdopted).toBe(1);
		expect(mockSendDm).not.toHaveBeenCalled();
		expect(updates).toEqual([{ issuedListNumber: '35536745-88712' }]);
	});

	it('counts a turf with no printed list rather than messaging about it', async () => {
		const { db } = makeDb([[liveClaim({ printedListNumber: null })], []]);
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.missingListNumber).toBe(1);
		expect(mockSendDm).not.toHaveBeenCalled();
	});
});

describe('reconcileClaims — a turf with no doors left', () => {
	it('releases it and says so', async () => {
		const { db, updates } = makeDb([[liveClaim({ doorCount: 0 })], []]);
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });

		expect(result.walkedOut).toBe(1);
		expect(updates).toEqual([{ releasedAt: NOW.toISOString(), releaseReason: 'walked-out' }]);
		expect(mockSendDm).toHaveBeenCalledOnce();
	});

	it('still releases it when the DM fails', async () => {
		// A claim that can only be closed by a successful Slack call is one a
		// deactivated account holds until its TTL runs out.
		mockSendDm.mockResolvedValue(false);
		const { db, updates } = makeDb([[liveClaim({ doorCount: 0 })], []]);
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.walkedOut).toBe(1);
		expect(result.dmFailed).toBe(1);
		expect(updates).toHaveLength(1);
	});
});

describe('reconcileClaims — a turf VAN re-cut', () => {
	it('moves the claim onto the replacement and hands over the new number', async () => {
		const { db, updates, inserts } = makeDb([
			[],
			[recutRow()],
			[replacementRow()],
			[], // nobody holds the replacement
		]);

		const result = await reconcileClaims(db, { now: NOW, appUrl: APP, ttlHours: 48 });

		expect(result.recutReplaced).toBe(1);
		expect(inserts[0]).toMatchObject({
			mapRouteId: 56502,
			slackUserId: 'U1',
			slackUserName: 'Dana',
			issuedListNumber: '99999999-11111',
		});
		// The old row is stamped so the notice never repeats.
		expect(updates).toEqual([{ recutNotifiedAt: NOW.toISOString() }]);
		expect(mockSendDm.mock.calls[0][1]).toContain('99999999-11111');
	});

	it('tells the holder it is gone when the replacement was taken in the gap', async () => {
		const { db, updates } = makeDb(
			[[], [recutRow()], [replacementRow()], []],
			// The insert loses the partial unique index race.
			false,
		);

		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });

		expect(result.recutReplaced).toBe(0);
		expect(result.recutGone).toBe(1);
		expect(updates).toEqual([{ recutNotifiedAt: NOW.toISOString() }]);
		expect(mockSendDm.mock.calls[0][1]).toContain('no longer exists in VAN');
	});

	it('does not offer a replacement somebody else already holds', async () => {
		const { db } = makeDb([
			[],
			[recutRow()],
			[replacementRow()],
			[{ mapRouteId: 56502 }], // claimed
		]);
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.recutGone).toBe(1);
		expect(result.recutReplaced).toBe(0);
	});

	it('stamps an old re-cut without DMing anyone', async () => {
		const { db, updates } = makeDb([
			[],
			[recutRow({ releasedAt: '2026-08-01T00:00:00.000Z' })],
			[replacementRow()],
			[],
		]);
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.recutStale).toBe(1);
		expect(mockSendDm).not.toHaveBeenCalled();
		expect(updates).toEqual([{ recutNotifiedAt: NOW.toISOString() }]);
	});
});

describe('reconcileClaims — failure handling', () => {
	it('returns empty counts rather than throwing when the replacement read fails', async () => {
		// The third read used to sit outside the guard, so a hiccup here failed
		// the whole sync rather than skipping one repair.
		let call = 0;
		const db = {
			select: () => {
				call += 1;
				if (call === 3) throw new Error('database is locked');
				const rows = call === 2 ? [recutRow()] : [];
				const thenable = Promise.resolve(rows) as unknown as Record<string, unknown>;
				for (const m of ['from', 'where', 'innerJoin']) thenable[m] = () => thenable;
				return thenable;
			},
		} as never;

		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.recutGone).toBe(0);
		expect(mockSendDm).not.toHaveBeenCalled();
	});

	it('returns empty counts rather than throwing when the read fails', async () => {
		const db = {
			select: () => {
				throw new Error('database is locked');
			},
		} as never;
		const result = await reconcileClaims(db, { now: NOW, appUrl: APP });
		expect(result.listNumbersChanged).toBe(0);
		expect(result.walkedOut).toBe(0);
	});

	it("carries on after one claim's write fails", async () => {
		let calls = 0;
		const { db } = makeDb([
			[liveClaim({ printedListNumber: 'A' }), liveClaim({ checkoutId: 2, printedListNumber: 'B' })],
			[],
		]);
		const broken = {
			...(db as unknown as Record<string, unknown>),
			update: () => ({
				set: () => ({
					where: async () => {
						calls += 1;
						if (calls === 1) throw new Error('locked');
					},
				}),
			}),
		} as never;

		const result = await reconcileClaims(broken, { now: NOW, appUrl: APP });
		expect(calls).toBe(2);
		expect(result.listNumbersChanged).toBe(1);
	});
});
