CREATE TABLE "artifact_versions" (
	"artifact_id" text NOT NULL,
	"n" integer NOT NULL,
	"author" text,
	"size" bigint NOT NULL,
	"blob_key" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "artifact_versions_artifact_id_n_pk" PRIMARY KEY("artifact_id","n")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"canvas" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp (3) with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp (3) with time zone,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"used_by" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp (3) with time zone,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_cache" (
	"calendar_id" text NOT NULL,
	"event_id" text NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "calendar_cache_calendar_id_event_id_pk" PRIMARY KEY("calendar_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "note_links" (
	"source_id" text NOT NULL,
	"target_title" text NOT NULL,
	"target_id" text,
	CONSTRAINT "note_links_source_id_target_title_pk" PRIMARY KEY("source_id","target_title")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"bot_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text DEFAULT 'bot' NOT NULL,
	"seen_version" integer DEFAULT 0 NOT NULL,
	"notified_version" integer DEFAULT 0 NOT NULL,
	"user_changes" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "sheet_cells" (
	"tab_id" text NOT NULL,
	"row" integer NOT NULL,
	"col" integer NOT NULL,
	"value" text,
	"formula" text,
	"format" jsonb,
	"input" text DEFAULT '' NOT NULL,
	"type" text,
	"error" text,
	CONSTRAINT "sheet_cells_tab_id_row_col_pk" PRIMARY KEY("tab_id","row","col")
);
--> statement-breakpoint
CREATE TABLE "sheet_tabs" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"name" text NOT NULL,
	"position" bigint NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"col_count" integer DEFAULT 0 NOT NULL,
	"frozen_rows" integer DEFAULT 0 NOT NULL,
	"frozen_cols" integer DEFAULT 0 NOT NULL,
	"col_widths" jsonb,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"bot_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text DEFAULT 'bot' NOT NULL,
	"seen_version" integer DEFAULT 0 NOT NULL,
	"notified_version" integer DEFAULT 0 NOT NULL,
	"user_changes" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "code_repos" (
	"path" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"reason" text,
	"added_by" text,
	"added_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"session_id" text,
	"repo" text NOT NULL,
	"repo_name" text NOT NULL,
	"branch" text NOT NULL,
	"base" text,
	"base_commit" text,
	"path" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"pr_url" text,
	"extra" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_accessed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "conversation_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp (3) with time zone,
	"types" text DEFAULT '' NOT NULL,
	"role" text,
	"text" text,
	"facts" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"session_id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"schedule_id" text,
	"started_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"archived_at" timestamp (3) with time zone,
	"unread" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp (3) with time zone,
	"last_message" jsonb,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"meta" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"accent" text DEFAULT '' NOT NULL,
	"glyph" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"permission" text,
	"built_in" boolean DEFAULT false NOT NULL,
	"capabilities" jsonb DEFAULT '{}' NOT NULL,
	"schedules" jsonb DEFAULT '[]' NOT NULL,
	"engine" jsonb,
	"decisions" jsonb,
	"connectors" jsonb,
	"memory" jsonb,
	"computer" jsonb,
	"voice" jsonb,
	"sidebar" jsonb,
	"extra" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"archived_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "group_members_group_id_bot_id_pk" PRIMARY KEY("group_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"extra" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"archived_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"extra" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone,
	"archived_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"last_message" jsonb,
	"unread" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp (3) with time zone,
	"archived_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"key" text PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"bot_id" text,
	"session_id" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"blob_key" text,
	"error" text,
	"bot_id" text,
	"tab_id" text,
	"file_name" text,
	"size" bigint,
	"created_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"session_id" text,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"blob_key" text NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration" double precision,
	"waveform" jsonb,
	"thumb_key" text,
	"derived" jsonb,
	"transcript" text,
	"transcript_source" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "team_memory" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "team_memory_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp (3) with time zone NOT NULL,
	"bot_id" text NOT NULL,
	"bot_name" text DEFAULT '' NOT NULL,
	"summary" text NOT NULL,
	"extra" jsonb
);
--> statement-breakpoint
CREATE TABLE "usage_buckets" (
	"hour" bigint NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"counters" jsonb NOT NULL,
	CONSTRAINT "usage_buckets_hour_provider_model_tier_pk" PRIMARY KEY("hour","provider","model","tier")
);
--> statement-breakpoint
CREATE TABLE "usage_cursors" (
	"path" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_seen" (
	"key" text PRIMARY KEY NOT NULL,
	"hour" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_sessions" (
	"key" text PRIMARY KEY NOT NULL,
	"hour" bigint NOT NULL,
	"model" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_audit" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "vault_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp (3) with time zone NOT NULL,
	"name" text NOT NULL,
	"outcome" text NOT NULL,
	"by" text,
	"extra" jsonb
);
--> statement-breakpoint
CREATE TABLE "vault_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"storage" text NOT NULL,
	"touch_id" text NOT NULL,
	"domains" jsonb NOT NULL,
	"bots" jsonb NOT NULL,
	"iv" "bytea",
	"tag" "bytea",
	"ciphertext" "bytea",
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"rotated_at" timestamp (3) with time zone,
	"last_used_at" timestamp (3) with time zone,
	"last_used_by" text,
	"last_tool" text
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_blob_key_blobs_key_fk" FOREIGN KEY ("blob_key") REFERENCES "public"."blobs"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_source_id_notes_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_id_notes_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_cells" ADD CONSTRAINT "sheet_cells_tab_id_sheet_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."sheet_tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_tabs" ADD CONSTRAINT "sheet_tabs_sheet_id_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_session_id_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_blob_key_blobs_key_fk" FOREIGN KEY ("blob_key") REFERENCES "public"."blobs"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_blob_key_blobs_key_fk" FOREIGN KEY ("blob_key") REFERENCES "public"."blobs"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_bot_idx" ON "artifacts" USING btree ("bot_id","updated_at");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_config_id_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_device_code_idx" ON "device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_user_code_idx" ON "device_code" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_code_hash_idx" ON "invite" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credential_id_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "calendar_cache_range_idx" ON "calendar_cache" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "note_links_target_idx" ON "note_links" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "note_links_target_title_idx" ON "note_links" USING btree ("target_title");--> statement-breakpoint
CREATE INDEX "notes_folder_idx" ON "notes" USING btree ("folder","deleted_at");--> statement-breakpoint
CREATE INDEX "notes_title_idx" ON "notes" USING btree ("title");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_tabs_position_idx" ON "sheet_tabs" USING btree ("sheet_id","position");--> statement-breakpoint
CREATE INDEX "sheets_folder_idx" ON "sheets" USING btree ("folder","deleted_at");--> statement-breakpoint
CREATE INDEX "code_workspaces_bot_idx" ON "code_workspaces" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "code_workspaces_session_idx" ON "code_workspaces" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_events_session_seq_idx" ON "conversation_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "conversations_bot_idx" ON "conversations" USING btree ("bot_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_kind_idx" ON "conversations" USING btree ("kind","archived_at");--> statement-breakpoint
CREATE INDEX "bots_archived_idx" ON "bots" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "group_members_bot_idx" ON "group_members" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_live_owner_idx" ON "threads" USING btree ("owner_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "threads_owner_idx" ON "threads" USING btree ("owner_id","archived_at");--> statement-breakpoint
CREATE INDEX "blobs_bot_idx" ON "blobs" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "blobs_session_idx" ON "blobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "exports_source_idx" ON "exports" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "uploads_bot_idx" ON "uploads" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "uploads_session_idx" ON "uploads" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "team_memory_at_idx" ON "team_memory" USING btree ("at");--> statement-breakpoint
CREATE INDEX "team_memory_bot_idx" ON "team_memory" USING btree ("bot_id","at");--> statement-breakpoint
CREATE INDEX "usage_seen_hour_idx" ON "usage_seen" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "usage_sessions_hour_idx" ON "usage_sessions" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "vault_audit_name_idx" ON "vault_audit" USING btree ("name","at");