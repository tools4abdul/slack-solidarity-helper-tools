CREATE TABLE `slack_moderators` (
	`slack_user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
