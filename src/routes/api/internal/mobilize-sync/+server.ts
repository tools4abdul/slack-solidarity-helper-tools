import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runMobilizeSync } from '$lib/server/mobilize-sync.js';
import { alertForMobilizeSync } from '$lib/server/slack.js';
import { INTERNAL_CRON_SECRET, MOBILIZE_API_KEY, SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { withSyncLock } from '$lib/server/sync-lock.js';
import { mrkdwnLink } from '$lib/server/slack-mrkdwn.js';
import { CAMPAIGN_TIMEZONE } from '../../../../../mobilize-migrator/lib/payload.js';

/** A shift's start, in the campaign's timezone — "Sat, Sep 12, 6:00 PM". Enough
 *  to tell two shifts on one event apart at a glance. */
function shiftDay(startDate: number): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: CAMPAIGN_TIMEZONE,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(startDate * 1000));
}

// Internal endpoint called by GitHub Actions to mirror upcoming Solidarity
// events into Mobilize. Auth via ?key=<INTERNAL_CRON_SECRET>.
//
//   ?dry=1        plan and report without writing
//   ?maxCreates=N raise the create guardrail for a deliberate bulk run
//   ?budgetMs=N   override how long one request may spend before it stops
//   ?quiet=1      skip the Slack summary when nothing was CREATED
//
// Idempotent: a Turso ledger records every event created, so repeated runs
// update rather than duplicate. Safe to fire several times a night, which
// matters because GitHub cron is best-effort (see door-knock-snapshot.yml).
//
// One request is deliberately NOT the whole sync. It stops starting writes at
// its time budget and answers `incomplete: true`; the caller re-posts until that
// is false. fly-proxy autostops a machine using concurrency limits that ignore
// requests in flight, so a long request is killed mid-write and answers 502 —
// see the budget note in $lib/server/mobilize-sync.ts.
//
// Runs are serialized on a lock, like the attendee sync. At two runs a night
// overlap was barely possible; on the 30-minute schedule it is routine, and two
// passes planning from the same ledger snapshot would both decide the same event
// needs creating.

const SYNC_LOCK_NAME = 'mobilize-sync';

// Bounds ONE request, not the whole chunked loop — each chunk is its own POST
// and takes the lock afresh. So this only has to exceed a single request's time
// budget (120s by default) plus the write it was in the middle of when the
// budget ran out; 10 minutes is well clear of the caller's 300s `--max-time`.
const SYNC_LOCK_TTL_MS = 10 * 60 * 1000;

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[mobilize-sync] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Bound after auth so an unauthenticated request can never trigger a post.
	const alert = await alertForMobilizeSync('mobilize-sync', db);
	if (!SOLIDARITY_API_TOKEN) {
		return json({ error: 'SOLIDARITY_API_TOKEN is not set' }, { status: 500 });
	}
	if (!MOBILIZE_API_KEY) {
		await alert(
			':warning: Mobilize sync is not configured — MOBILIZE_API_KEY is unset, so no events are being mirrored.',
		);
		return json({ error: 'MOBILIZE_API_KEY is not set' }, { status: 500 });
	}

	const dryRun = url.searchParams.get('dry') === '1';
	const maxCreatesParam = url.searchParams.get('maxCreates');
	const maxCreates = maxCreatesParam ? Number(maxCreatesParam) : undefined;
	// The cap is the one thing standing between a broken plan and a pile of
	// public events, so a value it cannot understand has to stop the run.
	// `parseInt('all', 10)` is NaN, `NaN ?? MOBILIZE_SYNC_MAX_CREATES` stays
	// NaN, and `toCreate.length > NaN` is false — an unvalidated junk value
	// does not raise the limit, it deletes it. An operator typing
	// `?maxCreates=all` means "no limit" and would get exactly the flood this
	// guard exists to prevent.
	if (maxCreatesParam && (!Number.isInteger(maxCreates) || maxCreates! < 0)) {
		return json({ error: `invalid maxCreates: ${maxCreatesParam}` }, { status: 400 });
	}
	const budgetParam = url.searchParams.get('budgetMs');
	const budgetMs = budgetParam ? Number(budgetParam) : undefined;
	if (budgetParam && (!Number.isInteger(budgetMs) || budgetMs! <= 0)) {
		return json({ error: `invalid budgetMs: ${budgetParam}` }, { status: 400 });
	}
	// The 30-minute schedule sets this. An event that reports the same edit on
	// every pass — an image Mobilize keeps dropping, say — would otherwise post
	// the same Slack line 48 times a day and train everyone to ignore the
	// channel. Creates, failures and stopped runs still alert either way.
	const quiet = url.searchParams.get('quiet') === '1';

	try {
		const run = await withSyncLock(db, SYNC_LOCK_NAME, SYNC_LOCK_TTL_MS, () =>
			runMobilizeSync(db, { apply: !dryRun, maxCreates, budgetMs }),
		);

		// 200, not 409: the schedules overlap by design and the caller uses
		// `curl --fail-with-body`, so a 4xx would turn an ordinary skip into a red
		// run. Matches the attendee sync.
		if (run.skipped) {
			console.log('[mobilize-sync] skipped — another sync is already running');
			return json({ skipped: true, reason: 'another Mobilize sync is already running' });
		}
		const result = run.result;

		console.log(
			`[mobilize-sync]${dryRun ? ' (dry)' : ''} planned ${result.planned}: ` +
				`created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, ` +
				`existing ${result.skippedExisting}, no-address ${result.skippedNoAddress}, ` +
				`tag-excluded ${result.excludedByTag} (${result.excludedStillLive} already live), ` +
				`failed ${result.failed}` +
				(result.zeroCapStillOpen.length > 0
					? `, stuck-open ${result.zeroCapStillOpen.length}`
					: '') +
				(result.incomplete ? `, INCOMPLETE — ${result.pending} not reached` : ''),
		);

		// A rejected key is the one failure that always needs a human.
		if (result.authFailed) {
			await alert(
				':rotating_light: *Mobilize sync stopped — Mobilize rejected the API key.*\n' +
					'New events are no longer being mirrored from Solidarity. Check that `MOBILIZE_API_KEY` ' +
					'is set on the Fly app and still has write access, then run ' +
					"`fly secrets set MOBILIZE_API_KEY='<key>'`.",
			);
		} else if (result.abortedReason) {
			await alert(
				`:warning: *Mobilize sync aborted.* ${result.abortedReason}\n` +
					'Nothing was created. Re-run with `?maxCreates=N` once the plan looks right.',
			);
		} else if (!dryRun && (result.created > 0 || (result.updated > 0 && !quiet))) {
			// A big night runs as several chunks, so say so — otherwise three of
			// these in a row reads like the sync fired three times.
			const lines = [
				`:calendar: Mobilize sync: created ${result.created}, updated ${result.updated}.` +
					(result.incomplete ? ` Still working — ${result.pending} to go.` : ''),
				...result.createdTitles.slice(0, 10).map((t) => `• new: ${t}`),
			];
			if (result.createdTitles.length > 10) {
				lines.push(`• …and ${result.createdTitles.length - 10} more`);
			}
			// Named here rather than in an alert of its own: it repeats every run
			// until someone deletes the duplicate in Solidarity, and this message
			// only goes out on a run that did something.
			for (const duplicate of result.duplicateSessions.slice(0, 5)) {
				lines.push(
					`• :heavy_minus_sign: "${duplicate.title}": session ${duplicate.sessionId} repeats ` +
						`session ${duplicate.keptSessionId}'s exact time — left out, Mobilize takes only one`,
				);
			}
			await alert(lines.join('\n'));
		}

		// Reported however the run went, dry included: it is a live contradiction
		// someone has to go and look at in Mobilize, not something a re-run fixes.
		if (result.zeroCapStillOpen.length > 0) {
			const worst = result.zeroCapStillOpen.slice(0, 8);
			await alert(
				`:mag: *Mobilize sync — ${result.zeroCapStillOpen.length} full shift(s) are still ` +
					'taking signups.*\n' +
					worst
						.map(
							(slot) =>
								`• ${mrkdwnLink(slot.browserUrl, slot.title)} — shift ` +
								`${slot.mobilizeTimeslotId}, ${shiftDay(slot.startDate)}`,
						)
						.join('\n') +
					(result.zeroCapStillOpen.length > worst.length
						? `\n• …and ${result.zeroCapStillOpen.length - worst.length} more`
						: '') +
					'\nWe last capped these at 0 seats, but Mobilize reports them as not full. Either a ' +
					'waitlist is switched on for the shift in Mobilize — which takes signups instead of ' +
					'turning people away, and has no API field for us to read — or Mobilize is not ' +
					'treating a 0 cap as closed. Opening one in Mobilize says which.',
			);
		}

		if (result.failed > 0) {
			await alert(
				`:warning: Mobilize sync had ${result.failed} failure(s):\n` +
					result.errors
						.slice(0, 5)
						.map((e) => `• ${e}`)
						.join('\n'),
			);
		}

		// Surface a stopped sync as a non-200 so the workflow run goes red too.
		const status = result.authFailed || result.abortedReason ? 503 : 200;
		return json(result, { status });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[mobilize-sync] failed:', msg);
		await alert(`:x: Mobilize sync failed: ${msg}`);
		return json({ error: msg }, { status: 500 });
	}
};
