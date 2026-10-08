-- A van_chapter_folders row for a turf-only chapter (negative chapter_id) must
-- name a turf_custom_chapters row that still exists. Checked in the database
-- rather than only in the route, so an entry deleted between the route's check
-- and the write cannot have its mapping written back: the insert aborts, and
-- the batch it is part of rolls back with it.
CREATE TRIGGER `van_chapter_folders_custom_chapter_insert`
BEFORE INSERT ON `van_chapter_folders`
WHEN NEW.`chapter_id` < 0
	AND NOT EXISTS (SELECT 1 FROM `turf_custom_chapters` WHERE `id` = -NEW.`chapter_id`)
BEGIN
	SELECT RAISE(ABORT, 'turf_custom_chapter_deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `van_chapter_folders_custom_chapter_update`
BEFORE UPDATE OF `chapter_id` ON `van_chapter_folders`
WHEN NEW.`chapter_id` < 0
	AND NOT EXISTS (SELECT 1 FROM `turf_custom_chapters` WHERE `id` = -NEW.`chapter_id`)
BEGIN
	SELECT RAISE(ABORT, 'turf_custom_chapter_deleted');
END;
