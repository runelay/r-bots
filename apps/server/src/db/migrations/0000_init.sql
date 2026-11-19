CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_config_id_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_reference_id_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `device_code` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_device_code_idx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_user_code_idx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'member' NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_code_hash_idx` ON `invite` (`code_hash`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_user_id_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credential_id_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `calendar_cache` (
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text,
	`data` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`calendar_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `calendar_cache_range_idx` ON `calendar_cache` (`starts_at`);--> statement-breakpoint
CREATE TABLE `note_links` (
	`source_id` text NOT NULL,
	`target_title` text NOT NULL,
	`target_id` text,
	PRIMARY KEY(`source_id`, `target_title`),
	FOREIGN KEY (`source_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `note_links_target_idx` ON `note_links` (`target_id`);--> statement-breakpoint
CREATE INDEX `note_links_target_title_idx` ON `note_links` (`target_title`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`bot_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `notes_folder_idx` ON `notes` (`folder`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `notes_title_idx` ON `notes` (`title`);--> statement-breakpoint
CREATE TABLE `sheet_cells` (
	`tab_id` text NOT NULL,
	`row` integer NOT NULL,
	`col` integer NOT NULL,
	`value` text,
	`formula` text,
	`format` text,
	PRIMARY KEY(`tab_id`, `row`, `col`),
	FOREIGN KEY (`tab_id`) REFERENCES `sheet_tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sheet_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`sheet_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`col_count` integer DEFAULT 0 NOT NULL,
	`frozen_rows` integer DEFAULT 0 NOT NULL,
	`frozen_cols` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`sheet_id`) REFERENCES `sheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sheet_tabs_position_idx` ON `sheet_tabs` (`sheet_id`,`position`);--> statement-breakpoint
CREATE TABLE `sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`bot_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `sheets_folder_idx` ON `sheets` (`folder`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `code_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text,
	`repo` text NOT NULL,
	`repo_name` text NOT NULL,
	`branch` text NOT NULL,
	`base` text,
	`base_commit` text,
	`path` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`pr_url` text,
	`extra` text,
	`created_at` text NOT NULL,
	`last_accessed_at` text
);
--> statement-breakpoint
CREATE INDEX `code_workspaces_bot_idx` ON `code_workspaces` (`bot_id`);--> statement-breakpoint
CREATE INDEX `code_workspaces_session_idx` ON `code_workspaces` (`session_id`);--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`types` text DEFAULT '' NOT NULL,
	`role` text,
	`text` text,
	`facts` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `conversations`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_session_seq_idx` ON `conversation_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`session_id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`schedule_id` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`unread` integer DEFAULT 0 NOT NULL,
	`read_at` text,
	`last_message` text,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`meta` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_bot_idx` ON `conversations` (`bot_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `conversations_kind_idx` ON `conversations` (`kind`,`archived_at`);--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`accent` text DEFAULT '' NOT NULL,
	`glyph` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`permission` text,
	`built_in` integer DEFAULT false NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`schedules` text DEFAULT '[]' NOT NULL,
	`engine` text,
	`decisions` text,
	`connectors` text,
	`memory` text,
	`computer` text,
	`voice` text,
	`sidebar` text,
	`extra` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `bots_archived_idx` ON `bots` (`archived_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`group_id`, `bot_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_bot_idx` ON `group_members` (`bot_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`extra` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`extra` text,
	`created_at` text NOT NULL,
	`updated_at` text,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`last_message` text,
	`unread` integer DEFAULT 0 NOT NULL,
	`read_at` text,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_live_owner_idx` ON `threads` (`owner_id`) WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX `threads_owner_idx` ON `threads` (`owner_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`key` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`bot_id` text,
	`session_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blobs_bot_idx` ON `blobs` (`bot_id`);--> statement-breakpoint
CREATE INDEX `blobs_session_idx` ON `blobs` (`session_id`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`format` text NOT NULL,
	`status` text NOT NULL,
	`blob_key` text,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`blob_key`) REFERENCES `blobs`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exports_source_idx` ON `exports` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`blob_key` text NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`duration` real,
	`waveform` text,
	`thumb_key` text,
	`derived` text,
	`transcript` text,
	`transcript_source` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`blob_key`) REFERENCES `blobs`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `uploads_bot_idx` ON `uploads` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `uploads_session_idx` ON `uploads` (`session_id`);--> statement-breakpoint
CREATE TABLE `team_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`bot_id` text NOT NULL,
	`bot_name` text DEFAULT '' NOT NULL,
	`summary` text NOT NULL,
	`extra` text
);
--> statement-breakpoint
CREATE INDEX `team_memory_at_idx` ON `team_memory` (`at`);--> statement-breakpoint
CREATE INDEX `team_memory_bot_idx` ON `team_memory` (`bot_id`,`at`);--> statement-breakpoint
CREATE TABLE `usage_buckets` (
	`hour` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`tier` text NOT NULL,
	`counters` text NOT NULL,
	PRIMARY KEY(`hour`, `provider`, `model`, `tier`)
);
--> statement-breakpoint
CREATE TABLE `usage_cursors` (
	`path` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_seen` (
	`key` text PRIMARY KEY NOT NULL,
	`hour` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_seen_hour_idx` ON `usage_seen` (`hour`);--> statement-breakpoint
CREATE TABLE `usage_sessions` (
	`key` text PRIMARY KEY NOT NULL,
	`hour` integer NOT NULL,
	`model` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_sessions_hour_idx` ON `usage_sessions` (`hour`);--> statement-breakpoint
CREATE TABLE `vault_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`name` text NOT NULL,
	`outcome` text NOT NULL,
	`by` text,
	`extra` text
);
--> statement-breakpoint
CREATE INDEX `vault_audit_name_idx` ON `vault_audit` (`name`,`at`);--> statement-breakpoint
CREATE TABLE `vault_secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`storage` text NOT NULL,
	`touch_id` text NOT NULL,
	`domains` text NOT NULL,
	`bots` text NOT NULL,
	`iv` blob,
	`tag` blob,
	`ciphertext` blob,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`rotated_at` text,
	`last_used_at` text,
	`last_used_by` text,
	`last_tool` text
);
