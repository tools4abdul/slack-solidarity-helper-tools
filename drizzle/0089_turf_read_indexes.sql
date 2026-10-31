DROP INDEX `van_turfs_live_campaign`;--> statement-breakpoint
CREATE INDEX `van_turfs_live_folder` ON `van_turfs` (`campaign_id`,`folder_id`,`retired_at`) WHERE "van_turfs"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX `van_turfs_hidden` ON `van_turfs` (`hidden_at`) WHERE "van_turfs"."hidden_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `van_turfs_name_search` ON `van_turfs` (`name`,`campaign_id`,`region_name`);--> statement-breakpoint
-- Planner statistics for the new indexes now, not at the nightly refresh
-- (planner-stats.ts): until they have some, the planner guesses at them and
-- may not use them. About a second for this table.
ANALYZE `van_turfs`;
