import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { turfAccess } from '$lib/van/access.js';
import { claimTurf, endClaim } from '$lib/server/van/checkout-store.js';
import { recordRequest } from '$lib/van/request-budget.js';
import { pruneRateLimitStores, turfRequests } from '$lib/server/van/rate-limit-store.js';

// Claim, release, and complete, as one handler over an `action` body rather
// than three sibling routes.
//
// Rate-limited on the same shared budget as the read endpoints, for a reason
// that is not obvious: the refusals here are informative. A 404 means no such
// route id, a 409 carries a specific reason — already held, no list number, no
// doors left. Walked over a range of ids that is an existence-and-status
// oracle for the whole database, and it sits outside the chapter compartment
// entirely, since a route id is all it takes. The budget is what makes walking
// it slow and loud. They share every line of their guard — session,
// then the blocklist, then a valid route id — and splitting them would mean
// three copies of that guard, one of which eventually drifts. `van/access.ts`
// is consulted on every one, per the plan's Principle I contract:
// 401 unauthenticated, 403 unauthorized.

type Action = 'claim' | 'release' | 'complete';

const ACTIONS = new Set<Action>(['claim', 'release', 'complete']);

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });

	const now = Date.now();
	pruneRateLimitStores(now);

	const budget = recordRequest(turfRequests, session.slackUserId, now, {
		exempt: session.isAdmin,
	});
	if (!budget.allowed) {
		console.warn(`[van] turf API request budget exhausted: user=${session.slackUserId}`);
		return json(
			{ error: 'Too many requests. Slow down and try again shortly.' },
			{ status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
		);
	}

	const access = turfAccess(
		{ slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		await loadVanBlockedIds(db),
		SLACK_SUPERUSER_ID,
	);
	if (!access.allowed) return json({ error: access.message }, { status: 403 });

	const mapRouteId = Number(params.mapRouteId);
	if (!Number.isInteger(mapRouteId)) {
		return json({ error: 'Unknown turf' }, { status: 400 });
	}

	let action: unknown;
	try {
		({ action } = (await request.json()) as { action?: unknown });
	} catch {
		return json({ error: 'Malformed request' }, { status: 400 });
	}
	if (typeof action !== 'string' || !ACTIONS.has(action as Action)) {
		return json({ error: 'Unknown action' }, { status: 400 });
	}

	if (action === 'claim') {
		// The TTL and the per-volunteer cap come from /settings (Story 7.4). This
		// is the enforcing side: the page greys out a turf it thinks is
		// unclaimable, but `canClaim` inside claimTurf is what actually refuses,
		// so both have to be handed the same numbers.
		const settings = await loadSettings(db);
		const result = await claimTurf(db, {
			mapRouteId,
			slackUserId: session.slackUserId,
			slackUserName: session.slackUserName,
			now: new Date(now),
			options: {
				ttlHours: settings.vanTurfClaimTtlHours,
				maxConcurrentClaims: settings.vanTurfMaxConcurrentClaims,
			},
		});
		if (!result.ok) return json({ error: result.message }, { status: result.status });
		return json({
			expiresAt: result.expiresAt,
			// Issued only on a successful claim. This response is the only path
			// by which a list number reaches a browser.
			printedListNumber: result.printedListNumber,
		});
	}

	const result = await endClaim(db, {
		mapRouteId,
		slackUserId: session.slackUserId,
		now: new Date(now),
		kind: action === 'complete' ? 'complete' : 'release',
	});
	if (!result.ok) return json({ error: result.message }, { status: result.status });
	// Story 5.6 hangs off completion, and finishes elsewhere: `endClaim` records
	// a refresh request for this turf's region, the sweep sends it, and once
	// VAN's re-cut lands the door-delta check stamps `confirmedDoorDelta` and
	// nudges the volunteer if nothing moved. Nothing to do here — the whole
	// point is that the volunteer's request does not wait on VAN.
	return json({ ok: true });
};
