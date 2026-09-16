import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { requests } from '$lib/server/schema.js';
import { slack } from '$lib/server/slack.js';
import { WEBHOOK_SECRET, APP_URL } from '$lib/server/env.js';
import { loadSettings } from '$lib/server/settings.js';
import { notifyNewRequest } from '$lib/server/events.js';
import { secretMatches } from '$lib/server/secret-compare.js';

export const GET: RequestHandler = async ({ url }) => {
	if (!secretMatches(url.searchParams.get('secret'), WEBHOOK_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const email = url.searchParams.get('email');
	const name = url.searchParams.get('name');
	const phone = url.searchParams.get('phone');

	const trimmedEmail = typeof email === 'string' ? email.trim() || null : null;
	const trimmedName = typeof name === 'string' ? name.trim() || null : null;
	const trimmedPhone = typeof phone === 'string' ? phone.trim() || null : null;

	if (!trimmedEmail && !trimmedPhone) {
		return json({ error: 'At least one of email or phone is required' }, { status: 400 });
	}

	if (trimmedEmail && !trimmedEmail.includes('@')) {
		return json({ error: 'Invalid email address' }, { status: 400 });
	}

	// Dedup strategy: prefer email match, fall back to phone. Email is the
	// primary identifier (UNIQUE in the schema); phone is a secondary lookup
	// for callers who only have a phone number. We never merge across the two
	// — if email matches one row and phone matches a different row, the email
	// row wins and the phone row is left untouched.
	let newId: number;
	try {
		let existing: { id: number }[] = [];
		if (trimmedEmail !== null) {
			existing = await db
				.select({ id: requests.id })
				.from(requests)
				.where(eq(requests.email, trimmedEmail))
				.limit(1);
		}
		if (existing.length === 0 && trimmedPhone !== null) {
			existing = await db
				.select({ id: requests.id })
				.from(requests)
				.where(eq(requests.phone, trimmedPhone))
				.limit(1);
		}

		let insertedId: number | null = null;
		if (existing.length === 0) {
			// Two concurrent webhooks for the same new email can both miss the
			// SELECTs above; UNIQUE(email) makes the loser's INSERT conflict.
			// onConflictDoNothing turns that into an empty `returning`, and the
			// loser re-reads the winner's row and takes the update path below.
			const inserted = await db
				.insert(requests)
				.values({
					email: trimmedEmail,
					name: trimmedName,
					phone: trimmedPhone,
					requestedAt: new Date().toISOString(),
				})
				.onConflictDoNothing({ target: requests.email })
				.returning({ id: requests.id });
			if (inserted.length > 0) {
				insertedId = inserted[0]!.id;
			} else if (trimmedEmail !== null) {
				existing = await db
					.select({ id: requests.id })
					.from(requests)
					.where(eq(requests.email, trimmedEmail))
					.limit(1);
			}
		}

		if (insertedId === null) {
			if (existing.length === 0) {
				// Insert conflicted but the winning row vanished before the
				// re-read — a retry will land on one path or the other cleanly.
				return json({ error: 'Conflicting concurrent request — please retry' }, { status: 503 });
			}
			const id = existing[0]!.id;
			await db
				.update(requests)
				.set({
					requestedAt: new Date().toISOString(),
					...(trimmedName !== null && { name: trimmedName }),
				})
				.where(eq(requests.id, id));
			return json({ success: true, email: trimmedEmail, phone: trimmedPhone });
		}
		newId = insertedId;
	} catch (err) {
		// The caller is a Solidarity automation that expects JSON — never let a
		// DB failure surface as SvelteKit's HTML 500 page.
		console.error(
			`[webhook] DB error for ${trimmedEmail ?? trimmedPhone}:`,
			err instanceof Error ? err.message : err,
		);
		return json({ error: 'Database error' }, { status: 500 });
	}

	notifyNewRequest({
		id: newId,
		email: trimmedEmail,
		name: trimmedName,
		phone: trimmedPhone,
	});

	const details = [
		trimmedName,
		trimmedPhone ? `📞 ${trimmedPhone}` : null,
		trimmedEmail ? `\`${trimmedEmail}\`` : null,
	]
		.filter(Boolean)
		.join('  ·  ');

	if ((env as Record<string, string | undefined>)['DEV_SLACK_USER_ID']) {
		console.log(`[webhook] dev mode — would post to Slack: ${details}`);
	} else {
		try {
			// DB-backed tracking channel (env fallback while unset) so edits on
			// /settings apply without a redeploy.
			const { slackTrackingChannelId } = await loadSettings(db);
			await slack.chat.postMessage({
				channel: slackTrackingChannelId,
				text: `Volunteer needs help joining Slack: ${trimmedEmail ?? trimmedPhone}`,
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `:wave: A volunteer needs help joining Slack: ${details}\n<${APP_URL}/pending|View pending requests>`,
						},
					},
				],
			});
			console.log(`[webhook] posted to channel for ${trimmedEmail ?? trimmedPhone}`);
		} catch (err) {
			console.error(
				`[webhook] failed to post for ${trimmedEmail ?? trimmedPhone}:`,
				err instanceof Error ? err.message : err,
			);
			return json({ error: 'Failed to post to Slack' }, { status: 502 });
		}
	}

	return json({ success: true, email: trimmedEmail, phone: trimmedPhone });
};
