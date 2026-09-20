// The counts behind `geometryProgressLabel`, read from the database.
//
// Four cheap aggregates rather than one clever join: the queue and the turf
// table answer different halves of the question (what is left to do, and what
// has landed), and a turf can be absent from the queue for two opposite reasons
// — it already has a shape, or it never had a saved list to export.
//
// Retired turf is excluded throughout. It is off the map, and counting it would
// make a finished run look permanently incomplete.

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanGeometryQueue, vanTurfs } from '../schema.js';
import type { GeometryProgress } from '../../van/geometry-progress.js';

type Db = ReturnType<typeof drizzle>;

const count = sql<number>`count(*)`;

export async function loadGeometryProgress(db: Db): Promise<GeometryProgress> {
	const live = and(isNull(vanTurfs.retiredAt), isNotNull(vanTurfs.savedListId));

	const [eligibleRow] = await db.select({ n: count }).from(vanTurfs).where(live);
	const [shapedRow] = await db
		.select({ n: count })
		.from(vanTurfs)
		.where(and(live, isNotNull(vanTurfs.hullJson)));
	const [centroidRow] = await db
		.select({ n: count })
		.from(vanTurfs)
		.where(and(live, isNull(vanTurfs.hullJson), isNotNull(vanTurfs.centroidLat)));

	// Queue rows are joined to live turf so a row left behind for turf that has
	// since retired does not count as outstanding work.
	const queue = await db
		.select({ status: vanGeometryQueue.status, n: count })
		.from(vanGeometryQueue)
		.innerJoin(vanTurfs, eq(vanGeometryQueue.mapRouteId, vanTurfs.mapRouteId))
		.where(isNull(vanTurfs.retiredAt))
		.groupBy(vanGeometryQueue.status);

	const byStatus = new Map(queue.map((row) => [row.status, Number(row.n)]));
	return {
		eligible: Number(eligibleRow?.n ?? 0),
		shaped: Number(shapedRow?.n ?? 0),
		centroidOnly: Number(centroidRow?.n ?? 0),
		// `running` is a row mid-flight, not a separate state to an organizer.
		pending: (byStatus.get('pending') ?? 0) + (byStatus.get('running') ?? 0),
		failed: byStatus.get('failed') ?? 0,
	};
}

/** Dead-lettered turfs with the error that stopped them, newest attempt first.
 *  For the CLI, which is where someone goes when the count is not zero. */
export async function loadGeometryFailures(
	db: Db,
	limit = 10,
): Promise<
	Array<{ mapRouteId: number; name: string; attempts: number; lastError: string | null }>
> {
	return db
		.select({
			mapRouteId: vanGeometryQueue.mapRouteId,
			name: vanTurfs.name,
			attempts: vanGeometryQueue.attempts,
			lastError: vanGeometryQueue.lastError,
		})
		.from(vanGeometryQueue)
		.innerJoin(vanTurfs, eq(vanGeometryQueue.mapRouteId, vanTurfs.mapRouteId))
		.where(and(eq(vanGeometryQueue.status, 'failed'), isNull(vanTurfs.retiredAt)))
		.limit(limit);
}
