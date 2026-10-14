-- Industry-standard Application / Student pipeline linked from Converted leads.

ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "lead_id" UUID;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "student_id" UUID;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "country_code" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "country_name" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "remarks" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "updated_by_id" UUID;

ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "lead_id" UUID;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "email" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "students_lead_id_key" ON "students"("lead_id");

CREATE INDEX IF NOT EXISTS "applications_lead_id_idx" ON "applications"("lead_id");
CREATE INDEX IF NOT EXISTS "applications_student_id_idx" ON "applications"("student_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_lead_id_fkey'
  ) THEN
    ALTER TABLE "applications"
      ADD CONSTRAINT "applications_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_student_id_fkey'
  ) THEN
    ALTER TABLE "applications"
      ADD CONSTRAINT "applications_student_id_fkey"
      FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'students_lead_id_fkey'
  ) THEN
    ALTER TABLE "students"
      ADD CONSTRAINT "students_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_created_by_id_fkey'
  ) THEN
    ALTER TABLE "applications"
      ADD CONSTRAINT "applications_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_updated_by_id_fkey'
  ) THEN
    ALTER TABLE "applications"
      ADD CONSTRAINT "applications_updated_by_id_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "application_status_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "application_id" UUID NOT NULL,
  "previous_status" TEXT,
  "new_status" TEXT NOT NULL,
  "remarks" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_status_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "application_status_history_application_id_created_at_idx"
  ON "application_status_history"("application_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_status_history_application_id_fkey'
  ) THEN
    ALTER TABLE "application_status_history"
      ADD CONSTRAINT "application_status_history_application_id_fkey"
      FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_status_history_created_by_id_fkey'
  ) THEN
    ALTER TABLE "application_status_history"
      ADD CONSTRAINT "application_status_history_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
