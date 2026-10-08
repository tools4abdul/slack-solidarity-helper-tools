/**
 * What db-replica.ts does to rows about volunteers who signed in with Google
 * or Apple, so a local copy of production carries nothing that identifies
 * them.
 *
 * Two parts:
 *   - Tables that exist only to hold their personal details are left out
 *     entirely: the sign-in records (`outside_volunteers`, and the retired
 *     `google_volunteers` it was copied from, until that is dropped), with
 *     their emails, and `turf_notices`, the messages kept for them, which name
 *     MiniVAN list numbers.
 *   - Where their `google:<sub>` / `apple:<sub>` id is the row's person — the
 *     id column of turf checkouts and the block list — it is swapped for a
 *     stand-in such as `apple:replica-3`, the same one for the same person in
 *     every table, so claims and blocks still line up. The name on those rows
 *     becomes "Apple volunteer 3", including inside a checkout's
 *     `sheet_state`, which keeps the Canvasser cell as written to the
 *     campaign's sheet. A block's free-text reason is dropped, since an admin
 *     may have written who the person is there.
 *
 *   - Their real names are also learned before anything is copied (from the
 *     sign-in records, checkouts and blocks) and replaced on every row —
 *     anyone's, not only theirs — in the columns that name canvassers without
 *     an id: the sheet's assignee on a turf, VAN's canvassers for a turf, its
 *     per-canvasser door knocks, MiniVAN export canvassers (first and last
 *     name matched together), and a checkout's record of the sheet cells it
 *     found, which can name whoever held the packet before. Matching is by
 *     name, so a Slack member who happens to share one is renamed too — the
 *     safe way to be wrong.
 *
 * What it cannot see: a name VAN or the sheet spells differently from how the
 * volunteer gave it (a nickname, a missing middle name) is copied unchanged.
 * Case and spacing are ignored, and the mark the app puts before the names it
 * writes into the sheet (`*Ana Ruiz`), which the stand-in keeps; nothing more.
 *
 * Only the id columns decide whose row it is, so a Slack member's row that
 * merely mentions `google:` in free text keeps its reason and name. Otherwise
 * Slack members' rows are copied as they are.
 */

import type { InValue } from '@libsql/client';
import { OUR_NAME_MARK } from '../src/lib/van/packet-tracker.js';

/** Tables whose rows are never copied because they hold outside volunteers'
 *  personal details. */
export const OUTSIDE_VOLUNTEER_TABLES: ReadonlySet<string> = new Set([
	'outside_volunteers',
	'google_volunteers',
	'turf_notices',
]);

/** Columns that hold the id of the person a row is about. */
const ID_COLUMNS = new Set(['slack_user_id', 'user_id']);

/** Columns that hold the name of the person a row is about. */
const NAME_COLUMNS = new Set(['slack_user_name', 'display_name']);

/** Free text an admin wrote about the person, cleared on their rows. */
const ABOUT_COLUMNS = new Set(['reason']);

/**
 * Where else a Google or Apple volunteer's real name turns up, on any row —
 * not only their own. For them these are very likely their real name, so any
 * value matching a name learned up front (see `learn`) becomes that
 * volunteer's stand-in name, wherever it is found:
 *
 *   - `sheet_assigned_to`, `canvasser` — a single name: who the Packet
 *     Tracker sheet says a turf is assigned to; VAN's per-canvasser door
 *     knocks.
 *   - `van_distributed_to` — VAN's canvassers for a turf, joined with ", ".
 *   - `sheet_state` — JSON: a checkout's record of the sheet cells it wrote
 *     (`cells`) and found there before (`prior`). Only their `Canvasser`
 *     cells are looked at; the prior one can be another volunteer's name.
 *   - `walk_in_state` — JSON: the Walk Ins row a checkout filled in, with
 *     the `name` it wrote there.
 *   - `canvassers_json` — JSON from MiniVAN: `{canvassserId, firstName,
 *     lastName}` per canvasser, matched as one whole name (or `name`, when an
 *     instance sends one). NOT NULL, so an unreadable value becomes `[]`.
 *
 * Inside JSON only those name positions are touched. Matching every string
 * would rewrite whatever happened to equal a learned name — a status the app
 * reads back, or "Jane" inside "Jane Smith", leaving the surname behind.
 */
const SINGLE_NAME_COLUMNS = new Set(['sheet_assigned_to', 'canvasser']);
const LIST_NAME_COLUMNS = new Set(['van_distributed_to']);
const JSON_NAME_COLUMNS: ReadonlyMap<
	string,
	{ scrub: (parsed: unknown, replace: Replace) => boolean; unreadable: string | null }
> = new Map([
	['sheet_state', { scrub: scrubSheetState, unreadable: null }],
	['walk_in_state', { scrub: scrubWalkInState, unreadable: null }],
	['canvassers_json', { scrub: scrubCanvassers, unreadable: '[]' }],
]);
/** How VAN joins canvassers in `van_distributed_to` (catalog.ts). */
const LIST_SEPARATOR = ', ';

/** How names are compared across sources that spell them differently. */
function nameKey(name: string): string {
	return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const OUTSIDE_ID = /^(google|apple):/;

/**
 * What the app calls a volunteer with no name — spec 013's word for a
 * nameless Google volunteer, still on its old records and claims, and the
 * session placeholder outside-signin.ts uses now. Shared by everyone without
 * a name, so never learned as anyone's.
 */
const PLACEHOLDER_KEYS = new Set(['google volunteer', 'apple volunteer']);

export class OutsideIdScrubber {
	private readonly standIns = new Map<string, { id: string; name: string }>();
	private next = { google: 1, apple: 1 };
	/** Every real name learned for an outside volunteer → their stand-in name. */
	private readonly names = new Map<string, string>();

	/**
	 * Note one outside volunteer's real name before any row is copied, so it
	 * can be replaced wherever it turns up — including columns copied before
	 * the rows that tie it to their id.
	 */
	learn(id: string, name: string | null): void {
		const match = OUTSIDE_ID.exec(id);
		if (!match) return;
		const standIn = this.standIn(id, match[1] as 'google' | 'apple');
		if (!name) return;
		const key = nameKey(name);
		// A placeholder is not a name: every nameless volunteer shares it, so
		// learning it would credit each one to whichever was learned last.
		if (key === '' || PLACEHOLDER_KEYS.has(key)) return;
		this.names.set(key, standIn.name);
	}

	/** A learned real name's stand-in, or undefined. */
	private looseName(value: string): string | undefined {
		return this.names.get(nameKey(value));
	}

	/** The stand-in for one real outside id — the same every time it is seen. */
	private standIn(id: string, provider: 'google' | 'apple') {
		let found = this.standIns.get(id);
		if (!found) {
			const n = this.next[provider]++;
			const label = provider === 'apple' ? 'Apple' : 'Google';
			found = { id: `${provider}:replica-${n}`, name: `${label} volunteer ${n}` };
			this.standIns.set(id, found);
		}
		return found;
	}

	/**
	 * The values to insert for one row. A row whose id column holds an outside
	 * id gets that id, its name columns and any reason replaced. Every row —
	 * theirs or anyone's — has learned names replaced in the columns above.
	 * Returns the same array when nothing changed.
	 */
	scrub(columns: readonly string[], values: InValue[]): InValue[] {
		const idAt = columns.findIndex((column, i) => {
			const v = values[i];
			return ID_COLUMNS.has(column) && typeof v === 'string' && OUTSIDE_ID.test(v);
		});

		// This row's own person, when it has one: their names, as written on
		// it, stand for them too — even one never learned up front.
		let own: { id: string; name: string } | null = null;
		const ownNames = new Set<string>();
		if (idAt >= 0) {
			const id = values[idAt] as string;
			own = this.standIn(id, OUTSIDE_ID.exec(id)![1] as 'google' | 'apple');
			columns.forEach((column, i) => {
				const v = values[i];
				if (NAME_COLUMNS.has(column) && typeof v === 'string' && nameKey(v) !== '') {
					ownNames.add(nameKey(v));
				}
			});
		}
		const whole = (name: string): string | undefined =>
			own && ownNames.has(nameKey(name)) ? own.name : this.looseName(name);
		const replace = (name: string): string | undefined => {
			const found = whole(name);
			if (found !== undefined || !name.startsWith(OUR_NAME_MARK)) return found;
			// A name the app wrote into the sheet carries its mark; the name
			// under it is still theirs. Tried second, for a volunteer whose own
			// name starts with the mark.
			const bare = whole(name.slice(OUR_NAME_MARK.length));
			return bare === undefined ? undefined : `${OUR_NAME_MARK}${bare}`;
		};

		let changed = false;
		const out = values.map((value, i) => {
			const column = columns[i]!;
			let next: InValue = value;
			if (own && i === idAt) next = own.id;
			else if (own && NAME_COLUMNS.has(column)) next = value === null ? null : own.name;
			else if (own && ABOUT_COLUMNS.has(column)) next = null;
			else if (typeof value === 'string') next = this.scrubNames(column, value, replace);
			if (next !== value) changed = true;
			return next;
		});
		return changed ? out : values;
	}

	/** One value of a column that can hold names, with each known one
	 *  replaced; `value` itself when there is nothing to replace. */
	private scrubNames(column: string, value: string, replace: Replace): InValue {
		if (SINGLE_NAME_COLUMNS.has(column)) return replace(value) ?? value;
		if (LIST_NAME_COLUMNS.has(column)) {
			const parts = value.split(LIST_SEPARATOR);
			const next = parts.map((part) => replace(part) ?? part);
			return next.some((part, i) => part !== parts[i]) ? next.join(LIST_SEPARATOR) : value;
		}
		const json = JSON_NAME_COLUMNS.get(column);
		if (json) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				// It may hold a name in a form this cannot see.
				return json.unreadable;
			}
			return json.scrub(parsed, replace) ? JSON.stringify(parsed) : value;
		}
		return value;
	}

	/** How many distinct people were replaced, for the run's summary. */
	get count(): number {
		return this.standIns.size;
	}
}

/** A stand-in for a learned real name, or undefined. */
type Replace = (name: string) => string | undefined;

/** The `Canvasser` cell of a checkout's written (`cells`) and found
 *  (`prior`) sheet values, replaced in place. True when one was. */
function scrubSheetState(parsed: unknown, replace: Replace): boolean {
	let changed = false;
	if (!parsed || typeof parsed !== 'object') return false;
	for (const key of ['cells', 'prior'] as const) {
		const cells = (parsed as Record<string, unknown>)[key];
		if (!cells || typeof cells !== 'object') continue;
		const record = cells as Record<string, unknown>;
		if (typeof record.Canvasser !== 'string') continue;
		const standIn = replace(record.Canvasser);
		if (standIn === undefined) continue;
		record.Canvasser = standIn;
		changed = true;
	}
	return changed;
}

/** The `name` a checkout wrote on the Walk Ins tab, replaced in place. True
 *  when it was. */
function scrubWalkInState(parsed: unknown, replace: Replace): boolean {
	if (!parsed || typeof parsed !== 'object') return false;
	const record = parsed as Record<string, unknown>;
	if (typeof record.name !== 'string') return false;
	const standIn = replace(record.name);
	if (standIn === undefined) return false;
	record.name = standIn;
	return true;
}

/** Each MiniVAN canvasser's name, matched whole and replaced in place — split
 *  back the same way ("Apple" / "volunteer 3"). True when one was. */
function scrubCanvassers(parsed: unknown, replace: Replace): boolean {
	if (!Array.isArray(parsed)) return false;
	let changed = false;
	for (const item of parsed) {
		if (!item || typeof item !== 'object') continue;
		const c = item as Record<string, unknown>;
		if (typeof c.name === 'string') {
			const standIn = replace(c.name);
			if (standIn !== undefined) {
				c.name = standIn;
				changed = true;
			}
		}
		if (typeof c.firstName === 'string' || typeof c.lastName === 'string') {
			const whole = [c.firstName, c.lastName]
				.filter((part): part is string => typeof part === 'string')
				.join(' ');
			const standIn = replace(whole);
			if (standIn !== undefined) {
				const [first, ...rest] = standIn.split(' ');
				c.firstName = first;
				c.lastName = rest.join(' ');
				changed = true;
			}
		}
	}
	return changed;
}
