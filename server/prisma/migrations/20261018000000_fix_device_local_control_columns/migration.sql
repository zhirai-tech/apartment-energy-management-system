-- 补齐 Device 表的本地控制字段。
--
-- 背景：`prisma/schema.prisma` 中 Device 已包含 localip / controlProtocol /
-- controlConfig / controlUpdatedAt 四个字段，但之前是通过 `prisma db push`
-- 直接同步到现有数据库的，没有对应迁移记录。导致：
--   1) 全新部署执行 `prisma migrate deploy` 后数据库缺少这 4 列，本地控制/摄像头功能报错；
--   2) 迁移历史与 schema 不一致，`prisma migrate dev` 会要求重置数据库。
--
-- 这里使用 IF NOT EXISTS 做成幂等迁移：
--   - 现有生产库（列已存在）：执行时全部跳过，只记录迁移版本；
--   - 全新数据库：正常补列；
--   - 加新列，不修改/删除任何已有数据。

ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "controlConfig" JSONB;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "controlProtocol" TEXT;
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "controlUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "localip" TEXT;
