ALTER TABLE "push_outbox" ADD COLUMN "tickets" jsonb;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD COLUMN "last_error" text;