// Mirrors Mobilize signups into Solidarity as event RSVPs.
//
// Pure of $env and node:fs so the CLI and the SvelteKit endpoint share it:
// persistence arrives through `AttendeeLedger`, credentials through
// `AttendeeSyncConfig`. Same shape as sync.ts.
//
// Privacy: this handles real people's emails and phone numbers. Logs go to Fly
// and Slack, so nothing here logs contact details — only counts and Solidarity
// user ids.

import { fetchEventParticipations, type MobilizeParticipation } from './attendees.js';
import { getOrgEvent, MobilizeError, type MobilizeApiConfig } from './mobilize.js';
import {
	createUser,
	findExistingUser,
	normalizeEmail,
	normalizePhone,
	resolveChapterId,
	SolidarityUserCreateError,
} from './people.js';
import {
	attendingFor,
	createAttendance,
	createRsvp,
	listSessionRsvps,
	updateRsvp,
	type AttendingValue,
} from './rsvp.js';

/** One Mobilize timeslot paired with the Solidarity session it mirrors. */
export interface TimeslotLink {
	mobilizeTimeslotId: number;
	/** Signups are fetched per event, so links are grouped by this. */
	mobilizeEventId: number;
	solidarityEventId: number;
	solidaritySessionId: number;
	/** Chapter that owns the event, used as the fallback for new profiles. */
	eventChapterId: number | null;
	/** Absolute start, so callers can select only imminent events. */
	startsAt: number;
	/**
	 * The Solidarity session's `max_capacity`, or null when it is uncapped.
	 * Signups past it are filed as `waitlisted` rather than `yes`.
	 */
	sessionCapacity: number | null;
}

export interface RsvpRecord {
	mobilizeAttendanceId: number;
	solidarityRsvpId: number | null;
	solidarityUserId: number;
	solidaritySessionId: number;
	status: string;
	attended: boolean;
	/** Mobilize's modified_date for the row we last mirrored. */
	modifiedDate: number;
}

export interface AttendeeLedger {
	rsvpsByAttendanceId(): Promise<Map<number, RsvpRecord>>;
	recordRsvp(record: RsvpRecord): Promise<void>;
	/**
	 * Drop the timeslot pairings for a Mobilize event that no longer exists.
	 * Optional so the inspection CLI, which keeps no ledger, can skip it.
	 *
	 * Self-healing rather than destructive: the event sync re-records pairings for
	 * any event Mobilize still has, so if a 404 were ever wrong the next nightly
	 * pass puts the rows back.
	 */
	forgetEvent?(mobilizeEventId: number): Promise<void>;
}

export interface AttendeeSyncConfig {
	api: MobilizeApiConfig;
	solidarityToken: string;
	apply: boolean;
	/** Refuse to create more than this many new profiles in one run. */
	maxNewProfiles: number;
	pauseMs?: number;
	log?: (message: string) => void;
}

export interface AttendeeSyncReport {
	/** Mobilize events read — one request each, covering all their shifts. */
	events: number;
	/** Events Mobilize no longer has: their pairings were dropped, not failed. */
	eventsGone: number;
	timeslots: number;
	participations: number;
	rsvpsCreated: number;
	rsvpsUpdated: number;
	/**
	 * Of the created ones, those filed as `waitlisted` because the session was
	 * already at its cap. Mobilize accepted the signup, so the person is not
	 * turned away — Solidarity just records that they are past the line.
	 */
	rsvpsWaitlisted: number;
	attendancesRecorded: number;
	profilesCreated: number;
	/**
	 * Of those, ones created without the phone number because Solidarity refused
	 * it. Counted separately because dropping a contact detail someone gave us is
	 * worth being able to see.
	 */
	profilesCreatedWithoutPhone: number;
	matchedByEmail: number;
	matchedByPhone: number;
	/**
	 * People who went through a Solidarity lookup — matched, ambiguous or new.
	 * The denominator for the match rate, and a truer one than
	 * matched + profilesCreated: a create that fails still consumed a lookup.
	 *
	 * Dry runs inflate it slightly. Nothing is created, so someone signed up for
	 * several shifts is looked up once per shift and misses every time, where an
	 * applying run matches them from the second shift on.
	 */
	lookupsPerformed: number;
	/**
	 * Lookups refused because an identifier matched more than one CRM profile.
	 *
	 * Near zero normally — it takes an existing duplicate to produce one. A run
	 * where these dominate is the signature of a lookup that has stopped
	 * filtering and is returning the unfiltered user list for everybody, which is
	 * the failure mode that fills the CRM with duplicates. See UserLookup.
	 */
	lookupsAmbiguous: number;
	unchanged: number;
	/**
	 * Sessions holding more attending RSVPs than their cap allows, as they read at
	 * the START of the run — so this reports a standing condition to be fixed by a
	 * human, not something this run caused. A session the run then waitlists into
	 * still appears here only if it was already over.
	 */
	overCapacity: { solidaritySessionId: number; capacity: number; attending: number }[];
	/** No email and no phone — nothing to match or create on. */
	skippedNoContact: number;
	/**
	 * Phone rejected by Solidarity as not text-capable, and no email to fall back
	 * on. Not a failure: nothing here can fix someone else's phone number.
	 */
	skippedInvalidPhone: number;
	/** Mobilize status we don't have a mapping for. */
	skippedUnknownStatus: number;
	abortedReason?: string;
	/** Mobilize answered 403 — the API key is rejected or lacks access. */
	authFailed: boolean;
	failed: number;
	errors: string[];
}

function emptyReport(): AttendeeSyncReport {
	return {
		events: 0,
		eventsGone: 0,
		timeslots: 0,
		participations: 0,
		rsvpsCreated: 0,
		rsvpsUpdated: 0,
		rsvpsWaitlisted: 0,
		attendancesRecorded: 0,
		profilesCreated: 0,
		profilesCreatedWithoutPhone: 0,
		matchedByEmail: 0,
		matchedByPhone: 0,
		lookupsPerformed: 0,
		lookupsAmbiguous: 0,
		unchanged: 0,
		overCapacity: [],
		skippedNoContact: 0,
		skippedInvalidPhone: 0,
		skippedUnknownStatus: 0,
		authFailed: false,
		failed: 0,
		errors: [],
	};
}

/**
 * Sort key for "who signed up first".
 *
 * A missing created_date sorts LAST rather than first: it has never been
 * observed, and a row with no signup time should not outrank one that has a
 * known early one. The attendance id breaks ties — it rises with creation on
 * every event checked, including across events.
 */
function signupOrder(participation: MobilizeParticipation): number {
	return participation.createdDate > 0 ? participation.createdDate : Number.MAX_SAFE_INTEGER;
}

/** Stable, non-identifying handle for logs and error messages. */
function refFor(participation: MobilizeParticipation): string {
	return `participation ${participation.id}`;
}

/**
 * Does the RSVP Solidarity already holds satisfy what Mobilize now says?
 *
 * Exact equality is wrong in one direction: a `waitlisted` row IS this sync's
 * answer to a Mobilize `yes` on a full shift, so comparing naively would promote
 * every waitlisted person back to `yes` on the next pass, then waitlist the next
 * arrival instead — the queue would churn nightly and the cap would never hold.
 * Anything else still updates, so a cancellation always lands.
 */
function satisfies(current: string, wanted: AttendingValue): boolean {
	if (current === wanted) return true;
	return wanted === 'yes' && current === 'waitlisted';
}

/**
 * Does this event still exist for our organization? `null` when the check itself
 * failed, so callers can tell "confirmed gone" from "couldn't tell" and only
 * prune on the former.
 */
async function confirmEventExists(
	config: AttendeeSyncConfig,
	eventId: number,
): Promise<boolean | null> {
	try {
		return (await getOrgEvent(config.api, eventId)) !== null;
	} catch {
		return null;
	}
}

export async function runAttendeeSync(
	links: TimeslotLink[],
	config: AttendeeSyncConfig,
	ledger: AttendeeLedger,
	zipChapters: Map<string, { chapterId: number }>,
	defaultChapterId: number | null,
): Promise<AttendeeSyncReport> {
	const log = config.log ?? (() => {});
	// Solidarity allows 60 requests / 30s. Each unmatched person costs two
	// lookups plus a write, so anything faster than ~600ms spends the run
	// sitting in 30-second rate-limit backoffs. Rows already in the ledger skip
	// the API entirely, so steady-state runs are far cheaper than the first.
	const pause = () => new Promise((r) => setTimeout(r, config.pauseMs ?? 600));
	const report = emptyReport();
	const known = await ledger.rsvpsByAttendanceId();

	// One request per event covers every shift on it, so group the links first.
	// Signups for timeslots outside the caller's window come back too and are
	// dropped — the link map is what decides which shifts are in scope.
	const linksByTimeslot = new Map(links.map((link) => [link.mobilizeTimeslotId, link]));
	const eventIds = [...new Set(links.map((link) => link.mobilizeEventId))];
	report.timeslots = linksByTimeslot.size;

	// Collect first so the new-profile guardrail can be evaluated before any write.
	const pending: { link: TimeslotLink; participation: MobilizeParticipation }[] = [];
	for (const eventId of eventIds) {
		try {
			const participations = await fetchEventParticipations(eventId, config.api);
			report.events++;
			for (const participation of participations) {
				const link = linksByTimeslot.get(participation.timeslotId);
				if (link) pending.push({ link, participation });
			}
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.authFailed = true;
				report.errors.push('Mobilize rejected the API key (403) — check MOBILIZE_API_KEY');
				return report;
			}
			// A 404 here is almost always an event deleted in Mobilize while our
			// pairings for its shifts stayed behind. Left as a failure it recurs on
			// every run forever, which is how one dead event produced a nightly Slack
			// alert. Confirm the event itself is gone before dropping anything: if it
			// still reads back, a 404 on its attendances is genuinely surprising and
			// stays a failure.
			if (err instanceof MobilizeError && err.status === 404) {
				const stillThere = await confirmEventExists(config, eventId);
				if (stillThere === false) {
					report.eventsGone++;
					log(`Mobilize event ${eventId} no longer exists — dropping its timeslot pairings`);
					if (config.apply && ledger.forgetEvent) await ledger.forgetEvent(eventId);
					await pause();
					continue;
				}
			}
			report.failed++;
			report.errors.push(`event ${eventId}: ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}
	report.participations = pending.length;

	// Signup order, oldest first — this is what decides who takes the last seat on
	// a capped shift and who is waitlisted.
	//
	// Mobilize does return an event's attendances in created_date order (verified
	// across 393 signups on three events, none missing the field), but that is
	// undocumented, and the loop above reads one event at a time: without this,
	// every signup on the first Mobilize event outranked every signup on the
	// second, and twelve Solidarity sessions are mirrored by timeslots on TWO
	// Mobilize events. So the ordering is made ours rather than inherited.
	pending.sort(
		(a, b) =>
			signupOrder(a.participation) - signupOrder(b.participation) ||
			a.participation.id - b.participation.id,
	);

	// RSVPs already in Solidarity, so ones entered there directly aren't doubled.
	const existingBySession = new Map<number, Map<number, { id: number; is_attending: string }>>();
	// Seats spent per session, counted from the same read and then kept up to date
	// as this run files RSVPs. Unlike the cap pushed to Mobilize (see seats.ts),
	// this counts EVERY attending RSVP whatever its origin: in Solidarity a seat
	// is a seat, and the question here is only whether the room is full.
	const seatsBySession = new Map<number, number>();
	const capacityBySession = new Map<number, number | null>();
	for (const link of links) capacityBySession.set(link.solidaritySessionId, link.sessionCapacity);
	for (const sessionId of new Set(pending.map((p) => p.link.solidaritySessionId))) {
		try {
			const rows = await listSessionRsvps(config.solidarityToken, sessionId);
			existingBySession.set(
				sessionId,
				new Map(rows.map((r) => [r.user_id, { id: r.id, is_attending: r.is_attending }])),
			);
			const attending = rows.filter((r) => r.is_attending === 'yes').length;
			seatsBySession.set(sessionId, attending);
			const capacity = capacityBySession.get(sessionId) ?? null;
			if (capacity !== null && attending > capacity) {
				report.overCapacity.push({ solidaritySessionId: sessionId, capacity, attending });
			}
		} catch (err) {
			report.failed++;
			report.errors.push(`rsvp list ${sessionId}: ${err instanceof Error ? err.message : err}`);
		}
	}

	let projectedNewProfiles = 0;

	for (const { link, participation } of pending) {
		const attending = attendingFor(participation.status);
		if (!attending) {
			report.skippedUnknownStatus++;
			continue;
		}

		const email = normalizeEmail(participation.email);
		const phone = normalizePhone(participation.phone);
		if (!email && !phone) {
			report.skippedNoContact++;
			continue;
		}

		const priorRecord = known.get(participation.id);
		// Already mirrored and nothing changed — the common case on re-runs.
		//
		// modified_date is checked as well as status and attendance, so an edit
		// that changes neither (someone corrects their email in Mobilize) is still
		// picked up. Ledger rows written before that column existed carry 0, so
		// they fail this check and are reprocessed exactly once; that pass stores
		// the real modified_date and they settle from then on.
		if (
			priorRecord &&
			priorRecord.status === participation.status &&
			priorRecord.attended === Boolean(participation.attended) &&
			priorRecord.modifiedDate >= participation.modifiedDate
		) {
			report.unchanged++;
			continue;
		}

		try {
			let userId = priorRecord?.solidarityUserId ?? null;

			if (userId === null) {
				const lookup = await findExistingUser(config.solidarityToken, {
					firstName: participation.firstName,
					lastName: participation.lastName,
					email: participation.email,
					phone: participation.phone,
					zipcode: participation.zipcode,
				});
				report.lookupsPerformed++;
				if (lookup.outcome === 'ambiguous') report.lookupsAmbiguous++;

				if (lookup.outcome === 'matched') {
					userId = lookup.user.id;
					if (lookup.method === 'email') report.matchedByEmail++;
					else report.matchedByPhone++;
				} else {
					// Ambiguous falls through to create alongside genuinely new
					// people. Creating a third row for someone the CRM already has
					// twice is bad, but skipping means their RSVP never lands and
					// the run reports nothing amiss. Counted and alerted on
					// instead, and the maxNewProfiles guardrail still caps the
					// damage if it ever becomes the common case.
					projectedNewProfiles++;
					if (projectedNewProfiles > config.maxNewProfiles) {
						report.abortedReason =
							`would create more than ${config.maxNewProfiles} new Solidarity profiles — ` +
							'stopping. A spike usually means matching is failing, which fills the CRM with ' +
							'duplicate people. Review, then re-run with a raised limit if it is genuine.';
						log(report.abortedReason);
						return report;
					}
					if (!config.apply) {
						// Don't skip the rest: a dry run must still project the RSVP
						// this person would get, or it reports far fewer writes than
						// the real run performs — which is exactly the number a human
						// uses to decide whether to go ahead.
						report.profilesCreated++;
						report.rsvpsCreated++;
						continue;
					}
					const chapterId = resolveChapterId(
						{
							byZip: (zip) => (zip ? (zipChapters.get(zip)?.chapterId ?? null) : null),
							eventChapterId: link.eventChapterId,
							defaultChapterId,
						},
						participation.zipcode,
					);
					if (chapterId === null) {
						report.failed++;
						report.errors.push(`${refFor(participation)}: no chapter could be resolved`);
						continue;
					}
					const person = {
						firstName: participation.firstName,
						lastName: participation.lastName,
						email: participation.email,
						phone: participation.phone,
						zipcode: participation.zipcode,
					};

					let created: { id: number };
					try {
						created = await createUser(config.solidarityToken, person, chapterId);
					} catch (err) {
						if (!(err instanceof SolidarityUserCreateError && err.phoneRejected)) throw err;
						// Solidarity checks that a new profile's number can receive
						// texts. Mobilize never does, so landlines and typos reach us
						// looking fine. Failing the whole signup over it meant the same
						// person alerted on every run forever, and their RSVP never
						// landed — so drop the number and keep the human.
						if (!email) {
							// Nothing left to create them on. Skipped rather than failed:
							// it is a fact about their contact details, not a fault, and
							// it self-heals if they correct the number in Mobilize.
							report.skippedInvalidPhone++;
							log(`${refFor(participation)}: Solidarity rejected the phone and there is no email`);
							continue;
						}
						created = await createUser(
							config.solidarityToken,
							{ ...person, phone: null },
							chapterId,
						);
						report.profilesCreatedWithoutPhone++;
					}
					userId = created.id;
					report.profilesCreated++;
					log(`created Solidarity user ${userId} (chapter ${chapterId})`);
				}
			}

			if (userId === null) {
				report.failed++;
				continue;
			}

			const target = {
				eventId: link.solidarityEventId,
				sessionId: link.solidaritySessionId,
				userId,
			};
			const existing =
				existingBySession.get(link.solidaritySessionId)?.get(userId) ??
				(priorRecord?.solidarityRsvpId
					? { id: priorRecord.solidarityRsvpId, is_attending: priorRecord.status }
					: null);

			// Only a fresh `yes` can be pushed past the line. A cancellation is never
			// waitlisted, and someone already holding a seat is never demoted into a
			// waitlist by a later run — that would take a place away from a person who
			// has it, on nothing more than the order the sync happened to read them in.
			const seats = seatsBySession.get(link.solidaritySessionId) ?? 0;
			const capacity = link.sessionCapacity;
			const full = capacity !== null && seats >= capacity;
			const desired: AttendingValue =
				attending === 'yes' && full && !existing ? 'waitlisted' : attending;

			if (!config.apply) {
				if (existing) report.rsvpsUpdated++;
				else {
					report.rsvpsCreated++;
					if (desired === 'waitlisted') report.rsvpsWaitlisted++;
					else seatsBySession.set(link.solidaritySessionId, seats + 1);
				}
				continue;
			}

			let rsvpId = existing?.id ?? null;
			if (rsvpId === null) {
				rsvpId = await createRsvp(config.solidarityToken, target, desired);
				report.rsvpsCreated++;
				if (desired === 'waitlisted') {
					report.rsvpsWaitlisted++;
					log(
						`waitlisted user ${userId} — session ${link.solidaritySessionId} is at its cap of ${capacity}`,
					);
				} else {
					seatsBySession.set(link.solidaritySessionId, seats + 1);
				}
			} else if (existing && !satisfies(existing.is_attending, attending)) {
				await updateRsvp(config.solidarityToken, rsvpId, attending);
				report.rsvpsUpdated++;
				// A cancellation hands the seat back, so the next person in this run
				// can have it rather than being waitlisted against a stale count.
				if (existing.is_attending === 'yes' && attending === 'no') {
					seatsBySession.set(link.solidaritySessionId, Math.max(0, seats - 1));
				}
			}

			if (participation.attended && !priorRecord?.attended) {
				await createAttendance(config.solidarityToken, target);
				report.attendancesRecorded++;
			}

			await ledger.recordRsvp({
				mobilizeAttendanceId: participation.id,
				solidarityRsvpId: rsvpId,
				solidarityUserId: userId,
				solidaritySessionId: link.solidaritySessionId,
				status: participation.status,
				attended: Boolean(participation.attended),
				modifiedDate: participation.modifiedDate,
			});
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.authFailed = true;
				report.errors.push('Mobilize rejected the API key (403) — check MOBILIZE_API_KEY');
				return report;
			}
			report.failed++;
			report.errors.push(`${refFor(participation)}: ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	return report;
}
