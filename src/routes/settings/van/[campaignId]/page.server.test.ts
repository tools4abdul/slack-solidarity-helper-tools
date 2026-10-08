import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { sql } from 'drizzle-orm';

// One campaign's settings page. The credential goes through the real
// credentialStatus, holding a real-looking key, so "the key is never in the
// page's data" is tested rather than assumed.

const API_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee|0';

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));
vi.mock('$lib/server/env.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/env.js')>()),
	SOLIDARITY_API_TOKEN: 'test-token',
	VAN_EXPORT_JOB_TYPE_ID: 5,
	vanCampaignCredentials: () => ({
		credentials: new Map([
			[
				'primary',
				{ appName: 'otm.app', apiKey: API_KEY, databaseMode: 1, source: 'secret' as const },
			],
		]),
		errors: new Map([['broken', 'VAN_CAMPAIGN_BROKEN is not valid JSON']]),
	}),
}));
vi.mock('$lib/server/google-env.js', () => ({
	sheetsServiceAccountEmail: () => 'tracker@example.iam.gserviceaccount.com',
}));
vi.mock('$lib/server/autocomplete-sources.js', () => ({
	getSolidarityChapters: vi.fn(async () => ({ items: [{ id: 71, name: 'Wayne County' }] })),
}));

import { load } from './+page.server.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

function run(campaignId: string, session: unknown = ADMIN) {
	return load({ locals: { session }, params: { campaignId } } as never) as Promise<
		Record<string, unknown> & {
			campaign: Record<string, unknown>;
			credentials: Record<string, unknown>;
		}
	>;
}

async function insertCustomChapter(name: string): Promise<void> {
	await (holder.db as ReturnType<typeof drizzle>).run(
		sql`INSERT INTO turf_custom_chapters (name, last_edited_by, last_edited_by_name, last_edited_at)
			VALUES (${name}, 'U_ADMIN', 'Alice', 'x')`,
	);
}

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'broken', 0, 'sync', 'sync', 'x')`,
	);
});

describe('access', () => {
	it('redirects a signed-in non-admin, and a visitor', async () => {
		await expect(run('1', { ...ADMIN, isAdmin: false })).rejects.toMatchObject({ status: 302 });
		await expect(run('1', null)).rejects.toMatchObject({ status: 302 });
	});

	it('404s for a campaign that does not exist, or an id that is not one', async () => {
		await expect(run('99')).rejects.toMatchObject({ status: 404 });
		await expect(run('abc')).rejects.toMatchObject({ status: 404 });
	});
});

describe('the page', () => {
	it('describes the credentials without the key', async () => {
		const data = await run('1');
		expect(data.credentials).toEqual({
			secretName: 'VAN_CAMPAIGN_PRIMARY',
			state: 'ok',
			error: null,
			appName: 'otm.app',
			databaseMode: 1,
			source: 'secret',
		});
		// Anywhere in the page's data, not just the credentials block.
		expect(JSON.stringify(data)).not.toContain(API_KEY);
		expect(JSON.stringify(data)).not.toContain('aaaaaaaa');
	});

	it('says why a campaign’s secret cannot be used', async () => {
		const data = await run('2');
		expect(data.credentials).toMatchObject({
			state: 'invalid',
			error: 'VAN_CAMPAIGN_BROKEN is not valid JSON',
		});
		expect(data.campaign).toMatchObject({ name: 'broken', chip: 'new', label: '' });
	});

	// The legacy env var is primary's job type until one is picked; the page
	// says so, rather than showing "None" while geometry is using it.
	it('shows the legacy export job type primary falls back to, and none for others', async () => {
		expect((await run('1')).campaign).toMatchObject({
			exportJobTypeId: null,
			fallbackExportJobTypeId: 5,
		});
		expect((await run('2')).campaign).toMatchObject({ fallbackExportJobTypeId: null });
	});

	it('still renders when the chapter list cannot be read', async () => {
		vi.mocked(getSolidarityChapters).mockRejectedValueOnce(new Error('Solidarity is down'));
		const data = await run('1');
		expect(data.chapters).toEqual([]);
		expect(data.chaptersError).toBe('Solidarity is down');
	});

	// Turf-only chapters are offered for mapping beside Solidarity's, by their
	// negative id — and still offered when Solidarity is down.
	it('lists the admin’s turf-only chapters in the folder picker', async () => {
		await insertCustomChapter('Outreach team');
		expect((await run('1')).chapters).toEqual([
			{ id: -1, name: 'Outreach team' },
			{ id: 71, name: 'Wayne County' },
		]);

		vi.mocked(getSolidarityChapters).mockRejectedValueOnce(new Error('Solidarity is down'));
		expect((await run('1')).chapters).toEqual([{ id: -1, name: 'Outreach team' }]);
	});

	it('labels a turf-only chapter that shares a Solidarity chapter’s name', async () => {
		await insertCustomChapter('Wayne County');
		expect((await run('1')).chapters).toEqual([
			{ id: 71, name: 'Wayne County' },
			{ id: -1, name: 'Wayne County (custom)' },
		]);
	});
});
