import cron from 'node-cron';
import { OperationType } from '@prisma/client';
import prisma from './prisma';
import { xiaomiAdapter } from '../modules/system/xiaomi.adapter';
import { systemService } from '../modules/system/system.service';
import { writeOperation } from './logger';
import {
  restorePower,
  cutoffPower,
  checkAndTriggerAlarms,
  computeRoomRealtime,
  isRoomOverDailyLimit,
  isRoomOverMonthlyCostLimit,
} from '../modules/energy/energy.service';
import { persistNetworkHistory } from '../modules/dashboard/dashboard.service';
import { broadcastDashboard } from './socket';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  addDays,
  getBusinessDate,
  getBusinessHour,
  getBusinessMinute,
  getDayKey,
} from './business-time';
import { formatRoomDisplayName } from './room-display';

let lastDailyResetDayKey = '';

async function dailyResetTask(): Promise<boolean> {
  const autoRestorePower = await systemService.getSetting('autoRestorePower', true);
  if (!autoRestorePower) {
    await writeOperation(
      null,
      OperationType.restore_power,
      null,
      {
        action: 'auto_restore_task_skipped',
        actionLabel: '自动恢复任务跳过',
        source: 'system_auto',
        sourceLabel: '系统自动',
        resultLabel: '跳过',
        note: '系统设置已关闭自动恢复供电',
      },
      true,
    );
    return true;
  }

  const cutoffRooms = await prisma.room.findMany({
    where: { cutoff: true },
    include: {
      energyLimit: {
        select: { enabled: true, costEnabled: true },
      },
    },
  });

  if (cutoffRooms.length === 0) {
    return true;
  }

  await writeOperation(
    null,
    OperationType.restore_power,
    null,
    {
      action: 'auto_restore_task_started',
      actionLabel: '自动恢复任务开始',
      source: 'system_auto',
      sourceLabel: '系统自动',
      totalCount: cutoffRooms.length,
      note: '开始处理处于断电状态的房间恢复任务',
    },
    true,
  );

  let allSucceeded = true;
  let successCount = 0;
  const failedRooms: string[] = [];
  const skippedRooms: string[] = [];
  for (const room of cutoffRooms) {
    if (!room.energyLimit?.enabled && !room.energyLimit?.costEnabled) {
      skippedRooms.push(formatRoomDisplayName(room.roomNumber, room.name));
      continue;
    }

    try {
      await restorePower(room.id, 'SYSTEM_AUTO', true);
      successCount += 1;
    } catch (error: any) {
      allSucceeded = false;
      failedRooms.push(formatRoomDisplayName(room.roomNumber, room.name));
      console.error(
        `[dailyResetTask] 自动恢复供电失败 roomId=${room.id}:`,
        error?.message || error,
      );
    }
  }

  await writeOperation(
    null,
    OperationType.restore_power,
    null,
    {
      action: allSucceeded ? 'auto_restore_task_completed' : 'auto_restore_task_failed',
      actionLabel: allSucceeded ? '自动恢复任务完成' : '自动恢复任务失败',
      source: 'system_auto',
      sourceLabel: '系统自动',
      resultLabel: allSucceeded ? '完成' : '失败',
      totalCount: cutoffRooms.length,
      successCount,
      failedCount: failedRooms.length,
      skippedCount: skippedRooms.length,
      failedRooms,
      skippedRooms,
      note: allSucceeded
        ? skippedRooms.length > 0
          ? '本轮自动恢复任务执行完成，部分房间因限额断电开关关闭而跳过'
          : '本轮自动恢复任务执行完成'
        : '本轮自动恢复任务存在失败房间，已停止继续频繁重试',
    },
    allSucceeded,
  );

  return allSucceeded;
}

async function refreshReferencePriceTask(): Promise<void> {
  try {
    await systemService.refreshReferenceElectricityPriceIfNeeded();
  } catch (error) {
    console.warn('[cron] refresh reference price failed:', error);
  }
}

async function accumulateRoomEnergy(roomId: string, businessTimeZone: string): Promise<void> {
  try {
    const devices = await prisma.device.findMany({
      where: { roomId, status: 'online' },
    });

    let totalPowerW = 0;
    for (const device of devices) {
      totalPowerW += device.powerW ?? 0;
    }

    const estimatedKwh = (totalPowerW * (1 / 60)) / 1000;

    const now = new Date();
    const today = getBusinessDate(now, businessTimeZone);
    const currentHour = getBusinessHour(now, businessTimeZone);

    const pricePerKwh = await systemService.getSetting('pricePerKwh', 0.6);

    await prisma.dailyEnergy.upsert({
      where: {
        roomId_date: { roomId, date: today },
      },
      update: {
        usageKwh: { increment: estimatedKwh },
        cost: { increment: estimatedKwh * pricePerKwh },
        peakW: {
          set: Math.max(totalPowerW, 0),
        },
      },
      create: {
        roomId,
        date: today,
        usageKwh: estimatedKwh,
        cost: estimatedKwh * pricePerKwh,
        peakW: totalPowerW,
      },
    });

    await prisma.hourlyEnergy.upsert({
      where: {
        roomId_date_hour: { roomId, date: today, hour: currentHour },
      },
      update: {
        usageKwh: { increment: estimatedKwh },
        peakW: {
          set: Math.max(totalPowerW, 0),
        },
      },
      create: {
        roomId,
        date: today,
        hour: currentHour,
        usageKwh: estimatedKwh,
        peakW: totalPowerW,
      },
    });

    if (today.getDate() === 1 && currentHour === 0) {
      await aggregateMonthly(roomId, today);
    }
  } catch {
  }
}

async function aggregateMonthly(roomId: string, businessToday: Date): Promise<void> {
  try {
    const lastMonth = new Date(businessToday.getFullYear(), businessToday.getMonth() - 1, 1);
    const year = lastMonth.getFullYear();
    const month = lastMonth.getMonth() + 1;

    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);

    const dailyRecords = await prisma.dailyEnergy.findMany({
      where: {
        roomId,
        date: { gte: firstDay, lte: lastDay },
      },
    });

    const totalKwh = dailyRecords.reduce((sum, r) => sum + r.usageKwh, 0);
    const totalCost = dailyRecords.reduce((sum, r) => sum + r.cost, 0);

    if (totalKwh > 0 || totalCost > 0) {
      await prisma.monthlyEnergy.upsert({
        where: {
          roomId_year_month: { roomId, year, month },
        },
        update: {
          usageKwh: totalKwh,
          cost: totalCost,
        },
        create: {
          roomId,
          year,
          month,
          usageKwh: totalKwh,
          cost: totalCost,
        },
      });
    }
  } catch {
  }
}

async function syncDataTask(): Promise<void> {
  try {
    await xiaomiAdapter.refreshAllRoomsRealtime();
    await systemService.refreshLanCameraStatuses().catch(() => {});
    await systemService.refreshDashboardNetworkRuntimes().catch(() => {});
    const businessTimeZone = await systemService.getSetting(
      'businessTimezone',
      DEFAULT_BUSINESS_TIMEZONE,
    );
    await persistNetworkHistory(businessTimeZone).catch(() => {});
    await refreshReferencePriceTask();

    const rooms = await prisma.room.findMany({
      include: { energyLimit: true, devices: true },
    });

    const autoCutoff = await systemService.getSetting('autoCutoff', true);

    for (const room of rooms) {
      try {
        await accumulateRoomEnergy(room.id, businessTimeZone);

        await checkAndTriggerAlarms(room.id);

        if (room.cutoff) {
          // Do not keep issuing repeated auto-cutoff commands for rooms that are already
          // marked as cutoff. Re-sending off commands every few minutes can hammer the
          // upstream breaker and makes it much harder to reason about midnight recovery.
          continue;
        }

        if (autoCutoff) {
          const realtime = await computeRoomRealtime(room);
          if (
            (realtime.limitEnabled || realtime.costLimitEnabled) &&
            (
              isRoomOverDailyLimit(realtime.todayUsage, realtime.dailyLimit) ||
              isRoomOverMonthlyCostLimit(realtime.monthCost, realtime.monthlyCostLimit)
            )
          ) {
            try {
              await cutoffPower(room.id, undefined as any, true);
            } catch {
            }
          }
        }
      } catch {
      }
    }

    await broadcastDashboard();
  } catch {
  }
}

export async function startCronJobs(): Promise<void> {
  const minute = 5;

  try {
    cron.schedule('* * * * *', () => {
      (async () => {
        const businessTimeZone = await systemService.getSetting(
          'businessTimezone',
          DEFAULT_BUSINESS_TIMEZONE,
        );
        const dailyResetHour = Number(await systemService.getSetting('dailyResetHour', 0)) || 0;
        const now = new Date();
        const dayKey = getDayKey(now, businessTimeZone);
        const currentHour = getBusinessHour(now, businessTimeZone);
        const currentMinute = getBusinessMinute(now, businessTimeZone);

        if (
          currentHour === dailyResetHour &&
          currentMinute >= minute &&
          lastDailyResetDayKey !== dayKey
        ) {
          const resetOk = await dailyResetTask().catch((error) => {
            console.error('[cron] 执行自动恢复供电失败：', error?.message || error);
            return false;
          });
          // Even if restore fails, do not keep retrying every minute in the same hour.
          lastDailyResetDayKey = dayKey;
          if (!resetOk) {
            console.error('[cron] 自动恢复任务存在失败，本日不再重复高频重试。');
          }
        }

        await syncDataTask().catch(() => {});
      })().catch(() => {});
    });
  } catch {
  }

  // Start one real sync immediately so the detail page does not wait for the next minute tick.
  await syncDataTask().catch(() => {});
}
