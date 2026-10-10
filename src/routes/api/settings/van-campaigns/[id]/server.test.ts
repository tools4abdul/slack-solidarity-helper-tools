import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// One campaign's settings, on a real in-memory database: the label clash, the
// enable checks and the disable stamps are all reads and writes of the row.
// Only VAN is faked.

const { holder, mockClientFor, mockFolders } = vi.hoisted(() => ({
	holder: { db: null as unknown },
	mockClientFor: vi.fn(),
	mockFolders: vi.fn(),
}));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));
vi.mock('$lib/server/van-env.js', () => ({ vanClientFor: mockClientFor }));

import { PATCH } from './+server.js';
import { campaignsStalestFirst } from '$lib/server/van/campaigns.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

function patch(body: unknown, opts: { id?: string; session?: unknown } = {}) {
	return PATCH({
		locals: { session: opts.session === undefined ? ADMIN : opts.session },
		params: { id: opts.id ?? '2' },
		request: { json: async () => body },
	} as never);
}

async function row(id = 2) {
	const res = await client.execute({ sql: 'SELECT * FROM van_campaigns WHERE id = ?', args: [id] });
	return res.rows[0]!;
}

async function mapFolder() {
	await client.execute(
		`INSERT INTO van_chapter_folders
		   (campaign_id, chapter_id, folder_id, chapter_name,
		    last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 71, 1, 'Wayne County', 'test', 'test', 'x')`,
	);
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	holder.db = db;
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(`UPDATE van_campaigns SET label = 'One Team Michigan' WHERE id = 1`);
	// A partner campaign as the sync registers one: off, unnamed.
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'abdul', 0, 'sync', 'sync', 'x')`,
	);
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	mockFolders.mockResolvedValue([{ folderId: 1, name: 'Wayne' }]);
	mockClientFor.mockReturnValue({ ok: true, client: { folders: mockFolders } });
});

describe('auth', () => {
	it('401s without a session', async () => {
		expect((await patch({ label: 'x' }, { session: null })).status).toBe(401);
	});

	it('403s for a signed-in non-admin', async () => {
		const res = await patch({ label: 'x' }, { session: { ...ADMIN, isAdmin: false } });
		expect(res.status).toBe(403);
		expect((await row()).label).toBeNull();
	});
});

describe('which campaign', () => {
	it('400s for an id that is not a positive integer', async () => {
		expect((await patch({ label: 'x' }, { id: 'abc' })).status).toBe(400);
		expect((await patch({ label: 'x' }, { id: '0' })).status).toBe(400);
	});

	it('404s for a campaign that does not exist', async () => {
		expect((await patch({ label: 'x' }, { id: '99' })).status).toBe(404);
	});
});

describe('the name', () => {
	it('saves it trimmed, with who changed it', async () => {
		const res = await patch({ label: '  El-Sayed for Senate ' });
		expect(res.status).toBe(200);
		expect(await row()).toMatchObject({
			label: 'El-Sayed for Senate',
			last_edited_by: 'U_ADMIN',
			last_edited_by_name: 'Alice',
		});
	});

	it('clears it when empty, so the campaign goes by its key', async () => {
		await patch({ label: 'Partner' });
		await patch({ label: '   ' });
		expect((await row()).label).toBeNull();
	});

	// Two campaigns with one name would be indistinguishable in the channel
	// and on every turf badge.
	it('refuses a name another campaign has', async () => {
		const res = await patch({ label: 'One Team Michigan' });
		expect(res.status).toBe(409);
		expect((await row()).label).toBeNull();
	});

	it('refuses a name that differs from another campaign’s only by case', async () => {
		const res = await patch({ label: 'one team MICHIGAN' });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain('"One Team Michigan"');
	});

	// Both checks pass before either write; the index on lower(label) is what
	// refuses the second, and it still reads as a clash, not a 500.
	it('refuses the second of two campaigns named alike at the same moment', async () => {
		await client.execute(
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (3, 'third', 0, 'sync', 'sync', 'x')`,
		);
		const results = await Promise.all([
			patch({ label: 'Partner' }, { id: '2' }),
			patch({ label: 'partner' }, { id: '3' }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
	});

	it('lets a campaign save the name it already has', async () => {
		const res = await patch({ label: 'One Team Michigan' }, { id: '1' });
		expect(res.status).toBe(200);
	});

	it('refuses an over-long name', async () => {
		expect((await patch({ label: 'x'.repeat(81) })).status).toBe(400);
	});
});

describe('the turf badge', () => {
	it('saves it trimmed, and clears it to the name when empty', async () => {
		await patch({ badgeLabel: ' El-Sayed ' });
		expect((await row()).badge_label).toBe('El-Sayed');
		await patch({ badgeLabel: '' });
		expect((await row()).badge_label).toBeNull();
	});

	// It is a hint beside the turf name, not an identifier: two campaigns may
	// share one, unlike the name.
	it('may match another campaign’s badge', async () => {
		await client.execute(`UPDATE van_campaigns SET badge_label = 'MI' WHERE id = 1`);
		expect((await patch({ badgeLabel: 'MI' })).status).toBe(200);
	});

	it('refuses one too long for a chip on a phone, or not a string', async () => {
		expect((await patch({ badgeLabel: 'x'.repeat(25) })).status).toBe(400);
		expect((await patch({ badgeLabel: 7 })).status).toBe(400);
	});
});

describe('the switches and fields', () => {
	it('saves the refresh and sheets switches', async () => {
		await patch({ refreshEnabled: true });
		await patch({ sheetsEnabled: true });
		expect(await row()).toMatchObject({ refresh_enabled: 1, sheets_enabled: 1 });
	});

	// "false" is truthy: taking strings would let a bad client switch re-cuts on.
	it('takes a switch only as a real boolean', async () => {
		expect((await patch({ refreshEnabled: 'false' })).status).toBe(400);
		expect((await row()).refresh_enabled).toBe(0);
	});

	it('saves the tab name, and clears it to the default when empty', async () => {
		await patch({ sheetTabName: 'Packets' });
		expect((await row()).sheet_tab_name).toBe('Packets');
		await patch({ sheetTabName: '' });
		expect((await row()).sheet_tab_name).toBeNull();
	});

	it('refuses a tab name Google would not accept', async () => {
		expect((await patch({ sheetTabName: "Bob's" })).status).toBe(400);
	});

	it('saves the report spreadsheet from its URL, and clears it when empty', async () => {
		const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
		await patch({
			dailyReportSpreadsheetId: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
		});
		expect((await row()).daily_report_spreadsheet_id).toBe(id);
		await patch({ dailyReportSpreadsheetId: '' });
		expect((await row()).daily_report_spreadsheet_id).toBeNull();
	});

	it('refuses a report spreadsheet that is not a Sheets id or URL', async () => {
		expect((await patch({ dailyReportSpreadsheetId: 'my sheet' })).status).toBe(400);
		expect((await patch({ dailyReportSpreadsheetId: 7 })).status).toBe(400);
	});

	it('saves the export job type, or none', async () => {
		await patch({ exportJobTypeId: 5 });
		expect((await row()).export_job_type_id).toBe(5);
		await patch({ exportJobTypeId: null });
		expect((await row()).export_job_type_id).toBeNull();
		expect((await patch({ exportJobTypeId: 0 })).status).toBe(400);
		expect((await patch({ exportJobTypeId: '5' })).status).toBe(400);
	});

	it('refuses a body that changes nothing', async () => {
		expect((await patch({})).status).toBe(400);
		expect((await patch({ apiKey: 'x' })).status).toBe(400);
	});
});

describe('enabling', () => {
	it('refuses while no folder is mapped', async () => {
		const res = await patch({ enabled: true });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain('Map at least one VAN folder');
		expect((await row()).enabled).toBe(0);
	});

	it('refuses without working credentials', async () => {
		await mapFolder();
		mockClientFor.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_ABDUL is not set' });
		const res = await patch({ enabled: true });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain('VAN_CAMPAIGN_ABDUL is not set');
	});

	// Asked of VAN at the moment of enabling, not remembered from a test.
	it('refuses when VAN rejects the key', async () => {
		await mapFolder();
		mockFolders.mockRejectedValue(new Error('VAN /folders returned 401'));
		const res = await patch({ enabled: true });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain('VAN refused its key');
		expect((await row()).enabled).toBe(0);
	});

	it('enables a campaign with a working key and a mapped folder', async () => {
		await mapFolder();
		const res = await patch({ enabled: true });
		expect(res.status).toBe(200);
		expect(await row()).toMatchObject({ enabled: 1, disabled_at: null, disabled_by_name: null });
	});
});

describe('disabling', () => {
	it('stamps who disabled it and when, and the sync then skips it', async () => {
		const res = await patch({ enabled: false }, { id: '1' });
		expect(res.status).toBe(200);
		expect(await row(1)).toMatchObject({ enabled: 0, disabled_by_name: 'Alice' });
		expect((await row(1)).disabled_at).toEqual(expect.any(String));
		expect((await campaignsStalestFirst(db)).map((c) => c.id)).not.toContain(1);
		// Switching off needs nothing from VAN.
		expect(mockFolders).not.toHaveBeenCalled();
	});

	it('clears the stamps when it is enabled again', async () => {
		await patch({ enabled: false }, { id: '1' });
		await client.execute(
			`INSERT INTO van_chapter_folders
			   (campaign_id, chapter_id, folder_id, chapter_name,
			    last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (1, 71, 1, 'Wayne County', 'test', 'test', 'x')`,
		);
		await patch({ enabled: true }, { id: '1' });
		expect(await row(1)).toMatchObject({ enabled: 1, disabled_at: null, disabled_by_name: null });
	});
});
