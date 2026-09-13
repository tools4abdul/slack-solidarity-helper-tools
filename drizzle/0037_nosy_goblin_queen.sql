CREATE TABLE `van_region_refreshes` (
	`folder_id` integer NOT NULL,
	`map_region_id` integer NOT NULL,
	`requested_at` text,
	`last_request_at` text,
	`last_request_kind` text,
	`in_flight_since` text,
	`last_error` text,
	`last_error_at` text,
	PRIMARY KEY(`folder_id`, `map_region_id`)
);
--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` ADD `issued_list_number` text;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` ADD `recut_notified_at` text;