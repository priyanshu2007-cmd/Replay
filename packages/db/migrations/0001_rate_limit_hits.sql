CREATE TABLE IF NOT EXISTS "rate_limit_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_hits_bucket_created_idx" ON "rate_limit_hits" USING btree ("bucket_key","created_at");
