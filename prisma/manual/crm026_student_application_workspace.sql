-- Student + Application workspace: per-application notes & documents.
-- Shared student documents remain on lead/file; university-specific live here.

DO $$ BEGIN
  CREATE TYPE "application_document_status" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "application_document_source" AS ENUM ('UPLOAD', 'SHARED_LEAD_DOCUMENT', 'SHARED_FILE_DOCUMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "application_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "application_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "application_notes_application_id_created_at_idx"
  ON "application_notes"("application_id", "created_at");
CREATE INDEX IF NOT EXISTS "application_notes_created_by_id_idx"
  ON "application_notes"("created_by_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_notes_application_id_fkey'
  ) THEN
    ALTER TABLE "application_notes"
      ADD CONSTRAINT "application_notes_application_id_fkey"
      FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_notes_created_by_id_fkey'
  ) THEN
    ALTER TABLE "application_notes"
      ADD CONSTRAINT "application_notes_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "application_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "application_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category_code" TEXT NOT NULL DEFAULT 'APPLICATION',
  "type_code" TEXT NOT NULL DEFAULT 'OTHER',
  "status" "application_document_status" NOT NULL DEFAULT 'PENDING',
  "source" "application_document_source" NOT NULL DEFAULT 'UPLOAD',
  "source_document_id" UUID,
  "file_name" TEXT,
  "mime_type" TEXT,
  "storage_key" TEXT,
  "file_size" INTEGER,
  "remarks" TEXT,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "application_documents_code_key" ON "application_documents"("code");
CREATE INDEX IF NOT EXISTS "application_documents_application_id_created_at_idx"
  ON "application_documents"("application_id", "created_at");
CREATE INDEX IF NOT EXISTS "application_documents_application_id_status_idx"
  ON "application_documents"("application_id", "status");
CREATE INDEX IF NOT EXISTS "application_documents_source_document_id_idx"
  ON "application_documents"("source_document_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_documents_application_id_fkey'
  ) THEN
    ALTER TABLE "application_documents"
      ADD CONSTRAINT "application_documents_application_id_fkey"
      FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_documents_created_by_id_fkey'
  ) THEN
    ALTER TABLE "application_documents"
      ADD CONSTRAINT "application_documents_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_documents_updated_by_id_fkey'
  ) THEN
    ALTER TABLE "application_documents"
      ADD CONSTRAINT "application_documents_updated_by_id_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
