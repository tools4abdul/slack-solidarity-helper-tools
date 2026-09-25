// Where a volunteer is, according to their own Solidarity profile.
//
// Used by a bare `/turfs`, with no ZIP or address typed after it. The command
// used to fall back to the channel it was typed in, which is a guess about the
// channel rather than about the person: plenty of volunteers run it from a DM
// or #general, and someone reading their county's channel may still live next
// door to it. The profile is the volunteer's own statement of where they live
// and which chapter they belong to, so it is asked first, and the command asks
// them to type a location when it has nothing to say.
//
// Never throws. Every failure — no Slack email, no Solidarity account, a
// Solidarity outage — comes back as `null`, and the caller asks for a ZIP. A
// volunteer on a corner gets a question they can answer, never an error.

import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { findSolidarityUserForSlack } from '../slack-solidarity-user.js';
import { chapterIdsOf } from '../solidarity-chapter-ids.js';
import type { SolidarityUser } from '../solidarity.js';
import { normalizeZip } from './zip-centroid.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface ProfileRegion {
	/** Five-digit ZIP from the profile's address, or null when it has none. */
	zip: string | null;
	/** Chapter memberships, in the order Solidarity lists them. */
	chapterIds: number[];
}

/**
 * The caller's ZIP and chapters, or null when no Solidarity profile could be
 * found for them. A profile with neither a ZIP nor a chapter comes back as an
 * empty region rather than null, so the caller can say which of the two it was.
 */
export async function profileRegionFor(db: Db, slackUserId: string): Promise<ProfileRegion | null> {
	try {
		const user = await findSolidarityUserForSlack(db, slackUserId);
		return user ? regionOf(user) : null;
	} catch (err) {
		console.warn(`${LOG} profile lookup failed for ${slackUserId}:`, errMessage(err));
		return null;
	}
}

/** The region a Solidarity user record describes. */
export function regionOf(user: SolidarityUser): ProfileRegion {
	return {
		zip: normalizeZip(user.address?.zip_code ?? null),
		chapterIds: chapterIdsOf(user),
	};
}
