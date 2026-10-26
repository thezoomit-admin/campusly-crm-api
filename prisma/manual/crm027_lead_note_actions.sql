-- Lead notes: edit timestamp, pin, and soft delete.
-- Backfill updated_at from created_at so existing history is not marked as edited.

ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);
UPDATE "lead_notes" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "lead_notes" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "lead_notes" ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "pinned_at" TIMESTAMP(3);
ALTER TABLE "lead_notes" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "lead_notes_lead_id_deleted_at_idx"
  ON "lead_notes" ("lead_id", "deleted_at");
