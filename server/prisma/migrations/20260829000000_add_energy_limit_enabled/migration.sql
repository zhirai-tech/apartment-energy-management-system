-- AlterTable: 补齐 schema 中 EnergyLimit.enabled（先前缺失的 migration）
ALTER TABLE "EnergyLimit"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "dailyLimit" SET DEFAULT 10;
