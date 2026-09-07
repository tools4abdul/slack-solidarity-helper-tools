// CLI entry point for the attendee sync, for testing it against real data
// without the Fly app or the Turso ledger.
//
//   npx tsx mobilize-migrator/attendee-sync.ts --mobilize-event 812345 --timeslot 6157028 --session 80929 --event 27463
//   ... --apply to write
//
// Dry run by default. The scheduled path is the endpoint
// (src/routes/api/internal/attendee-sync) — this exists so the matching rate can
// be eyeballed on real signups before anything is written to the CRM, since a
// low match rate means the sync would fill Solidarity with duplicate people.

import { runAttendeeSync, type AttendeeLedger, type RsvpRecord } from './lib/attendee-sync.js';
import { requireEnv } from './lib/env.js';
import { loadApiConfig } from './lib/mobilize.js';

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

// Signups are fetched per Mobilize event, so that id is needed alongside the
// shift — the timeslot alone no longer identifies anything fetchable.
const mobilizeEventId = Number(arg('mobilize-event'));
const timeslotId = Number(arg('timeslot'));
const sessionId = Number(arg('session'));
const eventId = Number(arg('event'));
const chapterId = arg('chapter') ? Number(arg('chapter')) : null;
// The session's max_capacity. Omit for uncapped; the endpoint reads it from
// Solidarity, but this CLI is handed one shift and has no event to read it from.
const capacity = arg('capacity') ? Number(arg('capacity')) : null;
const apply = process.argv.includes('--apply');

if (
	!Number.isFinite(mobilizeEventId) ||
	!Number.isFinite(timeslotId) ||
	!Number.isFinite(sessionId) ||
	!Number.isFinite(eventId)
) {
	console.error(
		'usage: attendee-sync.ts --mobilize-event <mobilize.us event id> --timeslot <mobilize.us timeslot id> --session <solidarity session id> --event <solidarity event id> [--chapter <id>] [--capacity <max>] [--apply]',
	);
	process.exit(1);
}

// In-memory: this CLI is for inspection, so nothing persists between runs.
const ledger: AttendeeLedger = {
	async rsvpsByAttendanceId() {
		return new Map<number, RsvpRecord>();
	},
	async recordRsvp() {},
};

const report = await runAttendeeSync(
	[
		{
			mobilizeTimeslotId: timeslotId,
			mobilizeEventId,
			solidarityEventId: eventId,
			solidaritySessionId: sessionId,
			eventChapterId: chapterId,
			startsAt: Date.now(),
			sessionCapacity: capacity,
		},
	],
	{
		api: loadApiConfig(),
		solidarityToken: requireEnv('SOLIDARITY_API_TOKEN', 'set it in .env.local'),
		apply,
		maxNewProfiles: apply ? 50 : Number.MAX_SAFE_INTEGER,
		log: (message) => console.log(`  ${message}`),
	},
	ledger,
	new Map(),
	chapterId,
);

// Counts only — these are real people's contact details.
console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'} — timeslot ${timeslotId}`);
console.log(`  signups found:        ${report.participations}`);
console.log(`  matched by email:     ${report.matchedByEmail}`);
console.log(`  matched by phone:     ${report.matchedByPhone}`);
console.log(`  would create profile: ${report.profilesCreated}`);
console.log(`  RSVPs to create:      ${report.rsvpsCreated}`);
console.log(`  RSVPs to update:      ${report.rsvpsUpdated}`);
console.log(`  would waitlist:       ${report.rsvpsWaitlisted}`);
console.log(`  no email or phone:    ${report.skippedNoContact}`);
console.log(`  phone rejected:       ${report.skippedInvalidPhone}`);
console.log(`  created sans phone:   ${report.profilesCreatedWithoutPhone}`);
console.log(`  unknown status:       ${report.skippedUnknownStatus}`);
console.log(`  events gone:          ${report.eventsGone}`);
console.log(`  failed:               ${report.failed}`);
for (const err of report.errors.slice(0, 5)) console.log(`    ! ${err}`);
if (report.abortedReason) console.log(`  ABORTED: ${report.abortedReason}`);

const matched = report.matchedByEmail + report.matchedByPhone;
const considered = matched + report.profilesCreated;
if (considered > 0) {
	console.log(
		`\n  match rate: ${Math.round((matched / considered) * 100)}% of signups already exist in Solidarity`,
	);
}
