// Response shapes for the NGP VAN v4 API, transcribed from the published
// OpenAPI definitions rather than inferred from sample payloads.
//
// Only the fields this app reads are modelled. VAN returns considerably more
// on most of these — deliberately not typed, because a field that appears here
// is a field someone might start persisting, and the security posture in
// specs/010-van-turf-checkout/plan.md §3 turns on nothing per-person ever
// reaching the database.

/** A VAN folder. Turf lives in folders; van_chapter_folders maps them to
 *  Solidarity chapters. */
export interface VanFolder {
	folderId: number;
	name: string;
}

/** One walkable turf inside a Map Region.
 *
 *  `mapRouteId` is NOT stable across a refresh. Verified live on 2026-09-08
 *  (plan.md Story 4.6): refreshing a region retired routes 56456/56457 and
 *  returned 56502/56503 with new saved lists. A route id names a CUT of a
 *  piece of ground, not the ground, so nothing may hold one across a refresh
 *  window and expect it to resolve — see van/refresh-reconcile.ts, which pairs
 *  a dead route to its replacement by region and name because there is no id
 *  in common to pair on. */
export interface VanMapRoute {
	mapRouteId: number;
	name: string | null;
	savedListId: number | null;
	routeNumber: number | null;
	/** People in the list. */
	routeSize: number | null;
	/** Unique doors. */
	doorCount: number | null;
	phoneCount: number | null;
	/** Present once someone has generated the printed list. The `number` here
	 *  is what a volunteer types into MiniVAN. */
	printedList: {
		number: string | null;
		dateCreated?: string | null;
		createdBy?: string | null;
	} | null;
}

/** A drawn region containing one or more routes. VAN never exposes the drawn
 *  boundary — see plan.md §2 Constraint A, which is why we derive hulls. */
export interface VanMapRegion {
	mapRegionId: number;
	name: string | null;
	description?: string | null;
	mapRoutes: VanMapRoute[] | null;
	dateCreated?: string | null;
	/** When VAN last re-cut this region against current data.
	 *
	 *  Load-bearing rather than informational: it is VAN's own answer to "how
	 *  stale are these door counts", which beats inferring it from when our
	 *  sync last ran. Our sync time says when we asked; this says when the
	 *  numbers were actually recomputed, and those diverge whenever a refresh
	 *  is deferred or fails. The UI's "doors remaining as of N hours ago" is
	 *  only honest if it uses this one. */
	dateRefreshed?: string | null;
}

/** A MiniVAN list number and the folders it covers. Used as a cross-check on
 *  `VanMapRoute.printedList`, not as the primary source. */
export interface VanPrintedList {
	number: string;
	name: string | null;
	listSize: number | null;
	folders: VanFolder[] | null;
	dateCreated: string | null;
	createdBy: string | null;
}

export interface VanSavedList {
	savedListId: number;
	name: string | null;
	description: string | null;
	listCount: number | null;
	doorCount: number | null;
}

/** Evidence that an organizer distributed turf to MiniVAN outside this app.
 *  `canvassers` only populates with `$expand=canvassers`. */
export interface VanMinivanExport {
	minivanExportId: number;
	name: string | null;
	dateCreated: string | null;
	createdBy: string | null;
	canvassers: Array<{ canvasserId?: number; name?: string | null }> | null;
	databaseMode: string | null;
}

/** Export job types are issued per developer — the numeric ids in VAN's docs
 *  are examples, not constants, so we discover ours (plan.md Story 1.5). */
export interface VanExportJobType {
	exportJobTypeId: number;
	name: string | null;
}

export interface VanExportJob {
	exportJobId: number;
	/** The export job type, echoed back as `type` — NOT `exportJobTypeId`,
	 *  which is the name only the *request* uses. Verified against the live
	 *  API: neither POST /exportJobs nor GET /exportJobs/{id} returns a field
	 *  called `exportJobTypeId`, so reading one gets `undefined` forever. */
	type: number | null;
	savedListId: number | null;
	/** 'Pending' | 'InProcess' | 'Completed' | 'Error' (VAN's casing varies by
	 *  endpoint; compare case-insensitively). Small lists come back already
	 *  'Completed' from the POST, with `downloadUrl` populated — the poll loop
	 *  must handle a job that is done before it is first read. */
	status: string | null;
	downloadUrl: string | null;
	/** When `downloadUrl` stops working — advisory only. POST and GET disagree
	 *  about it on the same job (POST said +3h, GET said a timestamp already in
	 *  the past), so treat the URL as short-lived and download immediately
	 *  rather than scheduling against this value. */
	dateExpired: string | null;
	errorCode: string | null;
}

/** VAN's standard error envelope. */
export interface VanErrorEnvelope {
	errors?: Array<{ code?: string | null; text?: string | null }>;
}

/** A page of a paginated VAN collection. */
export interface VanPage<T> {
	items?: T[];
	nextPageLink?: string | null;
	count?: number | null;
}
