CREATE TABLE `zip_excluded_chapters` (
	`chapter_id` integer PRIMARY KEY NOT NULL,
	`reason` text,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
