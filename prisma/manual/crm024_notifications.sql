ALTER TABLE "follow_ups" ADD COLUMN IF NOT EXISTS "due_notified_at" TIMESTAMP(3);
ALTER TABLE "follow_ups" ADD COLUMN IF NOT EXISTS "overdue_notified_at" TIMESTAMP(3);

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "event_type" TEXT;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'system';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'Normal';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "delivery_status" TEXT NOT NULL DEFAULT 'Sent';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "payload" JSONB;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "actions" JSONB;

CREATE INDEX IF NOT EXISTS "notifications_user_id_event_type_idx" ON "notifications"("user_id", "event_type");
CREATE INDEX IF NOT EXISTS "notifications_lead_id_idx" ON "notifications"("lead_id");
CREATE INDEX IF NOT EXISTS "notifications_priority_idx" ON "notifications"("priority");

CREATE TABLE IF NOT EXISTS "notification_event_configs" (
  "event_type" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "mandatory" BOOLEAN NOT NULL DEFAULT false,
  "priority" TEXT NOT NULL DEFAULT 'Normal',
  "in_app" BOOLEAN NOT NULL DEFAULT true,
  "email" BOOLEAN NOT NULL DEFAULT false,
  "whatsapp" BOOLEAN NOT NULL DEFAULT false,
  "browser" BOOLEAN NOT NULL DEFAULT false,
  "recipient_rule" TEXT NOT NULL DEFAULT 'owner',
  "notify_previous_owner" BOOLEAN NOT NULL DEFAULT false,
  "overdue_after_minutes" INTEGER NOT NULL DEFAULT 60,
  "status_allowlist" JSONB,
  "updated_by_id" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_event_configs_pkey" PRIMARY KEY ("event_type")
);

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "in_app" BOOLEAN NOT NULL DEFAULT true,
  "email" BOOLEAN NOT NULL DEFAULT false,
  "whatsapp" BOOLEAN NOT NULL DEFAULT false,
  "browser" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_user_id_event_type_key" ON "notification_preferences"("user_id", "event_type");
CREATE INDEX IF NOT EXISTS "notification_preferences_user_id_idx" ON "notification_preferences"("user_id");

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "notification_id" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");
CREATE INDEX IF NOT EXISTS "notification_deliveries_status_idx" ON "notification_deliveries"("status");

DO $$ BEGIN
  ALTER TABLE "notification_event_configs"
    ADD CONSTRAINT "notification_event_configs_updated_by_id_fkey"
    FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
