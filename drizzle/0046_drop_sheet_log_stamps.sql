DROP INDEX `van_turf_checkouts_sheet_pending`;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` DROP COLUMN `sheet_claim_sent_at`;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` DROP COLUMN `sheet_end_sent_at`;