CREATE TABLE "device" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"model" text,
	"os_version" text,
	"app_version" text,
	"machine_id" text,
	"registered_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_api_key_id_idx" ON "device" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "device_user_id_idx" ON "device" USING btree ("user_id");--> statement-breakpoint
DO $$
DECLARE
  row record;
  meta jsonb;
BEGIN
  FOR row IN SELECT a.id, a.reference_id, a.metadata, a.created_at FROM "apikey" a JOIN "user" u ON u.id = a.reference_id WHERE a.name = 'device' AND a.metadata IS NOT NULL LOOP
    BEGIN
      meta := row.metadata::jsonb;
      IF jsonb_typeof(meta) = 'string' THEN
        meta := (meta #>> '{}')::jsonb;
      END IF;
      IF jsonb_typeof(meta) = 'object' AND meta->>'kind' = 'device' AND coalesce(meta->>'deviceId', '') <> '' THEN
        INSERT INTO "device" ("id", "api_key_id", "user_id", "name", "model", "os_version", "app_version", "machine_id", "registered_at", "created_at")
        VALUES (
          meta->>'deviceId',
          row.id,
          row.reference_id,
          left(coalesce(nullif(meta->>'name', ''), 'Mac'), 80),
          left(nullif(meta->>'model', ''), 80),
          left(nullif(meta->>'osVersion', ''), 40),
          left(nullif(meta->>'appVersion', ''), 40),
          left(nullif(meta->>'machineId', ''), 128),
          coalesce((meta->>'registeredAt')::timestamptz, row.created_at),
          row.created_at
        )
        ON CONFLICT DO NOTHING;
      END IF;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE "apikey" SET "expires_at" = now() + interval '180 days' WHERE "expires_at" IS NULL;
