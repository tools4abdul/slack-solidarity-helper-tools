/**
 * A turf's history across VAN's cuts: for when a canvasser says "I knocked
 * this turf, and now it looks untouched."
 *
 * Read-only, and it makes no VAN call. For each cut of the turf it shows the
 * list, the doors, what the app shows as left, when its doors were knocked
 * (from VAN's ContactHistory, as last pulled), and who claimed it here — then
 * one line on why the live cut looks the way it does. The usual answer: VAN
 * re-cut the region and kept doors already knocked, and the doors-left count
 * starts fresh at each cut (van/turf-history-store.ts).
 *
 * Usage (from project root):
 *   npm run van:turf -- "R02F_037_Kent_PlainfieldTowns_003 Turf 05"
 *   npm run van:turf -- R02F_037_Kent_PlainfieldTowns_003   # every turf in the region
 *   npm run van:turf -- 3271070                             # by turf id
 *
 * Matches part of a turf's name or region, in every campaign. Times are
 * campaign-local.
 *
 * Required env vars:
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { campaignSheetStamp } from '../src/lib/campaign-time.js';
import {
	explainLiveCut,
	loadTurfHistory,
	type TurfCut,
	type TurfCutClaim,
} from '../src/lib/server/van/turf-history-store.js';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
	console.error('Usage: npm run van:turf -- <turf name, region, or turf id>');
	process.exit(1);
}

const db = drizzle(createClient(dbConfig));

function claimLine(c: TurfCutClaim): string {
	const outcome = c.completedAt
		? `marked walked ${campaignSheetStamp(c.completedAt)}` +
			(c.reportedPercent !== null ? ` at ${c.reportedPercent}%` : '')
		: c.releasedAt
			? `${c.releaseReason ?? 'released'} ${campaignSheetStamp(c.releasedAt)}`
			: 'still held';
	const knocked = c.doorsKnocked !== null ? ` · ${c.doorsKnocked} doors knocked` : '';
	return `${campaignSheetStamp(c.claimedAt)}  ${c.slackUserName} — ${outcome}${knocked}`;
}

function printCut(cut: TurfCut): void {
	const state = cut.retiredAt ? `retired ${campaignSheetStamp(cut.retiredAt)}` : 'LIVE';
	console.log(
		`\n  Cut ${campaignSheetStamp(cut.cutAt)} · ${state} · turf ${cut.turfId} · list ${cut.savedListId ?? '—'}`,
	);
	const left =
		cut.uncontactedDoors !== null && cut.rosterCurrent
			? `${cut.uncontactedDoors} left to knock`
			: `no roster — shows VAN's ${cut.doorCount}`;
	console.log(`    ${cut.doorCount} doors (VAN) · app shows ${left}`);
	if (cut.rosterDoors === null) {
		console.log('    no roster, so no knock history');
	} else {
		console.log(
			`    knocked since this cut: ${cut.knockedSinceCut} of ${cut.rosterDoors} doors` +
				(cut.knockedBeforeCut > 0
					? ` · before it: ${cut.knockedBeforeCut} (not counted against this cut)`
					: ''),
		);
		if (cut.knockedByDay.length > 0) {
			console.log(
				`    doors by day of latest knock: ${cut.knockedByDay.map((d) => `${d.day} ${d.doors}`).join(', ')}`,
			);
		}
	}
	if (cut.claims.length === 0) {
		console.log('    no claims in this app');
	} else {
		console.log('    claims:');
		for (const c of cut.claims) console.log(`      ${claimLine(c)}`);
	}
}

async function main(): Promise<void> {
	const histories = await loadTurfHistory(db, query);
	if (histories.length === 0) {
		console.log(`No turf matches "${query}".`);
		return;
	}
	for (const history of histories) {
		console.log(`\n${history.name}  (campaign ${history.campaignId})`);
		for (const cut of history.cuts) printCut(cut);
		const why = explainLiveCut(history);
		if (why) console.log(`\n  → ${why}`);
	}
	console.log('');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
