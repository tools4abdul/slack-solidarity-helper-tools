import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockBlockedIds = vi.hoisted(() => vi.fn());
const mockClaim = vi.hoisted(() => vi.fn());
const mockEndClaim = vi.hoisted(() => vi.fn());

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockSetHidden = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => ({ SLACK_SUPERUSER_ID: 'U_SUPER' }));
vi.mock('$lib/server/settings.js', () => ({
	loadVanBlockedIds: mockBlockedIds,
	loadSettings: mockLoadSettings,
}));
vi.mock('$lib/server/van/checkout-store.js', () => ({
	claimTurf: mockClaim,
	endClaim: mockEndClaim,
}));
vi.mock('$lib/server/van/turf-hide-store.js', () => ({ setTurfHidden: mockSetHidden }));

const VOLUNTEER = { slackUserId: 'U_VOL', slackUserName: 'Dana', isAdmin: false };

const event = (session: unknown, body: unknown, turfId = '100') =>
	({
		locals: { session },
		params: { turfId },
		request: { json: async () => body } as Request,
	}) as never;

describe('POST /api/turfs/[turfId]', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue({
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockClaim.mockResolvedValue({
			ok: true,
			expiresAt: '2026-08-24T09:00:00.000Z',
			printedListNumber: '35536745-88712',
		});
		mockEndClaim.mockResolvedValue({ ok: true });
	});

	it('returns 401 when not signed in', async () => {
		const res = await POST(event(null, { action: 'claim' }));
		expect(res.status).toBe(401);
		expect(mockClaim).not.toHaveBeenCalled();
	});

	it('returns 403 for a blocked user', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_VOL']));
		const res = await POST(event(VOLUNTEER, { action: 'claim' }));
		expect(res.status).toBe(403);
		expect(mockClaim).not.toHaveBeenCalled();
	});

	it('does not block an admin', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_ADMIN']));
		const res = await POST(
			event({ ...VOLUNTEER, slackUserId: 'U_ADMIN', isAdmin: true }, { action: 'claim' }),
		);
		expect(res.status).toBe(200);
	});

	it('claims and returns the list number', async () => {
		const res = await POST(event(VOLUNTEER, { action: 'claim' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			expiresAt: '2026-08-24T09:00:00.000Z',
			printedListNumber: '35536745-88712',
		});
	});

	it('refuses a claim from a volunteer who has not given a name yet', async () => {
		const unnamed = {
			slackUserId: 'apple:001.abc',
			slackUserName: '',
			isAdmin: false,
			authProvider: 'apple',
			needsName: true,
		};
		const res = await POST(event(unnamed, { action: 'claim' }));
		expect(res.status).toBe(409);
		expect(mockClaim).not.toHaveBeenCalled();
	});

	it('lets a volunteer with no name yet release or finish turf they hold', async () => {
		const unnamed = { ...VOLUNTEER, slackUserId: 'google:1', needsName: true };
		const res = await POST(event(unnamed, { action: 'release' }));
		expect(res.status).toBe(200);
		expect(mockEndClaim).toHaveBeenCalled();
	});

	it('passes the session identity through rather than trusting the body', async () => {
		// A body-supplied slackUserId would let anyone claim as anyone.
		await POST(event(VOLUNTEER, { action: 'claim', slackUserId: 'U_SOMEONE_ELSE' }));
		expect(mockClaim).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ slackUserId: 'U_VOL', turfId: 100 }),
		);
	});

	it('surfaces a refusal with its own status and message', async () => {
		mockClaim.mockResolvedValue({
			ok: false,
			status: 409,
			message: "Someone's already walking this one. Try another nearby.",
		});
		const res = await POST(event(VOLUNTEER, { action: 'claim' }));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/already walking/);
	});

	it.each([
		['release', 'release'],
		['complete', 'complete'],
	])('routes %s to endClaim', async (action, kind) => {
		const res = await POST(event(VOLUNTEER, { action }));
		expect(res.status).toBe(200);
		expect(mockEndClaim).toHaveBeenCalledWith({}, expect.objectContaining({ kind }));
	});

	it('never returns a list number on release', async () => {
		const res = await POST(event(VOLUNTEER, { action: 'release' }));
		expect(await res.json()).toEqual({ ok: true });
	});

	it.each([
		['an unknown action', { action: 'delete' }],
		['a missing action', {}],
		['a non-string action', { action: 7 }],
	])('rejects %s with 400', async (_label, body) => {
		const res = await POST(event(VOLUNTEER, body));
		expect(res.status).toBe(400);
		expect(mockClaim).not.toHaveBeenCalled();
		expect(mockEndClaim).not.toHaveBeenCalled();
	});

	it('refuses hide and unhide from anyone but an admin', async () => {
		for (const action of ['hide', 'unhide']) {
			const res = await POST(event(VOLUNTEER, { action }));
			expect(res.status).toBe(403);
		}
		expect(mockSetHidden).not.toHaveBeenCalled();
	});

	it('lets an admin hide and unhide turf, under their own name', async () => {
		mockSetHidden.mockResolvedValue(true);
		const admin = { ...VOLUNTEER, slackUserId: 'U_ADMIN', slackUserName: 'Alex', isAdmin: true };
		expect((await POST(event(admin, { action: 'hide' }))).status).toBe(200);
		expect((await POST(event(admin, { action: 'unhide' }))).status).toBe(200);
		expect(mockSetHidden.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
			[100, true, { id: 'U_ADMIN', name: 'Alex' }],
			[100, false, { id: 'U_ADMIN', name: 'Alex' }],
		]);
	});

	it('returns 404 when an admin hides turf that is gone', async () => {
		mockSetHidden.mockResolvedValue(false);
		const admin = { ...VOLUNTEER, slackUserId: 'U_ADMIN', isAdmin: true };
		expect((await POST(event(admin, { action: 'hide' }))).status).toBe(404);
	});

	it('rejects a non-numeric route id with 400', async () => {
		const res = await POST(event(VOLUNTEER, { action: 'claim' }, 'not-a-number'));
		expect(res.status).toBe(400);
	});

	// The refusals here are informative — 404 for no such route, 409 with a
	// specific reason otherwise — so walked over a range of ids they are an
	// existence-and-status oracle that sits outside the chapter compartment.
	it('runs out of request budget when probing route ids', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const prober = { ...VOLUNTEER, slackUserId: 'U_PROBER' };
		const statuses: number[] = [];
		for (let id = 1; id <= 80; id++) {
			const res = await POST(event(prober, { action: 'claim' }, String(id)));
			statuses.push(res.status);
		}
		expect(statuses).toContain(429);
		expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(60);
	});

	it('rejects a malformed body with 400 rather than throwing', async () => {
		const res = await POST({
			locals: { session: VOLUNTEER },
			params: { turfId: '100' },
			request: {
				json: async () => {
					throw new Error('bad json');
				},
			} as unknown as Request,
		} as never);
		expect(res.status).toBe(400);
	});
});

// Story 7.4. The page greys out a turf it thinks is unclaimable, but canClaim
// inside claimTurf is what actually refuses — so the enforcing side has to be
// handed the admin's numbers, not checkout.ts's defaults.
describe('POST /api/turfs/[turfId] — configured claim options', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockClaim.mockResolvedValue({
			ok: true,
			expiresAt: '2026-08-24T09:00:00.000Z',
			printedListNumber: '35536745-88712',
		});
		mockEndClaim.mockResolvedValue({ ok: true });
		mockLoadSettings.mockResolvedValue({
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});
	});

	it('passes the settings TTL and cap to claimTurf', async () => {
		mockLoadSettings.mockResolvedValue({
			vanTurfClaimTtlHours: 12,
			vanTurfMaxConcurrentClaims: 5,
		});

		await POST(event(VOLUNTEER, { action: 'claim' }));

		expect(mockClaim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ options: { ttlHours: 12, maxConcurrentClaims: 5 } }),
		);
	});

	it('does not fall back to the built-in defaults once configured', async () => {
		mockLoadSettings.mockResolvedValue({
			vanTurfClaimTtlHours: 1,
			vanTurfMaxConcurrentClaims: 1,
		});

		await POST(event(VOLUNTEER, { action: 'claim' }));

		const options = mockClaim.mock.calls[0]![1].options as Record<string, number>;
		expect(options).toEqual({ ttlHours: 1, maxConcurrentClaims: 1 });
	});

	// Release and complete carry no TTL and no cap, so they must not pay for a
	// settings read on every call.
	it.each([['release'], ['complete']])('does not read settings to %s', async (action) => {
		await POST(event(VOLUNTEER, { action }));
		expect(mockLoadSettings).not.toHaveBeenCalled();
	});
});
