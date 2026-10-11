// One turf's story across its cuts, for answering "I canvassed this — why does
// it look untouched?" (scripts/van-turf-history.ts).
//
// VAN's mapRouteId names a CUT, not the ground (see vanTurfs in schema.ts): a
// region refresh retires every route in it and issues new ones under the same
// names. The doors-left count starts fresh at each cut — a contact before
// `cutAt` does not take a door off the new route (recountStatement) — so a
// re-cut that keeps doors a volunteer already knocked shows them as left to
// knock. This puts each cut side by side with when its doors were knocked,
// which is what tells that apart from contacts that never reached VAN.
//
// Counts only. Hashes are read to group doors and go no further.

import { and, asc, eq, like, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { campaignDayKey, campaignSheetStamp } from '../../campaign-time.js';
import { vanPersonContacts, vanTurfCheckouts, vanTurfRoster, vanTurfs } from '../schema.js';

type Db = ReturnType<typeof drizzle>;

export interface TurfCutClaim {
	claimedAt: string;
	slackUserName: string;
	completedAt: string | null;
	releasedAt: string | null;
	releaseReason: string | null;
	reportedPercent: number | null;
	doorsKnocked: number | null;
}

export interface TurfCut {
	turfId: number;
	campaignId: number;
	name: string;
	savedListId: number | null;
	/** When VAN cut it; firstSeenAt when VAN did not say. */
	cutAt: string;
	retiredAt: string | null;
	/** VAN's door count. */
	doorCount: number;
	/** What the app shows as left to knock. Null: no roster for the current
	 *  list, so the app falls back to `doorCount`. */
	uncontactedDoors: number | null;
	/** Whether the stored roster is this cut's list. */
	rosterCurrent: boolean;
	/** Roster doors; null with no roster at all. */
	rosterDoors: number | null;
	/** Roster doors whose latest in-person contact is on or after the cut —
	 *  what the count takes off. */
	knockedSinceCut: number;
	/** Roster doors whose latest in-person contact is before the cut — knocked,
	 *  but under an earlier cut, so still counted as left. */
	knockedBeforeCut: number;
	/** The latest of those, or null. */
	lastKnockedBeforeCut: string | null;
	/** Doors knocked per campaign-local day (YYYY-MM-DD), by their latest
	 *  contact, oldest first. */
	knockedByDay: Array<{ day: string; doors: number }>;
	claims: TurfCutClaim[];
}

export interface TurfHistory {
	name: string;
	campaignId: number;
	/** Oldest cut first. */
	cuts: TurfCut[];
}

/**
 * Every cut of every turf matching `query` — a turf id, or part of a turf's
 * name or region — grouped by name, oldest cut first. A turf id finds the
 * other cuts under its name too.
 */
export async function loadTurfHistory(db: Db, query: string): Promise<TurfHistory[]> {
	const id = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
	let names: Array<{ name: string; campaignId: number }>;
	if (id !== null) {
		names = await db
			.select({ name: vanTurfs.name, campaignId: vanTurfs.campaignId })
			.from(vanTurfs)
			.where(eq(vanTurfs.turfId, id));
	} else {
		const pattern = `%${query.trim()}%`;
		names = await db
			.selectDistinct({ name: vanTurfs.name, campaignId: vanTurfs.campaignId })
			.from(vanTurfs)
			.where(or(like(vanTurfs.name, pattern), like(vanTurfs.regionName, pattern)))
			.orderBy(asc(vanTurfs.name));
	}

	const histories: TurfHistory[] = [];
	for (const { name, campaignId } of names) {
		const rows = await db
			.select()
			.from(vanTurfs)
			.where(and(eq(vanTurfs.campaignId, campaignId), eq(vanTurfs.name, name)))
			.orderBy(asc(sql`coalesce(${vanTurfs.cutAt}, ${vanTurfs.firstSeenAt})`));
		const cuts: TurfCut[] = [];
		for (const turf of rows) cuts.push(await loadCut(db, turf));
		histories.push({ name, campaignId, cuts });
	}
	return histories;
}

async function loadCut(db: Db, turf: typeof vanTurfs.$inferSelect): Promise<TurfCut> {
	const cutAt = turf.cutAt ?? turf.firstSeenAt;
	// Each door's latest in-person contact, by any of its people. Null for a
	// door nobody at was contacted.
	const doors = await db
		.select({
			at: sql<string | null>`max(${vanPersonContacts.lastInPersonAt})`,
		})
		.from(vanTurfRoster)
		.leftJoin(
			vanPersonContacts,
			and(
				eq(vanPersonContacts.campaignId, turf.campaignId),
				eq(vanPersonContacts.personHash, vanTurfRoster.personHash),
			),
		)
		.where(eq(vanTurfRoster.turfId, turf.turfId))
		.groupBy(vanTurfRoster.doorHash);

	let knockedSinceCut = 0;
	let knockedBeforeCut = 0;
	let lastKnockedBeforeCut: string | null = null;
	const byDay = new Map<string, number>();
	for (const { at } of doors) {
		if (at === null) continue;
		if (at >= cutAt) {
			knockedSinceCut++;
		} else {
			knockedBeforeCut++;
			if (lastKnockedBeforeCut === null || at > lastKnockedBeforeCut) lastKnockedBeforeCut = at;
		}
		const day = campaignDayKey(at);
		byDay.set(day, (byDay.get(day) ?? 0) + 1);
	}

	const claims = await db
		.select({
			claimedAt: vanTurfCheckouts.claimedAt,
			slackUserName: vanTurfCheckouts.slackUserName,
			completedAt: vanTurfCheckouts.completedAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			releaseReason: vanTurfCheckouts.releaseReason,
			reportedPercent: vanTurfCheckouts.reportedPercent,
			doorsKnocked: vanTurfCheckouts.doorsKnocked,
		})
		.from(vanTurfCheckouts)
		.where(eq(vanTurfCheckouts.turfId, turf.turfId))
		.orderBy(asc(vanTurfCheckouts.claimedAt));

	return {
		turfId: turf.turfId,
		campaignId: turf.campaignId,
		name: turf.name,
		savedListId: turf.savedListId,
		cutAt,
		retiredAt: turf.retiredAt,
		doorCount: turf.doorCount,
		uncontactedDoors: turf.uncontactedDoors,
		rosterCurrent: turf.rosterSavedListId !== null && turf.rosterSavedListId === turf.savedListId,
		rosterDoors: doors.length > 0 ? doors.length : null,
		knockedSinceCut,
		knockedBeforeCut,
		lastKnockedBeforeCut,
		knockedByDay: [...byDay]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([day, n]) => ({ day, doors: n })),
		claims,
	};
}

/**
 * Why the live cut looks the way it does, in a sentence — or null when there
 * is nothing surprising to explain.
 */
export function explainLiveCut(history: TurfHistory): string | null {
	const live = history.cuts.filter((c) => c.retiredAt === null).at(-1);
	if (!live) return 'Every cut of this turf is retired: VAN no longer has it.';
	if (!live.rosterCurrent) {
		return (
			'No roster for the current list yet, so the app shows VAN’s door count ' +
			`(${live.doorCount}) rather than doors left. The geometry queue builds it.`
		);
	}
	if (live.knockedBeforeCut > 0) {
		const earlier = history.cuts.length > 1 ? ' and kept doors already knocked' : '';
		return (
			`VAN re-cut this turf at ${campaignSheetStamp(live.cutAt)}${earlier}: ` +
			`${live.knockedBeforeCut} of its ${live.rosterDoors} doors were knocked before the cut ` +
			`(latest ${campaignSheetStamp(live.lastKnockedBeforeCut!)}). ` +
			'The doors-left count starts fresh at each cut, so they count as left to knock.'
		);
	}
	if (live.knockedSinceCut === 0 && history.cuts.length > 1) {
		return (
			'VAN has no in-person contact for any of this cut’s doors, before or after the cut. ' +
			'If it was canvassed, the results have not reached VAN — MiniVAN may not have synced.'
		);
	}
	return null;
}
