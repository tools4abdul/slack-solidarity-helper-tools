import { describe, it, expect, beforeEach } from 'vitest';
import { GET } from './+server.js';
import { startWalk, _resetWalkProgressForTests } from '$lib/server/walk-progress.js';

const authed = { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true };
const nonAdmin = { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false };

const event = (session: unknown) => ({ locals: { session } }) as never;

describe('GET /api/channel-chapter-diff/progress', () => {
	beforeEach(() => _resetWalkProgressForTests());

	it('returns 401 when not signed in', async () => {
		expect((await GET(event(null))).status).toBe(401);
	});

	it('returns 403 for a signed-in non-admin', async () => {
		expect((await GET(event(nonAdmin))).status).toBe(403);
	});

	it('reports an empty step list when nothing is walking', async () => {
		const res = await GET(event(authed));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ steps: [] });
	});

	it('reports a running walk with its rows and total', async () => {
		startWalk('roster', 'Reading the Solidarity roster')(4200, 19026);

		const body = (await (await GET(event(authed))).json()) as {
			steps: { label: string; fetched: number; total: number | null }[];
		};

		expect(body.steps).toMatchObject([
			{ label: 'Reading the Solidarity roster', fetched: 4200, total: 19026 },
		]);
	});
});
