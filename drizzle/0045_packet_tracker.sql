ALTER TABLE `van_turf_checkouts` ADD `sheet_state` text;--> statement-breakpoint
ALTER TABLE `van_turfs` ADD `sheet_assigned_to` text;--> statement-breakpoint
--- Backfill, hand-added to a generated migration.
---
--- Every checkout with sheet_state NULL is written to the Packet Tracker on the
--- first run. The campaign wants the turf that is really out, or really walked,
--- and not every claim somebody made and handed back — so released checkouts
--- are stamped here as "no row, none owed". That leaves live claims and walked
--- (completed) turf to be written.
---
--- A released claim whose list was loaded in MiniVAN would get an Incomplete
--- row if it happened after switch-on; from before it, it is history the
--- campaign did not ask for.
UPDATE `van_turf_checkouts`
   SET `sheet_state` = '{"spreadsheetId":null,"cells":null}'
 WHERE `released_at` IS NOT NULL;--> statement-breakpoint
--- The tab setting named the app's own "Turf Checkouts" log, which it created.
--- The Packet Tracker is the campaign's tab, so a leftover value would point
--- every write at the old log. NULL means the new default.
UPDATE `app_config` SET `van_sheet_tab_name` = NULL;
