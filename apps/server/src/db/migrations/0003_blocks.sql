ALTER TABLE `notes` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `updated_by` text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `seen_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `notified_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `user_changes` text;--> statement-breakpoint
ALTER TABLE `sheet_cells` ADD `input` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sheet_cells` ADD `type` text;--> statement-breakpoint
ALTER TABLE `sheet_cells` ADD `error` text;--> statement-breakpoint
ALTER TABLE `sheet_tabs` ADD `col_widths` text;--> statement-breakpoint
ALTER TABLE `sheet_tabs` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `sheets` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sheets` ADD `updated_by` text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE `sheets` ADD `seen_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sheets` ADD `notified_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sheets` ADD `user_changes` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `bot_id` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `tab_id` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `file_name` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `size` integer;