import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRun = vi.hoisted(() => vi.fn());
const mockCampaigns = vi.hoisted(() => vi.fn());
const mockLoadCampaign = vi.hoisted(() => vi.fn());
const lockHeld = vi.hoisted(() => ({ value: false }));

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => ({ INTERNAL_CRON_SECRET: 'cron-secret' }));
vi.mock('$lib/server/slack.js', () => ({ postAlert: vi.fn() }));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({ slackTurfChannelId: 'C_TURF' }),
}));
vi.mock('$lib/server/google-env.js', () => ({
	sheetsClient: () => ({ ok: false, error: 'not set' }),
	sheetsServiceAccountEmail: () => null,
}));
vi.mock('$lib/server/van-env.js', () => ({ vanClientFor: vi.fn() }));
vi.mock('$lib/server/van/contact-live.js', () => ({ runContactStage: vi.fn() }));
vi.mock('$lib/server/van/campaigns.js', () => ({ loadCampaign: mockLoadCampaign }));
vi.mock('$lib/server/van/daily-door-report.js', () => ({
	dailyReportCampaigns: mockCampaigns,
	runDailyDoorReport: mockRun,
}));
vi.mock('$lib/server/sync-lock.js', () => ({
	withSyncLock: async (_db: unknown, _name: string, _ttl: number, fn: () => Promise<unknown>) =>
		lockHeld.value ? { skipped: true } : { skipped: false, result: await fn() },
}));

const { POST } = await import('./+server.js');

function post(query = '') {
	const url = new URL(`http://localhost/api/internal/van-daily-report?key=cron-secret${query}`);
	return POST({ url } as never) as Promise<Response>;
}

const CAMPAIGN = { id: 1, credentialKey: 'primary', dailyReportSpreadsheetId: 'sheet-abc' };
const done = { campaignId: 1, day: '2026-10-07', doors: 3, written: true, posted: true };

beforeEach(() => {
	vi.clearAllMocks();
	lockHeld.value = false;
	mockCampaigns.mockResolvedValue([CAMPAIGN]);
	mockRun.mockResolvedValue(done);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/internal/van-daily-report', () => {
	it('rejects a wrong key without running', async () => {
		const url = new URL('http://localhost/api/internal/van-daily-report?key=nope');
		expect(((await POST({ url } as never)) as Response).status).toBe(401);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it('refuses a day that is not a date', async () => {
		expect((await post('&day=yesterday')).status).toBe(400);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it('reports every campaign with a spreadsheet, passing the day and flags through', async () => {
		const res = await post('&day=2026-10-07&slack=1&dry_run=1');
		expect(res.status).toBe(200);
		expect(mockRun).toHaveBeenCalledWith(expect.anything(), CAMPAIGN, {
			day: '2026-10-07',
			announce: true,
			dryRun: true,
		});
		expect(await res.json()).toEqual({ day: '2026-10-07', results: [done] });
	});

	it('reports one named campaign', async () => {
		mockLoadCampaign.mockResolvedValue(CAMPAIGN);
		await post('&day=2026-10-07&campaign=1');
		expect(mockLoadCampaign).toHaveBeenCalledWith({}, 1);
		expect(mockCampaigns).not.toHaveBeenCalled();
		expect(mockRun.mock.calls[0]![2]).toEqual({
			day: '2026-10-07',
			announce: false,
			dryRun: false,
		});
	});

	it('400s for a named campaign with no report spreadsheet', async () => {
		mockLoadCampaign.mockResolvedValue({ ...CAMPAIGN, dailyReportSpreadsheetId: null });
		expect((await post('&campaign=1')).status).toBe(400);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it('404s for a campaign that does not exist', async () => {
		mockLoadCampaign.mockResolvedValue(null);
		expect((await post('&campaign=9')).status).toBe(404);
	});

	it('answers 500 when a report failed, so the caller sees it', async () => {
		mockRun.mockResolvedValue({ ...done, written: false, error: 'Google answered 403' });
		expect((await post('&day=2026-10-07')).status).toBe(500);
	});

	it('skips a campaign another run is already writing', async () => {
		lockHeld.value = true;
		const res = await post('&day=2026-10-07');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			day: '2026-10-07',
			results: [{ campaignId: 1, skipped: true }],
		});
	});
});
