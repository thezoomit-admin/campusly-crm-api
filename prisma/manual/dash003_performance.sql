CREATE TABLE IF NOT EXISTS "performance_kpis" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "target" DECIMAL(14,2) NOT NULL,
  "unit" TEXT NOT NULL DEFAULT 'percent',
  "higher_is_better" BOOLEAN NOT NULL DEFAULT true,
  "weight" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "performance_kpis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "performance_kpis_key_key" ON "performance_kpis"("key");

CREATE TABLE IF NOT EXISTS "performance_settings" (
  "id" TEXT NOT NULL,
  "overall_score_enabled" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_id" UUID,
  CONSTRAINT "performance_settings_pkey" PRIMARY KEY ("id")
);
