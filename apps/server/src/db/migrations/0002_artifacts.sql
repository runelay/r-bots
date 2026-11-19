CREATE TABLE `artifact_versions` (
	`artifact_id` text NOT NULL,
	`n` integer NOT NULL,
	`author` text,
	`size` integer NOT NULL,
	`blob_key` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `n`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_key`) REFERENCES `blobs`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`canvas` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_bot_idx` ON `artifacts` (`bot_id`,`updated_at`);