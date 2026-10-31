// Statements allowed to read a whole large table, by the app code that sends
// them (`path#function`, as the audit reports it) and the table. Each needs a
// reason: what the scan is for, and why nothing waits on it.

export interface Allowed {
	source: string;
	table: string;
	reason: string;
}

export const ALLOWED: readonly Allowed[] = [
	{
		source: 'src/lib/server/van/activity-store.ts#hasAnyTurf',
		table: 'van_turfs',
		reason: 'LIMIT 1 with no filter: the scan stops at the first row.',
	},
	{
		source: 'src/lib/server/van/campaign-status-store.ts#loadCampaignSummaries',
		table: 'van_turfs',
		reason: 'Live turf counted per campaign for /settings: every live turf, from an index.',
	},
	{
		source: 'src/lib/server/van/contact-sync.ts#clearUncontacted',
		table: 'van_turfs',
		reason: 'Runs only when contact counting is switched off, to clear every count once.',
	},
	{
		source: 'src/lib/server/van/geometry-progress-store.ts#loadGeometryProgress',
		table: 'van_turfs',
		reason: 'Map-shape progress on the organizer page: counts over every live turf.',
	},
	{
		source: 'src/lib/server/van/geometry-progress-store.ts#loadGeometryProgress',
		table: 'van_geometry_queue',
		reason: 'Map-shape progress on the organizer page: the queue counted by status, from an index.',
	},
	{
		source: 'src/lib/server/van/list-expiry-alert-store.ts#sendListExpiryAlerts',
		table: 'van_turfs',
		reason: 'Part of van-sync: every live printed list is checked for its expiry warning.',
	},
	{
		source: 'src/lib/server/van/turf-history-store.ts#loadTurfHistory',
		table: 'van_turfs',
		reason:
			"LIKE '%…%' on name or region can use no index to find matches; it scans " +
			'van_turfs_name_search, which holds only what it reads, in the order it returns.',
	},
	{
		source: 'src/lib/server/van/turf-placement.ts#loadVoters',
		table: 'van_turfs',
		reason: "Placing requested turf whose zip did not resolve: every live turf's centre votes.",
	},
];
