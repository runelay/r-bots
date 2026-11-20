ALTER TABLE "usage_buckets" ADD COLUMN "account" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "usage_buckets" SET "account" = 'vps:' || "provider" WHERE "account" = '';--> statement-breakpoint
ALTER TABLE "usage_buckets" DROP CONSTRAINT "usage_buckets_hour_provider_model_tier_pk";--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD CONSTRAINT "usage_buckets_hour_provider_model_tier_account_pk" PRIMARY KEY("hour","provider","model","tier","account");--> statement-breakpoint
ALTER TABLE "usage_sessions" ADD COLUMN "account" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "usage_sessions" SET "account" = 'vps:' || split_part("key", ':', 1) WHERE "account" = '';
