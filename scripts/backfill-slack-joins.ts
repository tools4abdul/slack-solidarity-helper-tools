/**
 * One-time backfill: scan every existing Slack workspace member and write a row
 * to `slack_joins` for each one. Safe to re-run — uses INSERT OR IGNORE on the
 * unique index on slack_user_id.
 *
 * For each non-bot, non-deleted Slack user with an email it will:
 *   1. Read joined_at from users.info: prefer `date_joined`, fall back to
 *      `created`, else leave NULL.
 *   2. Look up Solidarity chapter_ids by email (best-effort — null is fine).
 *   3. INSERT OR IGNORE into slack_joins.
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.local scripts/backfill-slack-joins.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/backfill-slack-joins.ts
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN, SOLIDARITY_API_TOKEN,
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { WebClient } from '@slack/web-api';
import { dbConfig } from '../bin/db-config.js';
import { fetchWithRetry } from '../src/lib/server/solidarity-paginate.js';
import { chapterIdsOf } from '../src/lib/server/solidarity-chapter-ids.js';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const SOLIDARITY_API_TOKEN = process.env.SOLIDARITY_API_TOKEN ?? '';

for (const [key, val] of Object.entries({ SLACK_BOT_TOKEN, SOLIDARITY_API_TOKEN })) {
	if (!val) {
		console.error(`Missing required env var: ${key}`);
		process.exit(1);
	}
}

const bot = new WebClient(SLACK_BOT_TOKEN);
const db = createClient(dbConfig);

// ---------------------------------------------------------------------------
// Solidarity API
// ---------------------------------------------------------------------------

interface SolidarityUser {
	chapter_id: number | null;
	chapter_ids: number[];
}

async function getSolidarityUser(email: string): Promise<SolidarityUser | null> {
	const url = `https://api.solidarity.tech/v1/users?email=${encodeURIComponent(email)}&_limit=1`;
	// Bounded 429 retry via the shared helper — the previous hand-rolled version
	// recursed with no budget and could spin forever on a persistent rate limit.
	const res = await fetchWithRetry(
		url,
		{ headers: { Authorization: `Bearer ${SOLIDARITY_API_TOKEN}` } },
		`user lookup for ${email}`,
		'backfill',
		{ retriesUsed: 0 },
	);
	if (!res.ok) return null;
	const data = (await res.json()) as { data?: SolidarityUser[] };
	return data.data?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SlackUserDates {
	date_joined?: number;
	created?: number;
}

function resolveJoinedAt(user: SlackUserDates): string | null {
	const ts = user.date_joined ?? user.created;
	if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
	return new Date(ts * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Stats {
	total: number;
	skipped: number;
	noSolidarity: number;
	inserted: number;
	alreadyExists: number;
	noJoinDate: number;
	errors: number;
}

async function main() {
	if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

	const stats: Stats = {
		total: 0,
		skipped: 0,
		noSolidarity: 0,
		inserted: 0,
		alreadyExists: 0,
		noJoinDate: 0,
		errors: 0,
	};

	let printedSampleUser = false;
	let cursor: string | undefined;

	do {
		const page = await bot.users.list({ limit: 200, cursor });
		const nextCursor = (page.response_metadata as { next_cursor?: string } | undefined)
			?.next_cursor;
		cursor = nextCursor || undefined;

		const members = (page.members ?? []) as Array<{
			id: string;
			is_bot?: boolean;
			deleted?: boolean;
			profile?: { email?: string };
		}>;

		for (const member of members) {
			stats.total++;

			if (member.is_bot || member.deleted || !member.id) {
				stats.skipped++;
				continue;
			}

			const info = await bot.users.info({ user: member.id });
			const fullUser = info.user as
				(SlackUserDates & { id: string; profile?: { email?: string } }) | undefined;

			if (!printedSampleUser && fullUser && !member.is_bot) {
				console.log('--- sample users.info payload (first non-bot) ---');
				console.log(JSON.stringify(fullUser, null, 2));
				console.log('--- end sample ---\n');
				printedSampleUser = true;
			}

			const email = fullUser?.profile?.email;
			if (!email) {
				stats.skipped++;
				continue;
			}

			const joinedAt = fullUser ? resolveJoinedAt(fullUser) : null;
			if (joinedAt === null) stats.noJoinDate++;

			const solidarityUser = await getSolidarityUser(email);
			const chapterIds = solidarityUser ? chapterIdsOf(solidarityUser) : [];
			if (!solidarityUser) stats.noSolidarity++;

			const chapterIdsJson = JSON.stringify(chapterIds);

			if (DRY_RUN) {
				console.log(
					`[dry-run] insert: ${member.id} ${email} joined_at=${joinedAt ?? 'NULL'} chapter_ids=${chapterIdsJson}`,
				);
				stats.inserted++;
			} else {
				try {
					const result = await db.execute({
						sql: `INSERT OR IGNORE INTO slack_joins (slack_user_id, email, joined_at, chapter_ids)
						      VALUES (?, ?, ?, ?)`,
						args: [member.id, email, joinedAt, chapterIdsJson],
					});
					if (result.rowsAffected > 0) {
						stats.inserted++;
						console.log(`  inserted ${member.id} (${email})`);
					} else {
						stats.alreadyExists++;
					}
				} catch (err) {
					stats.errors++;
					console.error(
						`  failed to insert ${member.id} (${email}):`,
						err instanceof Error ? err.message : err,
					);
				}
			}

			// Pace Solidarity API calls — ~2 req/s max.
			await sleep(500);
		}
	} while (cursor);

	console.log('\n--- Summary ---');
	console.log(`Total Slack users:       ${stats.total}`);
	console.log(`Skipped (bot/no email):  ${stats.skipped}`);
	console.log(`No Solidarity account:   ${stats.noSolidarity}`);
	console.log(`No join-date field:      ${stats.noJoinDate}`);
	console.log(`Inserted:                ${stats.inserted}${DRY_RUN ? ' (would insert)' : ''}`);
	console.log(`Already existed:         ${stats.alreadyExists}`);
	console.log(`Errors:                  ${stats.errors}`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
