CREATE TABLE `turf_custom_chapters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turf_custom_chapters_name_unique` ON `turf_custom_chapters` (`name`);