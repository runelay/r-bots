CREATE VIRTUAL TABLE `messages_fts` USING fts5(`text`, content='conversation_events', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `conversation_events_fts_insert` AFTER INSERT ON `conversation_events` WHEN new.text IS NOT NULL BEGIN
  INSERT INTO `messages_fts`(rowid, `text`) VALUES (new.id, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_events_fts_delete` AFTER DELETE ON `conversation_events` WHEN old.text IS NOT NULL BEGIN
  INSERT INTO `messages_fts`(`messages_fts`, rowid, `text`) VALUES ('delete', old.id, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_events_fts_update` AFTER UPDATE OF `text` ON `conversation_events` BEGIN
  INSERT INTO `messages_fts`(`messages_fts`, rowid, `text`) SELECT 'delete', old.id, old.text WHERE old.text IS NOT NULL;
  INSERT INTO `messages_fts`(rowid, `text`) SELECT new.id, new.text WHERE new.text IS NOT NULL;
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `notes_fts` USING fts5(`note_id` UNINDEXED, `title`, `markdown`, tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `notes_fts_insert` AFTER INSERT ON `notes` WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO `notes_fts`(`note_id`, `title`, `markdown`) VALUES (new.id, new.title, new.markdown);
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_update` AFTER UPDATE OF `title`, `markdown`, `deleted_at` ON `notes` BEGIN
  DELETE FROM `notes_fts` WHERE `note_id` = old.id;
  INSERT INTO `notes_fts`(`note_id`, `title`, `markdown`) SELECT new.id, new.title, new.markdown WHERE new.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_delete` AFTER DELETE ON `notes` BEGIN
  DELETE FROM `notes_fts` WHERE `note_id` = old.id;
END;
