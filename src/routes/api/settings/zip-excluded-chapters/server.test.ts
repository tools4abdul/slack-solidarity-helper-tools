import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSaveExcluded = vi.hoisted(() => vi.fn());
const mockDeleteExcluded = vi.hoisted(() => vi.fn());
const mockValidateChapter = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/settings', () => ({
	saveZipExcludedChapter: mockSaveExcluded,
	deleteZipExcludedChapter: mockDeleteExcluded,
}));
vi.mock('$lib/server/settings-validation', () => ({
	validateSolidarityChapter: mockValidateChapter,
}));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('POST /api/settings/zip-excluded-chapters', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveExcluded.mockResolvedValue(undefined);
		mockDeleteExcluded.mockResolvedValue(undefined);
		mockValidateChapter.mockResolvedValue({ ok: true, name: 'Michigan for Abdul' });
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(makeEvent(unauthed, { action: 'add', chapterId: 1008 }) as never);
		expect(res.status).toBe(401);
		expect(mockSaveExcluded).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, { action: 'add', chapterId: 1008 }) as never);
		expect(res.status).toBe(403);
		expect(mockSaveExcluded).not.toHaveBeenCalled();
	});

	it('returns 400 for an unknown action and for a missing/non-integer chapterId', async () => {
		for (const body of [
			{ action: 'toggle', chapterId: 1008 },
			{ action: 'add', chapterId: '1008' },
			{ action: 'add', chapterId: 1.5 },
			{ action: 'add' },
		]) {
			const res = await POST(makeEvent(authed, body) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveExcluded).not.toHaveBeenCalled();
		expect(mockDeleteExcluded).not.toHaveBeenCalled();
	});

	it('add: validates against the live chapter list, then saves', async () => {
		const res = await POST(makeEvent(authed, { action: 'add', chapterId: 1008 }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockValidateChapter).toHaveBeenCalledWith('tok', 1008);
		expect(mockSaveExcluded).toHaveBeenCalledWith(
			expect.anything(),
			{ chapterId: 1008 },
			{ id: 'U123', name: 'Alice' },
		);
	});

	it('add: 400 for an unknown chapter id, nothing written', async () => {
		mockValidateChapter.mockResolvedValue({
			ok: false,
			error: 'Not a valid Solidarity chapter choice.',
			transient: false,
		});
		const res = await POST(makeEvent(authed, { action: 'add', chapterId: 999 }) as never);
		expect(res.status).toBe(400);
		expect(mockSaveExcluded).not.toHaveBeenCalled();
	});

	it('add: 503 when the chapter list is transiently unavailable', async () => {
		mockValidateChapter.mockResolvedValue({ ok: false, error: 'unavailable', transient: true });
		const res = await POST(makeEvent(authed, { action: 'add', chapterId: 1008 }) as never);
		expect(res.status).toBe(503);
		expect(mockSaveExcluded).not.toHaveBeenCalled();
	});

	// The chapters worth excluding from zips are the ones on their way out, so an
	// exclusion must stay liftable after the chapter is deleted in Solidarity.
	it('remove: deletes without live-list validation', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', chapterId: 1008 }) as never);
		expect(res.status).toBe(200);
		expect(mockValidateChapter).not.toHaveBeenCalled();
		expect(mockDeleteExcluded).toHaveBeenCalledWith(expect.anything(), 1008, {
			id: 'U123',
			name: 'Alice',
		});
	});

	it('returns 400 for a non-JSON body', async () => {
		const event = {
			...authed,
			request: {
				json: async () => {
					throw new SyntaxError('bad');
				},
			} as unknown as Request,
		};
		const res = await POST(event as never);
		expect(res.status).toBe(400);
	});
});
