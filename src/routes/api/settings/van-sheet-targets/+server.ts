import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import {
	saveVanSheetTarget,
	deleteVanSheetTarget,
	loadVanSheetTargets,
	type Editor,
} from '$lib/server/settings.js';
import { normaliseSheetKey } from '$lib/van/sheet-routing.js';
import { sheetsClient } from '$lib/server/google-env.js';
import { DEFAULT_SHEET_TAB_NAME } from '$lib/van/sheet-log.js';

// Which spreadsheet each region's turf checkouts are logged to.
//
// One rule per request, saved whole. Like van_chapter_folders this is an INPUT
// to the sync rather than something it discovers: with no rules the sheet log
// does nothing at all, and it can be filled in before the Google credential
// exists so it is ready the day that lands.
//
// Rules are matched by LONGEST normalised prefix, so ordering is not something
// an admin has to think about — `R10C_Wayne_Taylor` beats a bare `R10C`
// whatever order they were entered in. What an admin does have to get right is
// the spreadsheet id, which is validated for shape but NOT checked against
// Google: there may be no credential yet, and a wrong id surfaces as a failed
// write with an operator alert rather than as anything unsafe.
//
// The spreadsheet's NAME is read from Google here rather than typed, and stored
// alongside the id. Stored, not fetched on demand, because the one place it
// really matters is the alert that says a spreadsheet cannot be written to —
// which fires exactly when Google will not tell us its name. A name we could
// only look up while things are working is a name we would never have when it
// counts. When the lookup fails (no credential yet, sheet not shared yet) the
// id stands in, and re-saving any rule for that sheet backfills the real one.

interface SheetTargetBody {
	action?: unknown;
	prefix?: unknown;
	spreadsheetId?: unknown;
	prefixKey?: unknown;
}

const MAX_PREFIX_LENGTH = 120;
/** Google's ids are 44 chars today; the cap is loose because the length is not
 *  documented as stable and a too-tight check would reject a valid sheet. */
const MAX_SPREADSHEET_ID_LENGTH = 200;

/** What a spreadsheet id looks like in a Sheets URL. Deliberately a shape
 *  check, not an existence check — see the header. */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/;

/** Pull the id out of a pasted URL, because that is what an admin has on their
 *  clipboard. Accepting the whole URL and extracting it here is the difference
 *  between a field that works first time and one that needs an explanation. */
function extractSpreadsheetId(raw: string): string {
	const match = raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
	return (match?.[1] ?? raw).trim();
}

/**
 * The spreadsheet's name as Google reports it, or the id when it cannot be
 * read.
 *
 * Never throws and never blocks the save: a rule an admin can write before the
 * credential exists is the whole reason this page works pre-launch, and an
 * unreachable sheet is a thing to alert about later rather than a reason to
 * refuse the rule now.
 */
async function resolveLabel(spreadsheetId: string): Promise<string> {
	const configured = sheetsClient();
	if (!configured.ok) return spreadsheetId;
	try {
		const res = await configured.client.describe({
			spreadsheetId,
			// `describe` wants a tab to report on; the title is what we are after
			// and comes back regardless of whether that tab exists.
			tabName: DEFAULT_SHEET_TAB_NAME,
		});
		return res.ok && res.value.title.trim() !== '' ? res.value.title.trim() : spreadsheetId;
	} catch {
		return spreadsheetId;
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: SheetTargetBody;
	try {
		body = (await request.json()) as SheetTargetBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action } = body;
	if (action !== 'save' && action !== 'remove') {
		return json({ error: 'action must be "save" or "remove"' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'remove') {
		if (typeof body.prefixKey !== 'string' || body.prefixKey.trim() === '') {
			return json({ error: 'prefixKey is required' }, { status: 400 });
		}
		await deleteVanSheetTarget(db, body.prefixKey.trim(), editor);
		return json({ ok: true, targets: await loadVanSheetTargets(db) });
	}

	const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
	const spreadsheetId =
		typeof body.spreadsheetId === 'string' ? extractSpreadsheetId(body.spreadsheetId) : '';

	if (prefix === '' || prefix.length > MAX_PREFIX_LENGTH) {
		return json(
			{ error: `prefix must be a non-empty string under ${MAX_PREFIX_LENGTH} characters` },
			{ status: 400 },
		);
	}
	// A prefix that normalises to nothing — punctuation only — would match every
	// region name ever cut, silently making itself the catch-all for the whole
	// campaign. Refused here rather than defended against at match time.
	if (normaliseSheetKey(prefix) === '') {
		return json(
			{ error: 'prefix must contain letters or digits, not only punctuation' },
			{ status: 400 },
		);
	}
	if (
		spreadsheetId === '' ||
		spreadsheetId.length > MAX_SPREADSHEET_ID_LENGTH ||
		!SPREADSHEET_ID.test(spreadsheetId)
	) {
		return json(
			{ error: 'spreadsheetId must be a Google Sheets id, or the URL of one' },
			{ status: 400 },
		);
	}

	await saveVanSheetTarget(
		db,
		{ prefix, label: await resolveLabel(spreadsheetId), spreadsheetId },
		editor,
	);
	return json({ ok: true, targets: await loadVanSheetTargets(db) });
};
