import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listWalks } from '$lib/server/walk-progress.js';

// GET → the Solidarity page walks running right now, so the comparison page can
// draw a real progress bar instead of asking the admin to trust a spinner for
// three minutes.
//
// Deliberately reports global state rather than this request's own: the caches
// these walks fill are shared, so a second admin who lands mid-walk is waiting
// on exactly this walk and should watch it finish.
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}
	return json({ steps: listWalks() });
};
