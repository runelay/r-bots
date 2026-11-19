CREATE TABLE `code_repos` (
	`path` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`reason` text,
	`added_by` text,
	`added_at` text NOT NULL
);
