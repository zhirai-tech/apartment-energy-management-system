import prisma from '../../lib/prisma';
import { xiaomiAdapter } from '../system/xiaomi.adapter';
import { writeOperation } from '../../lib/logger';
import { AppError } from '../../lib/errors';
import { systemService } from '../system/system.service';
import { broadcastAlarm, broadcastDashboard, broadcastRoom } from '../../lib/socket';
import {
  RoomStatus,
  AlarmType,
  AlarmLevel,
  OperationType,
  DeviceStatus as PrismaDeviceStatus,
} from '@prisma/client';
import * as shared_types from '@shared/index';
import {
  RealtimeEnergyData,
  RoomEnergyDetail,
  HourlyDataPoint,
  DailyDataPoint,
  MonthlyDataPoint,
  RankingItem,
  DeviceItem,
  DeviceStatus,
  SystemSettingsData,
  inferDeviceCategory,
} from '@shared/index';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  addDays,
  getBusinessDate,
  getDateKey,
} from '../../lib/business-time';
import { OperationActorContext } from '../../lib/operation-log';
import { formatRoomDisplayName, normalizeRoomAnnotation } from '../../lib/room-display';
import { extractCameraRuntime, extractFiveGCpeRuntime, extractWifiApRuntime } from '../../lib/device-runtime';

const ROOM_POWER_ACTION_WINDOW_MS = 3 * 60 * 1000;
const AUTO_RESTORE_CONFIRMATION_OPTIONS = {
  initialDelayMs: 15000,
  retryDelayMs: 5000,
  maxAttempts: 4,
};
const LIMIT_EXCEEDED_EPSILON_KWH = 0.001;
const LIMIT_EXCEEDED_EPSILON_COST = 0.01;

const PRISMA_TO_SHARED_DEVICE_STATUS_ENERGY: Record<PrismaDeviceStatus, DeviceStatus> =
  {
    online: DeviceStatus.ONLINE,
    offline: DeviceStatus.OFFLINE,
    unknown: DeviceStatus.UNKNOWN,
  };

function tryParseJsonModel(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const obj = JSON.parse(value);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickModelText(modelValue: unknown): string {
  if (typeof modelValue !== 'string') return String(modelValue ?? '');
  const obj = tryParseJsonModel(modelValue);
  if (!obj) {
    const s = modelValue;
    const mac = (s.match(/"macAddress"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const vendor = (s.match(/"vendorName"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const ip = (s.match(/"ipAddress"\s*:\s*"([^"]+)"/) || [])[1] || '';
    if (vendor) return vendor;
    if (mac || ip) return [mac, ip].filter(Boolean).join(' / ') || s.slice(0, 60);
    if (s.startsWith('{') && s.length > 120) return s.slice(0, 60) + '…';
    return s;
  }
  const cam = (obj.camera && typeof obj.camera === 'object') ? (obj.camera as Record<string, unknown>) : null;
  const camModel = cam && (typeof cam.manualModel === 'string' || typeof cam.model === 'string')
    ? String((cam as any).manualModel || (cam as any).model || '').trim()
    : '';
  const camBrand = cam && (typeof cam.manualBrand === 'string' || typeof cam.brand === 'string')
    ? String((cam as any).manualBrand || (cam as any).brand || '').trim()
    : '';
  const cpe = (obj.fiveGCpe && typeof obj.fiveGCpe === 'object') ? (obj.fiveGCpe as Record<string, unknown>) : null;
  const cpeModel = cpe && typeof cpe.model === 'string' ? String(cpe.model).trim() : '';
  const wifi = (obj.wifiAp && typeof obj.wifiAp === 'object') ? (obj.wifiAp as Record<string, unknown>) : null;
  const wifiModel = wifi && typeof wifi.model === 'string' ? String(wifi.model).trim() : '';
  const raw = (typeof (obj as any)._raw === 'string' && (obj as any)._raw) ? String((obj as any)._raw) : '';
  const brand = (typeof obj.brand === 'string' && obj.brand) ? String(obj.brand) : '';
  const vendor = (typeof obj.vendorName === 'string' && obj.vendorName) ? String(obj.vendorName) : '';
  return camModel || cpeModel || wifiModel || brand || camBrand || vendor || raw || modelValue;
}

function normalizeVendorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^(?:\*?\s*no company\s*\*?|unknown|n\/a|null|undefined|--?)$/i.test(text)) return null;
  return text;
}

const XIAOMI_STALE_OFFLINE_THRESHOLD_MS = 20 * 60 * 1000;

function toDeviceItem(d: any): DeviceItem {
  const prismaStatus = (d.status ?? 'unknown') as PrismaDeviceStatus;
  const sharedStatus =
    PRISMA_TO_SHARED_DEVICE_STATUS_ENERGY[prismaStatus] ?? DeviceStatus.UNKNOWN;
  const parsedModel = tryParseJsonModel(d.model);
  const macAddress = (parsedModel && typeof parsedModel.macAddress === 'string') ? parsedModel.macAddress : null;
  const rawMac = String(macAddress ?? '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
  const ipAddress = (parsedModel && typeof parsedModel.ipAddress === 'string') ? parsedModel.ipAddress : null;
  const vendorName =
    normalizeVendorName(parsedModel && typeof parsedModel.vendorName === 'string' ? parsedModel.vendorName : null) ??
    normalizeVendorName(parsedModel && typeof parsedModel.brand === 'string' ? parsedModel.brand : null);
  const adapterConfig =
    parsedModel && parsedModel.adapterConfig && typeof parsedModel.adapterConfig === 'object'
      ? (parsedModel.adapterConfig as Record<string, unknown>)
      : null;
  const modelText = pickModelText(d.model);
  const category = inferDeviceCategory({
    name: d.name,
    model: modelText,
    vendor: vendorName,
    mac: rawMac.length === 12 ? rawMac : null,
    ip: ipAddress,
  });
  const adapterHaystack = `${d.name ?? ''} ${vendorName ?? ''} ${modelText ?? ''}`.toLowerCase();
  const adapterKind =
    adapterConfig && (adapterConfig.kind === 'huawei_cpe' || adapterConfig.kind === 'nokia_beacon')
      ? (adapterConfig.kind as 'huawei_cpe' | 'nokia_beacon')
      : category === shared_types.DeviceCategory.FIVE_G_CPE
        ? 'huawei_cpe'
        : category === shared_types.DeviceCategory.WIFI_AP && /(nokia|beacon|ha-020)/i.test(adapterHaystack)
          ? 'nokia_beacon'
          : category === shared_types.DeviceCategory.WIFI_AP && !!ipAddress && /\.1$/.test(ipAddress) && !/(nokia|beacon|ha-020)/i.test(adapterHaystack)
            ? 'huawei_cpe'
            : null;
  const normalizedVendorName =
    vendorName ?? (adapterKind === 'huawei_cpe' ? 'Huawei' : adapterKind === 'nokia_beacon' ? 'Nokia' : null);
  const ownership = (
    parsedModel && typeof parsedModel.ownership === 'string' ? parsedModel.ownership : null
  ) as DeviceItem['ownership'];
  const source = (
    parsedModel && typeof parsedModel.source === 'string' ? parsedModel.source : null
  ) as DeviceItem['source'];
  let cameraRuntime: DeviceItem['camera'] = extractCameraRuntime(parsedModel, prismaStatus);
  let wifiApRuntime: DeviceItem['wifiAp'] = extractWifiApRuntime(parsedModel);
  let fiveGCpeRuntime: DeviceItem['fiveGCpe'] = extractFiveGCpeRuntime(parsedModel);
  return {
    id: d.id,
    did: d.did,
    siteId: d.siteId,
    siteName: d.site?.name ?? '默认区域',
    name: d.name,
    model: modelText,
    category,
    status: sharedStatus,
    roomId: d.roomId ?? null,
    roomNumber: d.room?.roomNumber ?? null,
    power: d.power ?? null,
    powerW: d.powerW ?? null,
    currentA: d.currentA ?? null,
    voltageV: d.voltageV ?? null,
    totalKwh: d.totalKwh ?? null,
    lastSyncAt: d.lastSyncAt ? new Date(d.lastSyncAt).toISOString() : null,
    ownership: d.did?.startsWith?.('LAN_') ? 'other' : ownership ?? null,
    source: d.did?.startsWith?.('LAN_') ? 'lan_discovery' : source ?? null,
    macAddress,
    ipAddress,
    vendorName: normalizedVendorName,
    adapterKind,
    camera: cameraRuntime,
    wifiAp: wifiApRuntime,
    fiveGCpe: fiveGCpeRuntime,
  };
}

async function assertRoomPowerActionAllowed(
  roomId: string,
  actionType: 'cutoff_power' | 'restore_power',
  operatorUserId: string | null | undefined,
  auto: boolean,
  actorContext?: OperationActorContext,
) {
  const since = new Date(Date.now() - ROOM_POWER_ACTION_WINDOW_MS);
  const latestAction = await prisma.operationLog.findFirst({
    where: {
      roomId,
      type: {
        in: [OperationType.cutoff_power, OperationType.restore_power],
      },
      createdAt: {
        gte: since,
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      type: true,
      createdAt: true,
    },
  });

  if (latestAction) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (latestAction.createdAt.getTime() + ROOM_POWER_ACTION_WINDOW_MS - Date.now()) / 1000,
      ),
    );
    const previousActionLabel =
      latestAction.type === OperationType.cutoff_power ? '断电' : '恢复供电';
    const currentActionLabel = actionType === OperationType.cutoff_power ? '断电' : '恢复供电';
    const message = `同一房间执行${previousActionLabel}后需要冷却 3 分钟，当前不能再${currentActionLabel}，请 ${retryAfterSeconds} 秒后再试`;

    await writeOperation(
      operatorUserId ?? null,
      actionType,
      roomId,
      {
        action: auto ? `auto_${actionType}` : actionType,
        actionLabel: actionType === OperationType.cutoff_power ? '断电被拦截' : '恢复供电被拦截',
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
        blocked: true,
          reason: 'room_power_action_cooldown_active',
          retryAfterSeconds,
          note: `上一次${previousActionLabel}后仍处于冷却时间内`,
      },
      false,
    );

    throw new AppError(429, 'ROOM_POWER_ACTION_COOLDOWN', message, {
      retryAfterSeconds,
    });
  }
}

async function getRoomPowerActionCooldown(roomId: string): Promise<{
  powerActionCooldownUntil: string | null;
  powerActionRetryAfterSeconds: number;
  powerActionLastType: 'cutoff_power' | 'restore_power' | null;
}> {
  const since = new Date(Date.now() - ROOM_POWER_ACTION_WINDOW_MS);
  const latestAction = await prisma.operationLog.findFirst({
    where: {
      roomId,
      type: {
        in: [OperationType.cutoff_power, OperationType.restore_power],
      },
      createdAt: {
        gte: since,
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      type: true,
      createdAt: true,
    },
  });

  if (!latestAction) {
    return {
      powerActionCooldownUntil: null,
      powerActionRetryAfterSeconds: 0,
      powerActionLastType: null,
    };
  }

  const expiresAt = new Date(latestAction.createdAt.getTime() + ROOM_POWER_ACTION_WINDOW_MS);
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
  );

  if (retryAfterSeconds <= 0) {
    return {
      powerActionCooldownUntil: null,
      powerActionRetryAfterSeconds: 0,
      powerActionLastType: null,
    };
  }

  return {
    powerActionCooldownUntil: expiresAt.toISOString(),
    powerActionRetryAfterSeconds: retryAfterSeconds,
    powerActionLastType:
      latestAction.type === OperationType.cutoff_power
        ? 'cutoff_power'
        : 'restore_power',
  };
}

export function isRoomOverDailyLimit(
  todayUsage: number,
  dailyLimit: number | null | undefined,
): boolean {
  if (dailyLimit == null || dailyLimit <= 0) {
    return false;
  }

  return todayUsage > dailyLimit + LIMIT_EXCEEDED_EPSILON_KWH;
}

export function isRoomOverMonthlyCostLimit(
  monthCost: number,
  monthlyCostLimit: number | null | undefined,
): boolean {
  if (monthlyCostLimit == null || monthlyCostLimit <= 0) {
    return false;
  }

  return monthCost > monthlyCostLimit + LIMIT_EXCEEDED_EPSILON_COST;
}

type AutoCutoffReason =
  | {
      type: 'daily';
      note: string;
      alarmMessage: string;
    }
  | {
      type: 'cost';
      note: string;
      alarmMessage: string;
    };

function resolveAutoCutoffReason(realtime: Pick<
  RealtimeEnergyData,
  'todayUsage' | 'dailyLimit' | 'limitEnabled' | 'monthCost' | 'monthlyCostLimit' | 'costLimitEnabled'
>): AutoCutoffReason | null {
  if (realtime.limitEnabled && isRoomOverDailyLimit(realtime.todayUsage, realtime.dailyLimit)) {
    return {
      type: 'daily',
      note: `今日用电 ${realtime.todayUsage.toFixed(3)} kWh，已超出日限额 ${realtime.dailyLimit.toFixed(3)} kWh，执行自动断电`,
      alarmMessage: '已超出日限额，系统已自动断电',
    };
  }

  if (realtime.costLimitEnabled && isRoomOverMonthlyCostLimit(realtime.monthCost, realtime.monthlyCostLimit)) {
    return {
      type: 'cost',
      note: `本月费用 ${realtime.monthCost.toFixed(2)} EUR，已超出费用限额 ${realtime.monthlyCostLimit.toFixed(2)} EUR，执行自动断电`,
      alarmMessage: '已超出本月费用限额，系统已自动断电',
    };
  }

  return null;
}

type DailyLimitSettings = Pick<
  SystemSettingsData,
  | 'businessTimezone'
  | 'defaultDailyLimitKwh'
  | 'defaultDailyLimitUseWeeklyRules'
  | 'defaultDailyLimitWeekdayKwh'
  | 'defaultDailyLimitSaturdayKwh'
  | 'defaultDailyLimitSundayKwh'
  | 'defaultDailyLimitUseHolidayRules'
  | 'defaultDailyLimitHolidayKwh'
  | 'defaultDailyLimitHolidayDates'
>;

function parseHolidayDateSet(raw: string | null | undefined): Set<string> {
  return new Set(
    String(raw ?? '')
      .split(/[\s,;\n\r]+/)
      .map((item) => item.trim())
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)),
  );
}

function resolveSystemDailyLimit(settings: DailyLimitSettings, now = new Date()): number {
  const businessToday = getBusinessDate(now, settings.businessTimezone || DEFAULT_BUSINESS_TIMEZONE);
  const dayKey = getDateKey(businessToday);
  const holidayDates = parseHolidayDateSet(settings.defaultDailyLimitHolidayDates);

  if (!settings.defaultDailyLimitUseWeeklyRules) {
    return Number(settings.defaultDailyLimitKwh ?? 10);
  }

  if (holidayDates.has(dayKey)) {
    return Number(settings.defaultDailyLimitHolidayKwh ?? settings.defaultDailyLimitKwh ?? 10);
  }

  const weekday = businessToday.getDay();
  if (weekday === 0) {
    return Number(settings.defaultDailyLimitSundayKwh ?? settings.defaultDailyLimitKwh ?? 10);
  }
  if (weekday === 6) {
    return Number(settings.defaultDailyLimitSaturdayKwh ?? settings.defaultDailyLimitKwh ?? 10);
  }
  return Number(settings.defaultDailyLimitWeekdayKwh ?? settings.defaultDailyLimitKwh ?? 10);
}

function getRoomAnnotation(room: {
  roomNumber: string;
  name?: string | null;
}): string | null {
  return normalizeRoomAnnotation(room.roomNumber, room.name);
}

function getRoomDisplayName(room: {
  roomNumber: string;
  name?: string | null;
}): string {
  return formatRoomDisplayName(room.roomNumber, room.name);
}

async function syncRoomOfflineLifecycle(
  room: {
    id: string;
    roomNumber: string;
    name?: string | null;
    cutoff: boolean;
    devices?: Array<{
      name?: string | null;
      status: any;
    }>;
  },
  realtime: RealtimeEnergyData,
): Promise<void> {
  if (!room.devices || room.devices.length === 0 || room.cutoff) {
    return;
  }

  const unresolvedOfflineAlarms = await prisma.alarmLog.findMany({
    where: {
      roomId: room.id,
      type: AlarmType.device_offline,
      resolved: false,
    },
    orderBy: { createdAt: 'asc' },
  });

  const offlineDeviceCount = room.devices.filter((device) => device.status !== 'online').length;
  const roomLabel = getRoomDisplayName(room);
  const now = new Date();

  if (!realtime.deviceOnline) {
    if (unresolvedOfflineAlarms.length > 0) {
      return;
    }

    const createdAlarm = await prisma.alarmLog.create({
      data: {
        type: AlarmType.device_offline,
        level: AlarmLevel.danger,
        roomId: room.id,
        message: `${roomLabel}出现网络或供电异常`,
        resolved: false,
      },
    });
    broadcastAlarm(createdAlarm);

    await writeOperation(
      null,
      OperationType.update_alarm,
      room.id,
      {
        action: 'room_offline_detected',
        actionLabel: '记录离线异常',
        source: 'system_auto',
        sourceLabel: '系统自动',
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomLabel,
        startedAt: now.toISOString(),
        note: `检测到${roomLabel}出现网络或供电异常，当前离线设备 ${offlineDeviceCount} 台`,
        resultLabel: '记录',
      },
      true,
    );
    return;
  }

  if (unresolvedOfflineAlarms.length === 0) {
    return;
  }

  await prisma.alarmLog.updateMany({
    where: {
      roomId: room.id,
      type: AlarmType.device_offline,
      resolved: false,
    },
    data: {
      resolved: true,
      resolvedAt: now,
    },
  });

  const startedAt = unresolvedOfflineAlarms[0]?.createdAt ?? now;
  const durationMinutes = Math.max(
    1,
    Math.round((now.getTime() - startedAt.getTime()) / 60000),
  );

  await writeOperation(
    null,
    OperationType.update_alarm,
    room.id,
    {
      action: 'room_offline_recovered',
      actionLabel: '记录离线恢复',
      source: 'system_auto',
      sourceLabel: '系统自动',
      roomNumber: room.roomNumber,
      roomName: room.name,
      displayName: roomLabel,
      startedAt: startedAt.toISOString(),
      recoveredAt: now.toISOString(),
      durationMinutes,
      note: `${roomLabel}网络或供电异常已恢复`,
      resultLabel: '恢复',
    },
    true,
  );
}

export async function computeRoomRealtime(room: {
  id: string;
  siteId: string;
  site?: { name: string } | null;
  roomNumber: string;
  name?: string | null;
  floor?: number | null;
  cutoff: boolean;
  status?: any;
  energyLimit?: {
    dailyLimit: number;
    enabled?: boolean;
    monthlyCostLimit?: number;
    costEnabled?: boolean;
  } | null;
  devices?: Array<{
    name?: string | null;
      siteId?: string;
      site?: { name: string } | null;
    status: any;
    powerW?: number | null;
    currentA?: number | null;
    voltageV?: number | null;
  }>;
}, businessTimeZone?: string, defaultDailyLimit = 10, forceDefaultDailyLimit = false, defaultMonthlyCostLimit?: number): Promise<RealtimeEnergyData> {
  const [timeZone, resolvedDefaultMonthlyCostLimit] = await Promise.all([
    businessTimeZone
      ? Promise.resolve(businessTimeZone)
      : systemService.getSetting('businessTimezone', DEFAULT_BUSINESS_TIMEZONE),
    defaultMonthlyCostLimit != null
      ? Promise.resolve(defaultMonthlyCostLimit)
      : systemService.getSetting('defaultMonthlyCostLimitEur', 200),
  ]);
  const today = getBusinessDate(new Date(), timeZone);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const yearStart = new Date(today.getFullYear(), 0, 1);

  const [todayRecord, yesterdayRecord, monthAgg, yearAgg, powerActionCooldown] = await Promise.all([
    prisma.dailyEnergy.findUnique({ where: { roomId_date: { roomId: room.id, date: today } } }),
    prisma.dailyEnergy.findUnique({ where: { roomId_date: { roomId: room.id, date: yesterday } } }),
    prisma.dailyEnergy.aggregate({
      where: { roomId: room.id, date: { gte: monthStart, lt: tomorrow } },
      _sum: { usageKwh: true, cost: true },
    }),
    prisma.dailyEnergy.aggregate({
      where: { roomId: room.id, date: { gte: yearStart, lt: tomorrow } },
      _sum: { usageKwh: true },
    }),
    getRoomPowerActionCooldown(room.id),
  ]);

  const todayUsage = todayRecord?.usageKwh ?? 0;
  const yesterdayUsage = yesterdayRecord?.usageKwh ?? 0;
  const monthUsage = monthAgg._sum.usageKwh ?? 0;
  const monthCost = monthAgg._sum.cost ?? 0;
  const yearUsage = yearAgg._sum.usageKwh ?? 0;

  const dailyLimit = forceDefaultDailyLimit
    ? defaultDailyLimit
    : (room.energyLimit?.dailyLimit ?? defaultDailyLimit);
  const limitEnabled = room.energyLimit?.enabled ?? false;
  const monthlyCostLimit =
    room.energyLimit?.monthlyCostLimit != null && room.energyLimit.monthlyCostLimit > 0
      ? room.energyLimit.monthlyCostLimit
      : resolvedDefaultMonthlyCostLimit;
  const costLimitEnabled = room.energyLimit?.costEnabled ?? false;
  const usagePercent = dailyLimit > 0 ? Math.min(100, (todayUsage / dailyLimit) * 100) : 0;

  let devices = room.devices as any;
  if (!devices) {
    devices = await prisma.device.findMany({
      where: { roomId: room.id },
      include: {
        room: { select: { roomNumber: true } },
        site: { select: { name: true } },
      },
    });
  }
  const nowTs = Date.now();
  for (const d of devices as Array<any>) {
    const model = tryParseJsonModel(d.model);
    const category = inferDeviceCategory({ name: d.name, model: d.model });
    const ownership = model && typeof model.ownership === 'string' ? model.ownership : '';
    const source = model && typeof model.source === 'string' ? model.source : '';
    const scope = (model && (model as any).sourceScope === 'camera') ? 'camera' : 'main';
    const isXiaomi = ownership === 'xiaomi' || source === 'account_sync';
    const isLanDiscovered = !!d.did?.startsWith?.('LAN_') || source === 'lan_discovery';
    const lastSyncTs = d.lastSyncAt ? new Date(d.lastSyncAt).getTime() : 0;
    const stale = lastSyncTs > 0 && (nowTs - lastSyncTs) > XIAOMI_STALE_OFFLINE_THRESHOLD_MS;
    let forceOffline = false;
    if (category === shared_types.DeviceCategory.CAMERA) {
      if (!isLanDiscovered && (!lastSyncTs || stale)) forceOffline = true;
    }
    if (isXiaomi && !forceOffline) {
      const loggedIn = await xiaomiAdapter.isLoggedIn(scope).catch(() => false);
      if (!loggedIn) forceOffline = true;
    }
    if (forceOffline && d.status !== 'offline') {
      d.status = 'offline';
    }
    // #region debug-point B:energy-camera-status
    if (category === shared_types.DeviceCategory.CAMERA) {
      try {
        const fs=require('fs'); let u='http://127.0.0.1:7778/event', s='camera-status-sync';
        try { const e=fs.readFileSync('.dbg/camera-status-sync.env','utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {}
        fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'B',location:'energy.service.ts:computeRoomRealtime',msg:'[DEBUG] energy camera status evaluated',data:{roomId:room.id,roomNumber:room.roomNumber,did:d.did,name:d.name,dbStatus:d.status,lastSyncAt:d.lastSyncAt?new Date(d.lastSyncAt).toISOString():null,scope,isXiaomi,stale,forceOffline}})}).catch(()=>{});
      } catch {}
    }
    // #endregion
  }
  const onlineDevices = devices.filter((d: any) => d.status === 'online');
  const deviceOnline = onlineDevices.length > 0 || devices.length === 0;
  const mainDevice = onlineDevices[0] || devices[0];
  const displayName = getRoomDisplayName({
    roomNumber: room.roomNumber,
    name: room.name,
  });
  const roomAnnotation = getRoomAnnotation({
    roomNumber: room.roomNumber,
    name: room.name,
  });

  const power = mainDevice?.powerW ?? 0;
  const current = mainDevice?.currentA ?? 0;
  const voltage = mainDevice?.voltageV ?? 220;

  let status: shared_types.RoomStatus;
  if (room.cutoff) {
    status = shared_types.RoomStatus.CUTOFF;
  } else if (devices.length > 0 && !deviceOnline) {
    status = shared_types.RoomStatus.OFFLINE;
  } else if (usagePercent >= 95) {
    status = shared_types.RoomStatus.WARNING_95;
  } else if (usagePercent >= 90) {
    status = shared_types.RoomStatus.WARNING_90;
  } else if (usagePercent >= 80) {
    status = shared_types.RoomStatus.WARNING_80;
  } else {
    status = shared_types.RoomStatus.NORMAL;
  }

  return {
    roomId: room.id,
    siteId: room.siteId,
    siteName: room.site?.name ?? '默认区域',
    roomNumber: room.roomNumber,
    displayName,
    floor: room.floor ?? 1,
    roomAnnotation,
    power,
    current,
    voltage,
    todayUsage,
    yesterdayUsage,
    monthUsage,
    monthCost,
    yearUsage,
    status,
    usagePercent,
    dailyLimit,
    limitEnabled,
    monthlyCostLimit,
    costLimitEnabled,
    deviceOnline,
    cutoff: room.cutoff,
    powerActionCooldownUntil: powerActionCooldown.powerActionCooldownUntil,
    powerActionRetryAfterSeconds: powerActionCooldown.powerActionRetryAfterSeconds,
    powerActionLastType: powerActionCooldown.powerActionLastType,
    devices: devices.map(toDeviceItem),
  };
}

export async function getRooms(siteId?: string): Promise<RealtimeEnergyData[]> {
  await xiaomiAdapter.ensureRealtimeFresh();
  await xiaomiAdapter.ensureDailyHistoryFresh();
  const settings = await systemService.getSettings();
  const businessTimeZone = settings.businessTimezone ?? DEFAULT_BUSINESS_TIMEZONE;
  const defaultDailyLimit = resolveSystemDailyLimit(settings);
  const defaultMonthlyCostLimit = Number(settings.defaultMonthlyCostLimitEur ?? 200);
  const forceDefaultDailyLimit = !!settings.defaultDailyLimitUseWeeklyRules;

  const rooms = await prisma.room.findMany({
    where: siteId ? { siteId } : undefined,
    include: {
      site: { select: { name: true } },
      energyLimit: true,
      devices: {
        include: {
          room: { select: { roomNumber: true } },
          site: { select: { name: true } },
        },
      },
    },
  });
  return Promise.all(rooms.map((r) => computeRoomRealtime(r, businessTimeZone, defaultDailyLimit, forceDefaultDailyLimit, defaultMonthlyCostLimit)));
}

export async function getRoomDetail(roomId: string): Promise<RoomEnergyDetail> {
  await xiaomiAdapter.ensureRealtimeFresh();
  await xiaomiAdapter.ensureDailyHistoryFresh();
  const settings = await systemService.getSettings();
  const businessTimeZone = settings.businessTimezone ?? DEFAULT_BUSINESS_TIMEZONE;
  const defaultDailyLimit = resolveSystemDailyLimit(settings);
  const defaultMonthlyCostLimit = Number(settings.defaultMonthlyCostLimitEur ?? 200);
  const forceDefaultDailyLimit = !!settings.defaultDailyLimitUseWeeklyRules;

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      site: { select: { name: true } },
      energyLimit: true,
      devices: {
        include: {
          room: { select: { roomNumber: true } },
          site: { select: { name: true } },
        },
      },
    },
  });
  if (!room) {
    throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  }

  const realtime = await computeRoomRealtime(room, businessTimeZone, defaultDailyLimit, forceDefaultDailyLimit, defaultMonthlyCostLimit);
  const devices = room.devices.map(toDeviceItem);

  const today = getBusinessDate(new Date(), businessTimeZone);
  const today24h = (await xiaomiAdapter.getRoomTodayHourlyUsage(
    roomId,
    businessTimeZone,
  )) as HourlyDataPoint[];

  const lastCompleteDay = addDays(today, -1);
  const sevenDaysAgo = addDays(lastCompleteDay, -6);
  const last7DaysRaw = await prisma.dailyEnergy.findMany({
    where: { roomId, date: { gte: sevenDaysAgo, lte: lastCompleteDay } },
    orderBy: { date: 'asc' },
  });
  const last7Days: DailyDataPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(lastCompleteDay, -i);
    const dateStr = getDateKey(d);
    const rec = last7DaysRaw.find(x => {
      const xd = new Date(x.date);
      return getDateKey(xd) === dateStr;
    });
    last7Days.push({ date: dateStr, usage: rec?.usageKwh ?? 0 });
  }

  const thirtyDaysAgo = addDays(lastCompleteDay, -29);
  const last30DaysRaw = await prisma.dailyEnergy.findMany({
    where: { roomId, date: { gte: thirtyDaysAgo, lte: lastCompleteDay } },
    orderBy: { date: 'asc' },
  });
  const last30Days: DailyDataPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(lastCompleteDay, -i);
    const dateStr = getDateKey(d);
    const rec = last30DaysRaw.find(x => {
      const xd = new Date(x.date);
      return getDateKey(xd) === dateStr;
    });
    last30Days.push({ date: dateStr, usage: rec?.usageKwh ?? 0 });
  }

  const now = getBusinessDate(new Date(), businessTimeZone);
  const last12Months: MonthlyDataPoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const monthStart = new Date(y, m - 1, 1);
    const nextMonthStart = new Date(y, m, 1);
    const rec = await prisma.dailyEnergy.aggregate({
      where: {
        roomId,
        date: { gte: monthStart, lt: nextMonthStart },
      },
      _sum: { usageKwh: true },
    });
    last12Months.push({ year: y, month: m, usage: rec._sum.usageKwh ?? 0 });
  }

  return { realtime, today24h, last7Days, last30Days, last12Months, devices };
}

export async function updateEnergyLimit(
  roomId: string,
  dailyLimit: number,
  operatorUserId: string,
  enabled?: boolean,
  monthlyCostLimit?: number,
  costEnabled?: boolean,
  actorContext?: OperationActorContext,
) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) {
    throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  }
  if (dailyLimit < 0) {
    throw new AppError(400, 'INVALID_LIMIT', '限额值无效');
  }
  if (monthlyCostLimit != null && monthlyCostLimit < 0) {
    throw new AppError(400, 'INVALID_COST_LIMIT', '费用限额无效');
  }

  const limit = await prisma.energyLimit.upsert({
    where: { roomId },
    update: {
      dailyLimit,
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(typeof monthlyCostLimit === 'number' ? { monthlyCostLimit } : {}),
      ...(typeof costEnabled === 'boolean' ? { costEnabled } : {}),
    },
    create: {
      roomId,
      dailyLimit,
      enabled: typeof enabled === 'boolean' ? enabled : false,
      monthlyCostLimit: typeof monthlyCostLimit === 'number' ? monthlyCostLimit : 0,
      costEnabled: typeof costEnabled === 'boolean' ? costEnabled : false,
    },
  });

  await writeOperation(
    operatorUserId,
    OperationType.update_limit,
    roomId,
    {
      action: 'update_limit',
      actionLabel: '修改限额',
      source: actorContext?.source,
      sourceLabel: actorContext?.sourceLabel,
      roomNumber: room.roomNumber,
      roomName: room.name,
      displayName: getRoomDisplayName(room),
      dailyLimit,
      limitEnabled: limit.enabled,
      monthlyCostLimit: limit.monthlyCostLimit,
      costLimitEnabled: limit.costEnabled,
      note: '更新成功',
    },
    true,
  );

  return limit;
}

export async function getEnergyLimits(siteId?: string) {
  const settings = await systemService.getSettings();
  const effectiveDefaultDailyLimit = resolveSystemDailyLimit(settings);
  const items = await prisma.energyLimit.findMany({
    where: siteId ? { room: { siteId } } : undefined,
    include: {
      room: {
        include: {
          devices: {
            select: { name: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      },
    },
  });

  return items.map((item) => ({
    ...item,
    dailyLimit:
      settings.defaultDailyLimitUseWeeklyRules
        ? effectiveDefaultDailyLimit
        : item.dailyLimit,
    displayName: getRoomDisplayName(item.room),
    roomAnnotation: getRoomAnnotation(item.room),
  }));
}

export async function bulkUpdateLimitEnabled(
  enabled: boolean,
  operatorUserId: string,
  actorContext?: OperationActorContext,
  siteId?: string,
): Promise<{ ok: boolean; enabled: boolean; total: number }> {
  const defaultDailyLimit = await systemService.getSetting('defaultDailyLimitKwh', 10);
  const rooms = await prisma.room.findMany({
    where: siteId ? { siteId } : undefined,
    select: {
      id: true,
      energyLimit: {
        select: { dailyLimit: true },
      },
    },
  });

  for (const room of rooms) {
    await prisma.energyLimit.upsert({
      where: { roomId: room.id },
      update: { enabled },
      create: {
        roomId: room.id,
        dailyLimit: room.energyLimit?.dailyLimit ?? defaultDailyLimit,
        enabled,
      },
    });
  }

  await writeOperation(
    operatorUserId,
    OperationType.update_limit,
    null,
    {
      action: 'bulk_limit_enabled',
      actionLabel: enabled ? '批量开启限额断电' : '批量关闭限额断电',
      source: actorContext?.source,
      sourceLabel: actorContext?.sourceLabel,
      limitEnabled: enabled,
      totalCount: rooms.length,
    },
    true,
  );

  await broadcastDashboard().catch(() => {});

  return {
    ok: true,
    enabled,
    total: rooms.length,
  };
}

export async function bulkUpdateDailyLimit(
  dailyLimit: number,
  operatorUserId: string,
  actorContext?: OperationActorContext,
  siteId?: string,
): Promise<{ ok: boolean; dailyLimit: number; total: number }> {
  if (dailyLimit < 0) {
    throw new AppError(400, 'INVALID_LIMIT', '限额值无效');
  }

  const rooms = await prisma.room.findMany({
    where: siteId ? { siteId } : undefined,
    select: {
      id: true,
      energyLimit: {
        select: { enabled: true },
      },
    },
  });

  for (const room of rooms) {
    await prisma.energyLimit.upsert({
      where: { roomId: room.id },
      update: { dailyLimit },
      create: {
        roomId: room.id,
        dailyLimit,
        enabled: room.energyLimit?.enabled ?? false,
      },
    });
  }

  await writeOperation(
    operatorUserId,
    OperationType.update_limit,
    null,
    {
      action: 'bulk_update_limit',
      actionLabel: '批量修改日限额',
      source: actorContext?.source,
      sourceLabel: actorContext?.sourceLabel,
      dailyLimit,
      totalCount: rooms.length,
    },
    true,
  );

  await broadcastDashboard().catch(() => {});

  return {
    ok: true,
    dailyLimit,
    total: rooms.length,
  };
}

export async function checkAndTriggerAlarms(roomId: string): Promise<RoomStatus> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { energyLimit: true, devices: true },
  });
  if (!room) {
    throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  }

  const realtime = await computeRoomRealtime(room);
  await syncRoomOfflineLifecycle(room, realtime);

  const [alarmRatio80, alarmRatio90, alarmRatio95] = await Promise.all([
    systemService.getSetting('alarmRatio80', 0.8),
    systemService.getSetting('alarmRatio90', 0.9),
    systemService.getSetting('alarmRatio95', 0.95),
  ]);

  const threshold80 = alarmRatio80 * 100;
  const threshold90 = alarmRatio90 * 100;
  const threshold95 = alarmRatio95 * 100;

  const businessTimeZone = await systemService.getSetting(
    'businessTimezone',
    DEFAULT_BUSINESS_TIMEZONE,
  );
  const today = getBusinessDate(new Date(), businessTimeZone);
  const tomorrow = addDays(today, 1);

  const percent = realtime.usagePercent;
  if (realtime.dailyLimit == null || realtime.dailyLimit <= 0) {
    await prisma.room.update({
      where: { id: roomId },
      data: { status: realtime.status as any },
    });
    return realtime.status;
  }

  const warningAlarms: Array<{
    type: AlarmType;
    level: AlarmLevel;
    threshold: number;
    message: string;
  }> = [
    {
      type: AlarmType.limit_80,
      level: AlarmLevel.warning,
      threshold: threshold80,
      message: `${realtime.displayName}今日用电已超过${threshold80}%限额`,
    },
    {
      type: AlarmType.limit_90,
      level: AlarmLevel.danger,
      threshold: threshold90,
      message: `${realtime.displayName}今日用电已超过${threshold90}%限额`,
    },
    {
      type: AlarmType.limit_95,
      level: AlarmLevel.critical,
      threshold: threshold95,
      message: `${realtime.displayName}今日用电已超过${threshold95}%限额`,
    },
  ];

  for (const alarm of warningAlarms) {
    const shouldKeepOpen = percent >= alarm.threshold && !room.cutoff;
    if (shouldKeepOpen) {
      const existing = await prisma.alarmLog.findFirst({
        where: {
          roomId,
          type: alarm.type,
          resolved: false,
          createdAt: { gte: today, lt: tomorrow },
        },
      });
      if (!existing) {
        const createdAlarm = await prisma.alarmLog.create({
          data: {
            type: alarm.type,
            level: alarm.level,
            roomId,
            message: alarm.message,
            resolved: false,
          },
        });
        broadcastAlarm(createdAlarm);
      }
      continue;
    }

    await prisma.alarmLog.updateMany({
      where: {
        roomId,
        type: alarm.type,
        resolved: false,
        createdAt: { gte: today, lt: tomorrow },
      },
      data: {
        resolved: true,
        resolvedAt: new Date(),
      },
    });
  }

  await prisma.room.update({
    where: { id: roomId },
    data: { status: realtime.status as any },
  });

  return realtime.status;
}

export async function cutoffPower(
  roomId: string,
  operatorUserId: string | null | undefined,
  auto: boolean = false,
  actorContext?: OperationActorContext,
) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { devices: true, energyLimit: true },
  });
  if (!room) {
    throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  }

  await assertRoomPowerActionAllowed(
    roomId,
    OperationType.cutoff_power,
    operatorUserId,
    auto,
    actorContext,
  );

  const roomDisplayName = getRoomDisplayName(room);
  const realtimeBeforeAction = await computeRoomRealtime(room);
  const autoCutoffReason = auto ? resolveAutoCutoffReason(realtimeBeforeAction) : null;

  if (
    auto &&
    !realtimeBeforeAction.limitEnabled &&
    !realtimeBeforeAction.costLimitEnabled
  ) {
    await writeOperation(
      operatorUserId ?? null,
      OperationType.cutoff_power,
      roomId,
      {
        action: 'auto_cutoff_skipped',
        actionLabel: '自动断电跳过',
        source: 'system_auto',
        sourceLabel: '系统自动',
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        limitEnabled: false,
        costLimitEnabled: false,
        resultLabel: '跳过',
        note: '日限额断电和费用断电都已关闭，不执行自动断电',
      },
      true,
    );
    return room;
  }

  if (
    auto &&
    !autoCutoffReason
  ) {
    await writeOperation(
      operatorUserId ?? null,
      OperationType.cutoff_power,
      roomId,
      {
        action: 'auto_cutoff_skipped',
        actionLabel: '自动断电跳过',
        source: 'system_auto',
        sourceLabel: '系统自动',
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        dailyLimit: realtimeBeforeAction.dailyLimit,
        monthlyCostLimit: realtimeBeforeAction.monthlyCostLimit,
        resultLabel: '跳过',
        note: `当前用电 ${realtimeBeforeAction.todayUsage.toFixed(3)} kWh，本月费用 ${realtimeBeforeAction.monthCost.toFixed(2)} EUR，未超出已启用限额，不执行自动断电`,
      },
      true,
    );
    return room;
  }

  const controllableDevices = room.devices;
  if (controllableDevices.length === 0) {
    await writeOperation(
      operatorUserId ?? null,
      OperationType.cutoff_power,
      roomId,
      {
        action: auto ? 'auto_cutoff' : 'manual_cutoff',
        actionLabel: auto ? '自动断电失败' : '手动断电失败',
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        error: '没有可控制的设备',
      },
      false,
    );
    throw new AppError(400, 'NO_CONTROLLABLE_DEVICES', '没有可控制的设备，无法执行断电');
  }

  const failedDevices: string[] = [];
  for (const device of controllableDevices) {
    try {
      await xiaomiAdapter.turnOff(device.did, operatorUserId, {
        ...(actorContext ?? {}),
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
      });
    } catch {
      failedDevices.push(device.did);
    }
  }

  if (failedDevices.length > 0) {
    await writeOperation(
      operatorUserId ?? null,
      OperationType.cutoff_power,
      roomId,
      {
        action: auto ? 'auto_cutoff' : 'manual_cutoff',
        actionLabel: auto ? '自动断电失败' : '手动断电失败',
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        failedDevices,
        error: '部分设备断电失败',
      },
      false,
    );
    throw new AppError(
      502,
      'ROOM_CUTOFF_FAILED',
      `以下设备断电失败：${failedDevices.join(', ')}`,
    );
  }

  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: { cutoff: true, status: RoomStatus.cutoff },
  });

  await writeOperation(
    operatorUserId ?? null,
    OperationType.cutoff_power,
    roomId,
    {
      action: auto ? 'auto_cutoff' : 'manual_cutoff',
      actionLabel: auto ? '自动断电' : '手动断电',
      source: auto ? 'system_auto' : actorContext?.source,
      sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
      roomNumber: room.roomNumber,
      roomName: room.name,
      displayName: roomDisplayName,
      dailyLimit: autoCutoffReason?.type === 'daily' ? realtimeBeforeAction.dailyLimit : undefined,
      monthlyCostLimit: autoCutoffReason?.type === 'cost' ? realtimeBeforeAction.monthlyCostLimit : undefined,
      note: autoCutoffReason?.note ?? '执行成功',
    },
    true,
  );

  await prisma.alarmLog.updateMany({
    where: {
      roomId,
      resolved: false,
      type: { in: [AlarmType.limit_80, AlarmType.limit_90, AlarmType.limit_95] },
    },
    data: {
      resolved: true,
      resolvedAt: new Date(),
    },
  });

  if (
    !room.cutoff &&
    autoCutoffReason
  ) {
    const createdAlarm = await prisma.alarmLog.create({
      data: {
        type: AlarmType.limit_reached,
        level: AlarmLevel.critical,
        roomId,
        message: auto
          ? `${roomDisplayName}${autoCutoffReason.alarmMessage}`
          : `${roomDisplayName}${autoCutoffReason.type === 'cost' ? '已超出本月费用限额，已执行手动断电' : '已超出日限额，已执行手动断电'}`,
        resolved: true,
        resolvedAt: new Date(),
      },
    });
    broadcastAlarm(createdAlarm);
  }

  await Promise.allSettled([
    broadcastDashboard(),
    broadcastRoom(roomId),
  ]);

  return updatedRoom;
}

export async function restorePower(
  roomId: string,
  operatorUserId: string | null,
  auto: boolean = false,
  actorContext?: OperationActorContext,
) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { devices: true, energyLimit: true },
  });
  if (!room) {
    throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  }

  await assertRoomPowerActionAllowed(
    roomId,
    OperationType.restore_power,
    operatorUserId,
    auto,
    actorContext,
  );

  const roomDisplayName = getRoomDisplayName(room);
  const realtimeBeforeAction = await computeRoomRealtime(room);
  const autoCutoffReason = auto ? resolveAutoCutoffReason(realtimeBeforeAction) : null;

  if (auto && !realtimeBeforeAction.limitEnabled && !realtimeBeforeAction.costLimitEnabled) {
    await writeOperation(
      operatorUserId,
      OperationType.restore_power,
      roomId,
      {
        action: 'auto_restore_skipped',
        actionLabel: '自动恢复供电跳过',
        source: 'system_auto',
        sourceLabel: '系统自动',
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        limitEnabled: false,
        costLimitEnabled: false,
        resultLabel: '跳过',
        note: '日限额断电和费用断电都已关闭，不执行自动恢复供电',
      },
      true,
    );
    return room;
  }

  if (auto && autoCutoffReason) {
    await writeOperation(
      operatorUserId,
      OperationType.restore_power,
      roomId,
      {
        action: 'auto_restore_skipped',
        actionLabel: '自动恢复供电跳过',
        source: 'system_auto',
        sourceLabel: '系统自动',
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        dailyLimit: realtimeBeforeAction.dailyLimit,
        monthlyCostLimit: realtimeBeforeAction.monthlyCostLimit,
        resultLabel: '跳过',
        note: autoCutoffReason.type === 'cost'
          ? `本月费用 ${realtimeBeforeAction.monthCost.toFixed(2)} EUR 仍超出限额 ${realtimeBeforeAction.monthlyCostLimit.toFixed(2)} EUR，暂不自动恢复`
          : `今日用电 ${realtimeBeforeAction.todayUsage.toFixed(3)} kWh 仍超出日限额 ${realtimeBeforeAction.dailyLimit.toFixed(3)} kWh，暂不自动恢复`,
      },
      true,
    );
    return room;
  }

  const controllableDevices = room.devices;
  if (controllableDevices.length === 0) {
    await writeOperation(
      operatorUserId,
      OperationType.restore_power,
      roomId,
      {
        action: auto ? 'auto_restore' : 'manual_restore',
        actionLabel: auto ? '自动恢复供电失败' : '手动恢复供电失败',
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        error: '没有可控制的设备',
      },
      false,
    );
    throw new AppError(400, 'NO_CONTROLLABLE_DEVICES', '没有可控制的设备，无法恢复供电');
  }

  let failedDevices: string[] = [];
  for (const device of controllableDevices) {
    try {
      await xiaomiAdapter.turnOn(device.did, operatorUserId ?? undefined, {
        ...(actorContext ?? {}),
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
      }, auto ? AUTO_RESTORE_CONFIRMATION_OPTIONS : undefined);
    } catch {
      failedDevices.push(device.did);
    }
  }

  if (failedDevices.length > 0) {
    await xiaomiAdapter.refreshAllRoomsRealtime().catch(() => {});

    const refreshedDevices = await prisma.device.findMany({
      where: { did: { in: failedDevices } },
      select: {
        did: true,
        power: true,
      },
    });

    const refreshedPowerMap = new Map(
      refreshedDevices.map((device) => [device.did, device.power === true]),
    );

    failedDevices = failedDevices.filter((did) => !refreshedPowerMap.get(did));
  }

  if (failedDevices.length > 0) {
    await writeOperation(
      operatorUserId,
      OperationType.restore_power,
      roomId,
      {
        action: auto ? 'auto_restore' : 'manual_restore',
        actionLabel: auto ? '自动恢复供电失败' : '手动恢复供电失败',
        source: auto ? 'system_auto' : actorContext?.source,
        sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
        roomNumber: room.roomNumber,
        roomName: room.name,
        displayName: roomDisplayName,
        failedDevices,
        error: '部分设备恢复供电失败',
      },
      false,
    );
    throw new AppError(
      502,
      'ROOM_RESTORE_FAILED',
      `以下设备恢复供电失败：${failedDevices.join(', ')}`,
    );
  }

  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: { cutoff: false },
    include: { energyLimit: true, devices: true },
  });

  const realtime = await computeRoomRealtime(updatedRoom);
  await prisma.room.update({
    where: { id: roomId },
    data: { status: realtime.status },
  });

  await writeOperation(
    operatorUserId,
    OperationType.restore_power,
    roomId,
    {
      action: auto ? 'auto_restore' : 'manual_restore',
      actionLabel: auto ? '自动恢复供电' : '手动恢复供电',
      source: auto ? 'system_auto' : actorContext?.source,
      sourceLabel: auto ? '系统自动' : actorContext?.sourceLabel,
      roomNumber: room.roomNumber,
      roomName: room.name,
      displayName: roomDisplayName,
      note: '执行成功',
    },
    true,
  );

  const businessTimeZone = await systemService.getSetting(
    'businessTimezone',
    DEFAULT_BUSINESS_TIMEZONE,
  );
  const today = getBusinessDate(new Date(), businessTimeZone);
  const tomorrow = addDays(today, 1);

  await prisma.alarmLog.updateMany({
    where: {
      roomId,
      resolved: false,
      type: { in: [AlarmType.limit_80, AlarmType.limit_90, AlarmType.limit_95, AlarmType.limit_reached] },
      createdAt: { gte: today, lt: tomorrow },
    },
    data: {
      resolved: true,
      resolvedAt: new Date(),
    },
  });

  await Promise.allSettled([
    broadcastDashboard(),
    broadcastRoom(roomId),
  ]);

  return { ...updatedRoom, status: realtime.status };
}

export async function getMonthlyRanking(
  limit: number = 14,
  siteId?: string,
): Promise<RankingItem[]> {
  const businessTimeZone = await systemService.getSetting(
    'businessTimezone',
    DEFAULT_BUSINESS_TIMEZONE,
  );
  const today = getBusinessDate(new Date(), businessTimeZone);
  const year = today.getFullYear();
  const month = today.getMonth() + 1;

  const monthRecords = await prisma.monthlyEnergy.findMany({
    where: {
      year,
      month,
      ...(siteId ? { room: { siteId } } : {}),
    },
    include: {
      room: {
        include: {
          devices: {
            select: { name: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      },
    },
    orderBy: { usageKwh: 'desc' },
    take: limit,
  });

  const roomRecords: RankingItem[] = monthRecords.map((r, i) => ({
    roomId: r.roomId,
    roomNumber: r.room.roomNumber,
    displayName: getRoomDisplayName(r.room),
    roomAnnotation: getRoomAnnotation(r.room),
    usage: r.usageKwh,
    rank: i + 1,
  }));

  if (roomRecords.length < limit) {
    const existingIds = new Set(roomRecords.map(r => r.roomId));
    const otherRooms = await prisma.room.findMany({
      where: {
        id: { notIn: Array.from(existingIds) },
        ...(siteId ? { siteId } : {}),
      },
      include: {
        devices: {
          select: { name: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
      take: limit - roomRecords.length,
    });
    let nextRank = roomRecords.length + 1;
    for (const r of otherRooms) {
      roomRecords.push({
        roomId: r.id,
        roomNumber: r.roomNumber,
        displayName: getRoomDisplayName(r),
        roomAnnotation: getRoomAnnotation(r),
        usage: 0,
        rank: nextRank++,
      });
    }
  }

  return roomRecords;
}
