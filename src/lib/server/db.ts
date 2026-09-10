import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } from './env.js';
import { sessions } from './schema.js';

export interface SessionData {
	slackUserId: string;
	slackUserName: string;
	isAdmin: boolean;
}

// Lazy-initialized so module import (e.g. SvelteKit's build-time analyse step,
// which runs without env vars) doesn't trigger createClient with an empty URL.
let _db: ReturnType<typeof drizzle> | undefined;
function getDb() {
	if (!_db) {
		_db = drizzle(createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN }));
	}
	return _db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
	get: (_t, prop, recv) => Reflect.get(getDb(), prop, recv),
});

/**
 * The outcome of a session lookup, as three states rather than two.
 *
 * `missing` and `unavailable` both mean "this request has no session", but they
 * must not be treated the same way afterwards. `missing` is a settled fact —
 * the row is gone or expired, and the cookie holding its id is now worthless,
 * so clearing it is right. `unavailable` means the DATABASE did not answer; the
 * session may well still exist. Collapsing the two (which this returned `null`
 * for both of, before) means a few seconds of Turso trouble deletes the session
 * cookie of every signed-in user and forces the whole workspace back through
 * Slack OAuth — a transient blip turned into a mass logout.
 */
export type SessionLookup =
	{ status: 'found'; data: SessionData } | { status: 'missing' } | { status: 'unavailable' };

export class TursoStore {
	async get(sid: string): Promise<SessionLookup> {
		try {
			const rows = await db
				.select({ data: sessions.data, expiresAt: sessions.expiresAt })
				.from(sessions)
				.where(eq(sessions.sid, sid));
			if (rows.length === 0) return { status: 'missing' };
			const row = rows[0]!;
			if (new Date(row.expiresAt) < new Date()) {
				await this.destroy(sid);
				return { status: 'missing' };
			}
			return { status: 'found', data: JSON.parse(row.data) as SessionData };
		} catch (err) {
			console.warn(
				'[session] session lookup failed — signing this request out but KEEPING the cookie:',
				err instanceof Error ? err.message : err,
			);
			return { status: 'unavailable' };
		}
	}

	async set(sid: string, data: SessionData, maxAgeSeconds: number): Promise<void> {
		const serialized = JSON.stringify(data);
		const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
		await db
			.insert(sessions)
			.values({ sid, data: serialized, expiresAt })
			.onConflictDoUpdate({ target: sessions.sid, set: { data: serialized, expiresAt } });
	}

	async destroy(sid: string): Promise<void> {
		await db.delete(sessions).where(eq(sessions.sid, sid));
	}
}

export const sessionStore = new TursoStore();
