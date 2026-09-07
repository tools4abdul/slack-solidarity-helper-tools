// The nightly sync: create newly-added Solidarity events in Mobilize, and push
// edits to the ones already migrated.
//
// Pure of $env and node:fs so both the CLI script and the SvelteKit server
// endpoint can use it — state comes in through the `Ledger` interface, config
// through `SyncConfig`. Same dual-use pattern as src/lib/server/solidarity-paginate.ts.

import { lookupPostalCode, pointKey } from './geocode.js';
import { copyImageToMobilize, isReusableImageUrl } from './image.js';
import {
	createEvent,
	getOrgEvent,
	listUpcomingOrgEvents,
	MobilizeError,
	updateEvent,
	type MobilizeApiConfig,
	type MobilizeEvent,
} from './mobilize.js';
import {
	buildEventPayload,
	CAMPAIGN_TIMEZONE,
	type EventContact,
	type Timeslot,
} from './payload.js';
import { applySeatsTaken, cappedSessionIds } from './seats.js';
import type { PlannedEvent } from './transform.js';

/** Timeslots are matched between systems by start time, within this slack. */
const START_MATCH_TOLERANCE_MS = 60_000;

export interface LedgerRecord {
	key: string;
	mobilizeEventId: number;
	title: string;
}

/** Persistence for what we've created. Backed by Turso on the server, by a
 *  JSON file for the CLI. */
export interface Ledger {
	all(): Promise<LedgerRecord[]>;
	record(entry: LedgerRecord): Promise<void>;
	/** Solidarity image URL -> Mobilize-hosted URL, so an image uploads once. */
	imageFor(sourceUrl: string): Promise<string | null>;
	recordImage(sourceUrl: string, mobilizeUrl: string): Promise<void>;
	/** Venue coordinates -> zip, so a venue is geocoded once and not every night. */
	zipFor(point: string): Promise<string | null>;
	recordZip(point: string, postalCode: string): Promise<void>;
	/**
	 * Mobilize timeslot -> Solidarity session, consumed by the attendee sync.
	 * Optional so the file-backed CLI ledger doesn't have to implement it.
	 */
	recordTimeslots?(pairings: TimeslotPairing[]): Promise<void>;
	/**
	 * The `max_attendees` we last pushed for each Mobilize timeslot.
	 *
	 * Kept because it CANNOT be read back: Mobilize's event read returns
	 * `start_date, end_date, instructions, id, is_full` and no cap at all, so
	 * there is nothing live to diff against. Without a record of what was sent,
	 * every run would either re-PUT every capped event forever or never notice a
	 * cap had moved. `is_full` is the only live signal, and it says "at the
	 * limit", not what the limit is.
	 */
	pushedCaps?(): Promise<Map<number, number | null>>;
	recordPushedCaps?(entries: PushedCap[]): Promise<void>;
}

export interface PushedCap {
	mobilizeTimeslotId: number;
	/** null = uncapped. Distinct from 0, which is a shift that is full. */
	maxAttendees: number | null;
}

export interface SyncConfig {
	api: MobilizeApiConfig;
	/** Required by the v1 API on every create and update. */
	contact: EventContact;
	/** Refuse to create more than this in one unattended run. */
	maxCreatesPerRun: number;
	/**
	 * Stop after creating this many. Distinct from maxCreatesPerRun, which is a
	 * safety threshold that aborts the whole run — this is a deliberate "just do
	 * a few" cap for trying things out.
	 */
	createLimit?: number;
	/** When false, plan and report but write nothing. */
	apply: boolean;
	/**
	 * Absolute epoch ms after which no NEW write is started. The run then returns
	 * with `incomplete` set, and the caller re-invokes to carry on where this left
	 * off — the ledger is what makes that safe.
	 *
	 * This exists because the server runs behind fly-proxy, whose autostop loop
	 * decides a machine is excess capacity from its `soft_limit` concurrency and
	 * not from requests in flight: a single long request looks exactly like an
	 * idle machine, and gets SIGINT mid-sync (502 to the caller). A deadline, not
	 * a write count, because one create with an image upload costs ~30s while an
	 * update costs ~1s — only elapsed time bounds the request.
	 *
	 * Undefined means run to completion, which is what the CLI wants.
	 */
	writeDeadline?: number;
	/** Milliseconds between writes, to stay clear of Cloudflare rate limiting. */
	pauseMs?: number;
	/**
	 * Seats already spent, per Solidarity session, on signups that did NOT come
	 * from Mobilize — so Mobilize can be handed only what is left and enforce the
	 * cap itself. Injected rather than called directly: this module has no
	 * Solidarity token, by the same rule that keeps it free of $env.
	 *
	 * Omit it and caps go to Mobilize at their full Solidarity value, which is the
	 * behaviour before any of this existed. A session the counter leaves out is
	 * treated the same way — a read that failed must not close a shift.
	 */
	seatsTaken?: (sessionIds: number[]) => Promise<Map<number, number>>;
	log?: (message: string) => void;
}

export interface SyncReport {
	planned: number;
	created: number;
	updated: number;
	unchanged: number;
	skippedExisting: number;
	failed: number;
	/** Set when the run refused to act because the plan was suspiciously large. */
	abortedReason?: string;
	/** The write deadline passed with work left. Re-invoke to continue. */
	incomplete: boolean;
	/**
	 * Planned events this run stopped before reaching. An upper bound on the work
	 * left rather than a count of pending writes: most events turn out to need no
	 * edit, and that is only known once each is evaluated.
	 */
	pending: number;
	/** Mobilize answered 403 — the API key is rejected or lacks write access. */
	authFailed: boolean;
	createdTitles: string[];
	updatedTitles: string[];
	/** Per-event reasons for the skips, so a dry run can be reviewed by eye. */
	skippedDetails: { title: string; reason: string }[];
	errors: string[];
}

export interface PutTimeslot {
	id?: number;
	/** Unix seconds. */
	startDate: number;
	endDate: number;
	maxAttendees: number | null;
}

export interface TimeslotPairing {
	mobilizeTimeslotId: number;
	mobilizeEventId: number;
	solidarityEventId: number;
	solidaritySessionId: number;
}

export interface TimeslotPlan {
	timeslots: PutTimeslot[];
	/** Live shifts with no counterpart in Solidarity — kept, never deleted. */
	orphanCount: number;
	changed: boolean;
	/** A cap moved, though the shifts themselves did not. Tracked apart from
	 *  `changed` so the update log says "capacity" instead of "timeslots". */
	capacityChanged: boolean;
	/**
	 * Mobilize timeslot -> Solidarity session, for the rows we matched. The
	 * attendee sync needs this to file a signup against the right session, and
	 * here is the only place both ids are known at once.
	 */
	pairings: TimeslotPairing[];
}

/**
 * Build the timeslot array for a PUT.
 *
 * Mobilize matches timeslots by id: a slot sent without one is created, and an
 * UPCOMING slot that is simply absent is destroyed *along with its signups*. So
 * existing shifts are matched to the plan by start time and re-sent with their
 * ids, new Solidarity sessions are sent without an id, and upcoming shifts with
 * no counterpart (a cancelled session, say) are re-sent untouched rather than
 * dropped. Deleting a shift volunteers have signed up for is far worse than
 * leaving a stale one behind.
 *
 * Past shifts are the exception: the v1 endpoint does not modify them at all,
 * so re-sending them is at best noise and at worst rejected outright. They are
 * left out entirely, and `now` is a parameter so tests can pin the boundary.
 *
 * "Past" here means STARTED, not ended — Mobilize answers 400 "Cannot modify
 * past timeslot" for a shift that is merely under way, and a long session (a
 * week-long exhibit, say) is under way for days. Omitting it is safe for the
 * same reason the whole rule exists: the endpoint cannot delete a past shift
 * either, so leaving it out of the PUT cannot take its signups with it.
 */
export function reconcileTimeslots(
	plan: PlannedEvent,
	live: MobilizeEvent,
	now = Date.now(),
	/** What we last sent as each slot's `max_attendees`; see Ledger.pushedCaps. */
	pushedCaps: Map<number, number | null> = new Map(),
): TimeslotPlan {
	const liveSlots = [...live.timeslots].sort((a, b) => a.start_date - b.start_date);
	const consumed = new Set<number>();
	const timeslots: PutTimeslot[] = [];
	const pairings: TimeslotPairing[] = [];
	let changed = false;
	let capacityChanged = false;

	plan.timeslots.forEach((slot, index) => {
		const startInstant = plan.startInstants[index];
		const match = liveSlots.find(
			(candidate) =>
				!consumed.has(candidate.id) &&
				Math.abs(candidate.start_date * 1000 - startInstant) <= START_MATCH_TOLERANCE_MS,
		);
		if (match) {
			consumed.add(match.id);
			// An end-time edit still counts as a change even though the start matched.
			if (Math.abs(match.end_date * 1000 - plan.endInstants[index]) > START_MATCH_TOLERANCE_MS) {
				changed = true;
			}
			// A cap can only be compared against what we recorded sending, since
			// Mobilize never gives it back. No record and no cap wanted means there
			// is nothing to do; no record and a cap wanted means this slot predates
			// capacity tracking and needs one established.
			const lastPushed = pushedCaps.has(match.id) ? pushedCaps.get(match.id)! : undefined;
			if (
				lastPushed === undefined ? slot.maxAttendees !== null : lastPushed !== slot.maxAttendees
			) {
				capacityChanged = true;
			}
			timeslots.push({ id: match.id, ...slot });
			const solidaritySessionId = plan.solidaritySessionIds[index];
			if (solidaritySessionId !== undefined) {
				pairings.push({
					mobilizeTimeslotId: match.id,
					mobilizeEventId: live.id,
					solidarityEventId: plan.solidarityEventId,
					solidaritySessionId,
				});
			}
		} else {
			changed = true;
			timeslots.push({ ...slot });
		}
	});

	// Only orphans that have not started yet need preserving; once a shift is
	// under way Mobilize rejects the whole PUT rather than ignoring that row.
	const orphans = liveSlots.filter(
		(slot) => !consumed.has(slot.id) && slot.start_date * 1000 > now,
	);
	for (const orphan of orphans) {
		timeslots.push({
			id: orphan.id,
			startDate: orphan.start_date,
			endDate: orphan.end_date,
			// Whatever we last pushed, NOT null. A PUT re-sends every upcoming slot,
			// so hardcoding null here quietly un-capped every orphan on every edit —
			// harmless while nothing managed caps, silently destructive now.
			maxAttendees: pushedCaps.get(orphan.id) ?? null,
		});
	}

	return { timeslots, orphanCount: orphans.length, changed, capacityChanged, pairings };
}

/** Fields worth a PUT. Location is compared loosely — Mobilize normalizes it. */
export function describeChanges(
	plan: PlannedEvent,
	live: MobilizeEvent,
	wantsImage: boolean,
	timeslotsChanged: boolean,
	capacityChanged = false,
): string[] {
	const changes: string[] = [];
	if (plan.title.trim() !== (live.title ?? '').trim()) changes.push('title');
	if (plan.description.trim() !== (live.description ?? '').trim()) changes.push('description');
	if (wantsImage && !live.featured_image_url) changes.push('image');
	if (timeslotsChanged) changes.push('timeslots');
	if (capacityChanged) changes.push('capacity');
	// Events migrated before the v1 switch went in with no postal code at all —
	// the old dashboard API allowed it. Backfill one when we now have it, rather
	// than leaving them unfindable by zip in Mobilize's search.
	if (plan.zipcode && !(live.location?.postal_code ?? '').trim()) changes.push('postal code');
	const liveCity = (live.location?.locality ?? '').trim().toLowerCase();
	if (liveCity && plan.city.trim().toLowerCase() !== liveCity) changes.push('location');
	return changes;
}

/**
 * The one place a PlannedEvent becomes a Mobilize create/update body. Exported
 * because the CLI scripts need the identical mapping — four near-copies of this
 * block had already drifted apart once.
 */
export function payloadForPlan(
	plan: PlannedEvent,
	contact: EventContact,
	imageUrl?: string,
	/** Overridden on update, where reconcileTimeslots owns timeslot identity. */
	timeslots: Timeslot[] = plan.timeslots,
) {
	return buildEventPayload({
		title: plan.title,
		description: plan.description,
		imageUrl,
		eventType: plan.eventType,
		timezone: CAMPAIGN_TIMEZONE,
		locationName: plan.locationName,
		addressLine1: plan.addressLine1,
		city: plan.city,
		state: plan.state,
		zipcode: plan.zipcode,
		country: plan.country,
		locationIsPrivate: plan.locationIsPrivate,
		contact,
		timeslots,
	});
}

/**
 * Run one sync pass.
 *
 * `planned` comes from planMigration(); `findDuplicate` is injected so the
 * caller controls duplicate policy without this module importing it.
 */
export async function runSync(
	planned: PlannedEvent[],
	config: SyncConfig,
	ledger: Ledger,
	findDuplicate: (plan: PlannedEvent, existing: MobilizeEvent[]) => unknown,
): Promise<SyncReport> {
	const log = config.log ?? (() => {});
	const pause = () => new Promise((r) => setTimeout(r, config.pauseMs ?? 1000));
	const report: SyncReport = {
		planned: planned.length,
		created: 0,
		updated: 0,
		unchanged: 0,
		skippedExisting: 0,
		failed: 0,
		incomplete: false,
		pending: 0,
		authFailed: false,
		createdTitles: [],
		updatedTitles: [],
		skippedDetails: [],
		errors: [],
	};

	const existing = await listUpcomingOrgEvents(config.api);
	const known = new Map((await ledger.all()).map((entry) => [entry.key, entry]));

	const toCreate: PlannedEvent[] = [];
	const toSync: { plan: PlannedEvent; record: LedgerRecord }[] = [];

	// The bulk list already carries description, image and timeslots, so the
	// update pass can diff from it instead of fetching each event individually —
	// that was ~90 extra rate-limited requests a run.
	const existingById = new Map(existing.map((event) => [event.id, event]));

	for (const plan of planned) {
		const record = known.get(plan.key);
		if (record) {
			toSync.push({ plan, record });
		} else {
			const duplicate = findDuplicate(plan, existing) as {
				mobilizeEventId: number;
				mobilizeTitle: string;
				reason: string;
			} | null;
			if (duplicate) {
				// Created by hand in Mobilize; we don't own it, so leave it alone.
				report.skippedExisting++;
				report.skippedDetails.push({
					title: plan.title,
					reason: `looks like Mobilize #${duplicate.mobilizeEventId} "${duplicate.mobilizeTitle}" (${duplicate.reason})`,
				});
			} else {
				toCreate.push(plan);
			}
		}
	}

	// Guardrail: a sudden flood means dedup or the source data broke. Do nothing
	// rather than publish a pile of bad public events.
	if (toCreate.length > config.maxCreatesPerRun) {
		report.abortedReason =
			`plan wants to create ${toCreate.length} events, over the limit of ${config.maxCreatesPerRun} — ` +
			'refusing to create anything. Review, then re-run with a raised limit if it is legitimate.';
		log(report.abortedReason);
		return report;
	}

	/**
	 * The plan with Mobilize's share of each capped shift, so Mobilize can enforce
	 * the rest itself — see lib/seats.ts for why Mobilize-origin RSVPs must be
	 * left out of that subtraction.
	 *
	 * Counted lazily, per event, and memoized for the run: this costs one
	 * Solidarity read per capped session, and a request that runs out of budget is
	 * re-invoked from the top. Counting every capped session up front therefore
	 * meant re-counting all of them on every chunk — up to twelve times a pass —
	 * to serve the handful each chunk actually writes.
	 */
	const seatCache = new Map<number, number>();
	const seated = async (plan: PlannedEvent): Promise<PlannedEvent> => {
		if (!config.seatsTaken) return plan;
		const wanted = cappedSessionIds(plan).filter((id) => !seatCache.has(id));
		if (wanted.length > 0) {
			try {
				for (const [id, taken] of await config.seatsTaken(wanted)) seatCache.set(id, taken);
			} catch (err) {
				// Push the full caps rather than none: a failed count must never be
				// read as "every seat is free" or as "the shift is full".
				report.errors.push(`seat count: ${err instanceof Error ? err.message : err}`);
				log(`capacity: seat count failed for "${plan.title}" — pushing its caps unadjusted`);
			}
		}
		return applySeatsTaken(plan, seatCache);
	};
	const pushedCaps = (await ledger.pushedCaps?.()) ?? new Map<number, number | null>();
	/** Ids only exist for slots Mobilize already has; new ones get theirs on create. */
	const capsFrom = (slots: PutTimeslot[]): PushedCap[] =>
		slots
			.filter((slot) => slot.id !== undefined)
			.map((slot) => ({ mobilizeTimeslotId: slot.id!, maxAttendees: slot.maxAttendees }));

	/**
	 * The plan with a usable `zipcode`, or null when there is none to be had.
	 *
	 * `postal_code` is the one location field Mobilize v1 requires, and about a
	 * third of Solidarity's sessions carry an address string with no zip in it, so
	 * the zip is geocoded from the venue's coordinates and cached by point. A dry
	 * run still looks up (it is a read, and the preview would otherwise claim
	 * events will sync that in fact cannot) but never writes to the cache.
	 */
	const resolveZip = async (plan: PlannedEvent): Promise<PlannedEvent | null> => {
		if (plan.zipcode) return plan;
		if (!plan.coordinates) return null;
		const key = pointKey(plan.coordinates);
		const cached = await ledger.zipFor(key);
		if (cached) return { ...plan, zipcode: cached };
		const looked = await lookupPostalCode(plan.coordinates);
		if (!looked) return null;
		if (config.apply) await ledger.recordZip(key, looked);
		log(`geocoded ${key} -> ${looked} for "${plan.title}"`);
		return { ...plan, zipcode: looked };
	};

	const noZip = (plan: PlannedEvent) =>
		`no postal code — Solidarity has none and ${
			plan.coordinates
				? 'the ZIP lookup for its coordinates found nothing'
				: 'the session has no coordinates to geocode'
		}. Mobilize requires one, so this event needs its address fixed in Solidarity.`;

	const resolveImage = async (plan: PlannedEvent): Promise<string | undefined> => {
		if (!plan.sourceImageUrl) return undefined;
		const cached = await ledger.imageFor(plan.sourceImageUrl);
		if (cached && isReusableImageUrl(cached)) return cached;
		// A dashboard-era entry points at the raw upload bucket, which v1 rejects
		// with "Invalid featured image url". Re-upload and overwrite the row rather
		// than failing this event every night.
		if (cached) log(`re-uploading image for "${plan.title}" — cached URL is not accepted by v1`);
		if (!config.apply) return undefined;
		const uploaded = await copyImageToMobilize(plan.sourceImageUrl, plan.title, config.api);
		await ledger.recordImage(plan.sourceImageUrl, uploaded.publicUrl);
		return uploaded.publicUrl;
	};

	// Checked before starting each write, never in the middle of one: a chunk that
	// stops between writes leaves the ledger consistent, so the next one resumes
	// rather than repeats.
	const outOfTime = () => config.writeDeadline !== undefined && Date.now() >= config.writeDeadline;

	for (const [index, unseated] of toCreate.entries()) {
		if (config.createLimit !== undefined && report.created >= config.createLimit) break;
		const plan = await seated(unseated);
		if (outOfTime()) {
			report.incomplete = true;
			report.pending += toCreate.length - index;
			break;
		}
		const zipped = await resolveZip(plan);
		if (!zipped) {
			report.failed++;
			report.errors.push(`create "${plan.title}": ${noZip(plan)}`);
			continue;
		}
		if (!config.apply) {
			report.created++;
			report.createdTitles.push(plan.title);
			continue;
		}
		try {
			const imageUrl = await resolveImage(zipped);
			const { id, event } = await createEvent(
				config.api,
				payloadForPlan(zipped, config.contact, imageUrl),
			);
			await ledger.record({ key: plan.key, mobilizeEventId: id, title: plan.title });
			report.created++;
			report.createdTitles.push(plan.title);
			log(`created #${id} "${plan.title}"`);

			// Pair the timeslot ids, which only exist post-create — without this the
			// attendee sync couldn't file signups against a brand-new event until
			// the following night's pass. The create response already carries them,
			// so this normally costs no extra request.
			if (ledger.recordTimeslots) {
				const created = event ?? (await getOrgEvent(config.api, id));
				if (created) {
					const slotPlan = reconcileTimeslots(plan, created, Date.now(), pushedCaps);
					await ledger.recordTimeslots(slotPlan.pairings);
					// The caps went out with the create, so record them now — otherwise
					// the very next pass sees no record and re-pushes every one.
					await ledger.recordPushedCaps?.(capsFrom(slotPlan.timeslots));
				}
			}
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.authFailed = true;
				report.errors.push('Mobilize rejected the API key (403) — check MOBILIZE_API_KEY');
				return report;
			}
			report.failed++;
			report.errors.push(`create "${plan.title}": ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	for (const [index, { plan: unseated, record }] of toSync.entries()) {
		if (outOfTime()) {
			report.incomplete = true;
			report.pending += toSync.length - index;
			break;
		}
		const plan = await seated(unseated);
		try {
			// Prefer the bulk list; fall back to a direct read only for events it
			// doesn't cover (all timeslots already past, or not publicly listed).
			const live =
				existingById.get(record.mobilizeEventId) ??
				(await getOrgEvent(config.api, record.mobilizeEventId));
			if (!live) {
				// Deleted in Mobilize, or no longer public. Not ours to resurrect.
				report.unchanged++;
				continue;
			}

			const slotPlan = reconcileTimeslots(plan, live, Date.now(), pushedCaps);
			// Recorded before the change check, so the pairing stays fresh even when
			// the event itself needs no edit — but still only when applying. A dry
			// run must write nothing, including to the ledger.
			if (config.apply && ledger.recordTimeslots) {
				await ledger.recordTimeslots(slotPlan.pairings);
			}
			// Resolved before the change check because a recovered zip is itself a
			// change worth pushing to an event that has none.
			const zipped = (await resolveZip(plan)) ?? plan;
			const wantsImage = Boolean(plan.sourceImageUrl);
			const changes = describeChanges(
				zipped,
				live,
				wantsImage,
				slotPlan.changed,
				slotPlan.capacityChanged,
			);
			if (changes.length === 0) {
				report.unchanged++;
				continue;
			}
			if (!config.apply) {
				report.updated++;
				report.updatedTitles.push(`${plan.title} (${changes.join(', ')})`);
				continue;
			}
			// A PUT with a blank postal_code is rejected outright, so the edit waits
			// for a fixed address rather than failing against the API every night.
			if (!zipped.zipcode) {
				report.failed++;
				report.errors.push(`update "${plan.title}": ${noZip(plan)}`);
				continue;
			}

			const imageUrl = live.featured_image_url ? undefined : await resolveImage(zipped);
			// reconcileTimeslots owns timeslot identity, so its list — ids and all —
			// replaces the one payloadForPlan derived from the plan alone.
			const payload = payloadForPlan(zipped, config.contact, imageUrl, slotPlan.timeslots);

			await updateEvent(config.api, record.mobilizeEventId, payload);
			// Only after the PUT lands: recording a cap we did not manage to send
			// would make the next run believe Mobilize already has it.
			await ledger.recordPushedCaps?.(capsFrom(slotPlan.timeslots));
			report.updated++;
			report.updatedTitles.push(`${plan.title} (${changes.join(', ')})`);
			log(`updated #${record.mobilizeEventId} "${plan.title}" — ${changes.join(', ')}`);
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.authFailed = true;
				report.errors.push('Mobilize rejected the API key (403) — check MOBILIZE_API_KEY');
				return report;
			}
			report.failed++;
			report.errors.push(`update "${plan.title}": ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	return report;
}
