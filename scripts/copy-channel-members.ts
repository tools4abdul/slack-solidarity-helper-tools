/**
 * Invite everyone in one Slack channel into another. Members of the source
 * who are already in the destination are skipped, as are bots and
 * deactivated accounts. Nobody is removed from the source.
 *
 * Usage (from project root):
 *
 *   # Dry-run (default) — lists who WOULD be invited:
 *   npx tsx --env-file=.env.local scripts/copy-channel-members.ts <sourceChannelId> <destChannelId>
 *
 *   # Actually invite:
 *   npx tsx --env-file=.env.local scripts/copy-channel-members.ts <sourceChannelId> <destChannelId> --apply
 *
 * The bot must be able to see both channels — for a private channel that
 * means it has to be a member. Safe to re-run: anyone invited last time is in
 * the destination now and gets skipped.
 *
 * Required env vars: SLACK_BOT_TOKEN
 */

import { WebClient } from '@slack/web-api';
import { errMessage } from '../src/lib/err-message.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const [SOURCE, DEST] = argv.filter((a) => !a.startsWith('--'));
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';

// conversations.invite takes up to 1000 ids per call; stay well under it so a
// failed batch's one-at-a-time retry stays short.
const INVITE_CHUNK_SIZE = 100;

const slack = new WebClient(SLACK_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Slack helpers
// ---------------------------------------------------------------------------

async function channelMemberIds(channel: string): Promise<Set<string>> {
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await slack.conversations.members({ channel, limit: 1000, cursor });
		for (const id of page.members ?? []) ids.add(id);
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return ids;
}

interface Person {
	id: string;
	name: string;
}

/** Active, non-bot workspace users by id. */
async function humanUsers(): Promise<Map<string, Person>> {
	const users = new Map<string, Person>();
	let cursor: string | undefined;
	do {
		const page = await slack.users.list({ limit: 200, cursor });
		for (const u of page.members ?? []) {
			if (!u.id || u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
			const name = u.profile?.real_name || u.profile?.display_name || u.name || u.id;
			users.set(u.id, { id: u.id, name });
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return users;
}

async function channelName(channel: string): Promise<string> {
	const info = await slack.conversations.info({ channel });
	return info.channel?.name ? `#${info.channel.name}` : channel;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!SLACK_BOT_TOKEN) {
		console.error('SLACK_BOT_TOKEN is not set — run with npx tsx --env-file=.env.local …');
		process.exit(1);
	}
	if (!SOURCE || !DEST) {
		console.error(
			'Usage: copy-channel-members.ts <sourceChannelId> <destChannelId> [--apply]  (see the header comment)',
		);
		process.exit(1);
	}
	if (SOURCE === DEST) {
		console.error('Source and destination are the same channel.');
		process.exit(1);
	}

	const [sourceName, destName, sourceIds, destIds, humans] = await Promise.all([
		channelName(SOURCE),
		channelName(DEST),
		channelMemberIds(SOURCE),
		channelMemberIds(DEST),
		humanUsers(),
	]);

	let skippedNonHuman = 0;
	let alreadyIn = 0;
	const toInvite: Person[] = [];
	for (const id of sourceIds) {
		const person = humans.get(id);
		if (!person) skippedNonHuman++;
		else if (destIds.has(id)) alreadyIn++;
		else toInvite.push(person);
	}

	console.log(`Source:      ${sourceName} (${SOURCE}) — ${sourceIds.size} members`);
	console.log(`Destination: ${destName} (${DEST}) — ${destIds.size} members`);
	console.log(`Already in destination:     ${alreadyIn}`);
	console.log(`Skipped (bot/deactivated):  ${skippedNonHuman}`);
	console.log(`To invite:                  ${toInvite.length}\n`);

	if (toInvite.length === 0) return;

	if (!APPLY) {
		for (const p of toInvite) console.log(`  would invite ${p.name} (${p.id})`);
		console.log('\nDRY RUN — nobody was invited. Re-run with --apply to invite.');
		return;
	}

	let invited = 0;
	const failures: Array<{ person: Person; error: string }> = [];

	// Slack answers a partial failure with one error for the whole call, so a
	// failed batch is retried one person at a time to find who actually failed.
	for (const chunk of chunked(toInvite, INVITE_CHUNK_SIZE)) {
		try {
			await slack.conversations.invite({ channel: DEST, users: chunk.map((p) => p.id).join(',') });
			for (const p of chunk) console.log(`  invited ${p.name} (${p.id})`);
			invited += chunk.length;
		} catch (batchErr) {
			console.warn(
				`  batch of ${chunk.length} failed (${errMessage(batchErr)}) — retrying individually`,
			);
			for (const p of chunk) {
				try {
					await slack.conversations.invite({ channel: DEST, users: p.id });
					console.log(`  invited ${p.name} (${p.id})`);
					invited++;
				} catch (err) {
					const msg = errMessage(err);
					// Joined on their own since we listed members — not a failure.
					if (msg.includes('already_in_channel')) {
						alreadyIn++;
					} else {
						console.error(`  ✗ ${p.name} (${p.id}): ${msg}`);
						failures.push({ person: p, error: msg });
					}
				}
			}
		}
	}

	console.log('\n--- Summary ---');
	console.log(`Invited:  ${invited}`);
	console.log(`Failed:   ${failures.length}`);
	if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
	console.error(errMessage(err));
	process.exit(1);
});
