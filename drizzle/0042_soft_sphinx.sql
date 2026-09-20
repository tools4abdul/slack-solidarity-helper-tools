CREATE TABLE `van_sheet_health` (
	`spreadsheet_id` text PRIMARY KEY NOT NULL,
	`last_error` text NOT NULL,
	`last_failed_at` text NOT NULL,
	`alerted_error` text
);
--> statement-breakpoint
CREATE TABLE `van_sheet_targets` (
	`prefix_key` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`label` text NOT NULL,
	`spreadsheet_id` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_config` ADD `van_sheet_tab_name` text;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` ADD `sheet_claim_sent_at` text;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` ADD `sheet_end_sent_at` text;--> statement-breakpoint
CREATE INDEX `van_turf_checkouts_sheet_pending` ON `van_turf_checkouts` (`claimed_at`) WHERE "van_turf_checkouts"."sheet_claim_sent_at" IS NULL OR "van_turf_checkouts"."sheet_end_sent_at" IS NULL;--> statement-breakpoint
--- Stamp every checkout that already exists as "already sent".
---
--- Hand-added to a generated migration, deliberately. Without it, switching the
--- sheet log on replays the campaign's entire checkout history into their
--- spreadsheets on the first sync — the one thing an append-only log cannot be
--- asked to undo.
---
--- Live claims are stamped too, not just ended ones: the sheets are meant to
--- contain nothing from before switch-on. The cost is that turf someone is
--- holding right now will never produce a "Checked out" row, so its eventual
--- ending row stands alone. That is accepted — turf checkout had not been
--- enabled when this shipped, so in practice this stamps nothing at all, and it
--- exists so a dev database that HAS been clicked around in behaves the same as
--- production.
---
--- strftime rather than datetime(): the app writes ISO-8601 UTC everywhere and
--- these columns are compared as text against timestamps from toISOString().
UPDATE `van_turf_checkouts`
   SET `sheet_claim_sent_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       `sheet_end_sent_at`   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
