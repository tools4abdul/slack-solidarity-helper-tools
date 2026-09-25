// The Solidarity account behind a Slack user.
//
// Follows the same order as member-lookup.ts: an admin-made link wins over an
// email match, always, because a link exists precisely where the email
// heuristic got it wrong. The /members page keeps its own copy of these steps
// because it needs to know WHY a lookup came up empty; this is for callers that
// only need the account.
//
// Throws on a lookup failure (the database, Slack or Solidarity); null strictly
// means "no account found". Callers that should degrade quietly wrap it.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { SOLIDARITY_API_TOKEN } from './env.js';
import { memberAccountLinks } from './schema.js';
import { slack } from './slack.js';
import { findUserByEmailStrict, getUserById, type SolidarityUser } from './solidarity.js';

type Db = ReturnType<typeof drizzle>;

export async function findSolidarityUserForSlack(
	db: Db,
	slackUserId: string,
): Promise<SolidarityUser | null> {
	const [link] = await db
		.select({ solidarityUserId: memberAccountLinks.solidarityUserId })
		.from(memberAccountLinks)
		.where(eq(memberAccountLinks.slackUserId, slackUserId))
		.limit(1);
	if (link) return getUserById(SOLIDARITY_API_TOKEN, link.solidarityUserId);

	const info = await slack.users.info({ user: slackUserId });
	const email = (info.user as { profile?: { email?: string } } | undefined)?.profile?.email;
	if (!email) return null;
	return findUserByEmailStrict(SOLIDARITY_API_TOKEN, email);
}
