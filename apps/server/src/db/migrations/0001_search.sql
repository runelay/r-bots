CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'rb_search') THEN
    CREATE TEXT SEARCH CONFIGURATION rb_search (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION rb_search
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part, numword, numhword, hword_numpart
      WITH unaccent, simple;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "conversation_events" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('rb_search'::regconfig, regexp_replace(coalesce("text", ''), '[[:punct:]]+', ' ', 'g'))) STORED;
--> statement-breakpoint
CREATE INDEX "conversation_events_search_idx" ON "conversation_events" USING gin ("search") WHERE "text" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('rb_search'::regconfig, regexp_replace("title", '[[:punct:]]+', ' ', 'g')), 'A') || setweight(to_tsvector('rb_search'::regconfig, regexp_replace("markdown", '[[:punct:]]+', ' ', 'g')), 'D')) STORED;
--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "sheets_title_trgm_idx" ON "sheets" USING gin (lower("title") gin_trgm_ops) WHERE "deleted_at" IS NULL;
