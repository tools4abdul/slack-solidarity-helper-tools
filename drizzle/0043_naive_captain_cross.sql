CREATE TABLE `van_minivan_exports` (
	`minivan_export_id` integer PRIMARY KEY NOT NULL,
	`name` text,
	`list_number` text,
	`date_created` text,
	`canvassers_json` text DEFAULT '[]' NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `van_minivan_exports_list_number` ON `van_minivan_exports` (`list_number`);--> statement-breakpoint
CREATE INDEX `van_minivan_exports_date_created` ON `van_minivan_exports` (`date_created`);