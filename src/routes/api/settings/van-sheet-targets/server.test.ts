import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSave = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockLoad = vi.hoisted(() => vi.fn());
const mockSheetsClient = vi.hoisted(() => vi.fn());
const mockDescribe = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/settings.js', () => ({
	saveVanSheetTarget: mockSave,
	deleteVanSheetTarget: mockDelete,
	loadVanSheetTargets: mockLoad,
}));
vi.mock('$lib/server/google-env.js', () => ({ sheetsClient: mockSheetsClient }));

const authed = {
	locals: { session: { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U_VOL', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return { ...session, request: { json: async () => body } as Request };
}

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const save = (over: Record<string, unknown> = {}) => ({
	action: 'save',
	prefix: 'R10C',
	spreadsheetId: SHEET_ID,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	mockLoad.mockResolvedValue([]);
	mockDescribe.mockResolvedValue({
		ok: true,
		value: { title: 'R10C_Downriver CR', hasTab: true, tabs: [] },
	});
	mockSheetsClient.mockReturnValue({ ok: true, client: { describe: mockDescribe } });
});

describe('auth', () => {
	it('401s without a session', async () => {
		const res = await POST(makeEvent(unauthed, save()) as never);
		expect(res.status).toBe(401);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('403s for a signed-in non-admin', async () => {
		const res = await POST(makeEvent(nonAdmin, save()) as never);
		expect(res.status).toBe(403);
		expect(mockSave).not.toHaveBeenCalled();
	});
});

describe('the spreadsheet name', () => {
	// The name is never typed. Reading it from Google is what stops the label in
	// a Slack alert drifting from the sheet it names.
	it('is read from Google and stored with the rule', async () => {
		const res = await POST(makeEvent(authed, save()) as never);

		expect(res.status).toBe(200);
		expect(mockDescribe).toHaveBeenCalledWith(expect.objectContaining({ spreadsheetId: SHEET_ID }));
		expect(mockSave).toHaveBeenCalledWith(
			{},
			{ prefix: 'R10C', label: 'R10C_Downriver CR', spreadsheetId: SHEET_ID },
			{ id: 'U_ADMIN', name: 'Alice' },
		);
	});

	// The page has to be usable before the credential lands — that is the whole
	// reason rules can be written pre-launch.
	it('falls back to the id when no credential is configured', async () => {
		mockSheetsClient.mockReturnValue({ ok: false, error: 'not set' });

		const res = await POST(makeEvent(authed, save()) as never);

		expect(res.status).toBe(200);
		expect(mockSave.mock.calls[0]![1].label).toBe(SHEET_ID);
	});

	it('falls back to the id when the sheet is not shared with us yet', async () => {
		mockDescribe.mockResolvedValue({ ok: false, status: 403, error: 'no access' });

		await POST(makeEvent(authed, save()) as never);

		expect(mockSave.mock.calls[0]![1].label).toBe(SHEET_ID);
	});

	it('saves anyway when the lookup throws', async () => {
		mockDescribe.mockRejectedValue(new Error('socket hang up'));

		const res = await POST(makeEvent(authed, save()) as never);

		expect(res.status).toBe(200);
		expect(mockSave.mock.calls[0]![1].label).toBe(SHEET_ID);
	});

	it('ignores a label a client tries to supply', async () => {
		await POST(makeEvent(authed, save({ label: 'Something I typed' })) as never);

		expect(mockSave.mock.calls[0]![1].label).toBe('R10C_Downriver CR');
	});
});

describe('validation', () => {
	it('accepts a pasted spreadsheet URL and stores just the id', async () => {
		await POST(
			makeEvent(
				authed,
				save({ spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` }),
			) as never,
		);

		expect(mockSave.mock.calls[0]![1].spreadsheetId).toBe(SHEET_ID);
	});

	it('refuses an empty prefix', async () => {
		const res = await POST(makeEvent(authed, save({ prefix: '   ' })) as never);
		expect(res.status).toBe(400);
		expect(mockSave).not.toHaveBeenCalled();
	});

	// A punctuation-only rule normalises to '', which would match every region
	// name ever cut and silently become the campaign's catch-all.
	it('refuses a prefix that normalises to nothing', async () => {
		const res = await POST(makeEvent(authed, save({ prefix: '___...' })) as never);
		expect(res.status).toBe(400);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('refuses something that is not a spreadsheet id', async () => {
		const res = await POST(makeEvent(authed, save({ spreadsheetId: 'nope' })) as never);
		expect(res.status).toBe(400);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('refuses an unknown action', async () => {
		const res = await POST(makeEvent(authed, save({ action: 'drop' })) as never);
		expect(res.status).toBe(400);
	});

	it('refuses a body that is not JSON', async () => {
		const event = {
			...authed,
			request: {
				json: async () => {
					throw new Error('bad');
				},
			} as unknown as Request,
		};
		const res = await POST(event as never);
		expect(res.status).toBe(400);
	});
});

describe('remove', () => {
	it('deletes by the normalised key and returns the remaining rules', async () => {
		mockLoad.mockResolvedValue([
			{ prefix: 'R09A', prefixKey: 'r09a', label: 'x', spreadsheetId: 'y' },
		]);

		const res = await POST(makeEvent(authed, { action: 'remove', prefixKey: 'r10c' }) as never);

		expect(res.status).toBe(200);
		expect(mockDelete).toHaveBeenCalledWith({}, 'r10c', { id: 'U_ADMIN', name: 'Alice' });
		expect((await res.json()).targets).toHaveLength(1);
		// No Google round trip to delete a rule.
		expect(mockDescribe).not.toHaveBeenCalled();
	});

	it('refuses a remove with no key', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove' }) as never);
		expect(res.status).toBe(400);
		expect(mockDelete).not.toHaveBeenCalled();
	});
});
