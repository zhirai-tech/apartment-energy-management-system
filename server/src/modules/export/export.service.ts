import { OperationType } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getRooms } from '../energy/energy.service';
import { systemService } from '../system/system.service';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  getBusinessDate,
  getDayKey,
  zonedTimeToUtc,
  addDays,
} from '../../lib/business-time';
import {
  formatOperationDetailsText,
  getOperationActorLabel,
  getOperationCategory,
  getOperationCategoryLabel,
  getOperationResultMeta,
  getOperationSourceLabel,
  getOperationTargetInfo,
  parseOperationDetailsPayload,
} from '../../lib/operation-log';
import { formatRoomDisplayName } from '../../lib/room-display';
import { DeviceCategory, inferDeviceCategory } from '@shared/index';

// ──────────────── CSV helpers ────────────────

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Array<Array<unknown>>): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '0';
  return Number(value).toFixed(digits);
}

function fmtTime(iso: Date | string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 'YYYY-MM-DD' 转换为该业务日的开始时刻（UTC），注意 zonedTimeToUtc 的 month 为 1 起始 */
function dayKeyToBusinessStart(dayKey: string, timeZone: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedTimeToUtc(y, m || 1, d || 1, 0, 0, 0, timeZone);
}

// ──────────────── Energy summary ────────────────
// 每行一个房间：实时功率、累计电量、今日/昨日/本周/本月/本年用电、费用、限额、设备数

export async function generateEnergySummaryCsv(siteId?: string): Promise<string> {
  const rooms = await getRooms(siteId);
  const settings = await systemService.getSettings();
  const timeZone = settings.businessTimezone ?? DEFAULT_BUSINESS_TIMEZONE;
  const dayKey = getDayKey(new Date(), timeZone); // 业务日期 YYYY-MM-DD
  const today = getBusinessDate(new Date(), timeZone);
  const tomorrow = addDays(today, 1);
  // 按业务日期的星期计算本周一（直接用日期字符串的 UTC 星期，避免时区偏移干扰）
  const [yk, mk, dk] = dayKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(yk, mk - 1, dk)).getUTCDay(); // 0=周日
  const daysToMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addDays(today, -daysToMonday);

  const roomIds = rooms.map((r) => r.roomId);
  const lastMonday = addDays(monday, -7);
  const [weekAgg, lastWeekAgg, todayAgg] = await Promise.all([
    prisma.dailyEnergy.groupBy({
      by: ['roomId'],
      where: { roomId: { in: roomIds }, date: { gte: monday, lt: tomorrow } },
      _sum: { usageKwh: true },
    }),
    prisma.dailyEnergy.groupBy({
      by: ['roomId'],
      where: { roomId: { in: roomIds }, date: { gte: lastMonday, lt: monday } },
      _sum: { usageKwh: true },
    }),
    prisma.dailyEnergy.groupBy({
      by: ['roomId'],
      where: { roomId: { in: roomIds }, date: { gte: today, lt: tomorrow } },
      _sum: { cost: true },
    }),
  ]);
  const weekMap = new Map(weekAgg.map((w) => [w.roomId, w._sum.usageKwh ?? 0]));
  const lastWeekMap = new Map(lastWeekAgg.map((w) => [w.roomId, w._sum.usageKwh ?? 0]));
  const todayCostMap = new Map(todayAgg.map((w) => [w.roomId, w._sum.cost ?? 0]));

  const rows: Array<Array<unknown>> = [
    [
      '区域', '房间号', '房间名称', '楼层', '设备数',
      '累计电量(kWh)',
      '今日用电(kWh)', '昨日用电(kWh)', '本周用电(kWh)', '上周用电(kWh)', '本月用电(kWh)', '本年用电(kWh)',
      '今日费用(€)', '本月费用(€)',
      '日限额(kWh)', '限额开关',
    ],
  ];

  for (const room of rooms) {
    const breakers = (room.devices ?? []).filter((d) => {
      const cat = d.category ?? inferDeviceCategory({ name: d.name, model: d.model ?? '' });
      return cat === DeviceCategory.CIRCUIT_BREAKER;
    });
    const totalKwh = breakers.reduce((sum, d) => sum + (d.totalKwh ?? 0), 0);

    rows.push([
      room.siteName ?? '默认区域',
      room.roomNumber,
      room.displayName,
      room.floor ?? 1,
      breakers.length,
      fmtNumber(totalKwh),
      fmtNumber(room.todayUsage),
      fmtNumber(room.yesterdayUsage),
      fmtNumber(weekMap.get(room.roomId) ?? 0),
      fmtNumber(lastWeekMap.get(room.roomId) ?? 0),
      fmtNumber(room.monthUsage),
      fmtNumber(room.yearUsage),
      fmtNumber(todayCostMap.get(room.roomId) ?? 0, 3),
      fmtNumber(room.monthCost, 3),
      fmtNumber(room.dailyLimit),
      room.limitEnabled ? '开' : '关',
    ]);
  }

  return '\uFEFF' + toCsv(rows);
}

// ──────────────── Energy daily ────────────────
// 每个房间每天一行：逐日用电/费用/峰值

export async function generateEnergyDailyCsv(params: {
  siteId?: string;
  from?: string;
  to?: string;
}): Promise<string> {
  const { siteId, from, to } = params;
  const settings = await systemService.getSettings();
  const timeZone = settings.businessTimezone ?? DEFAULT_BUSINESS_TIMEZONE;

  const today = getBusinessDate(new Date(), timeZone);
  const defaultFrom = addDays(today, -29);
  const fromDate = from ? dayKeyToBusinessStart(from, timeZone) : defaultFrom;
  const toDateExclusive = to
    ? addDays(dayKeyToBusinessStart(to, timeZone), 1)
    : addDays(today, 1);

  const rooms = await prisma.room.findMany({
    where: siteId ? { siteId } : undefined,
    select: { id: true, siteId: true, roomNumber: true, name: true, floor: true, site: { select: { name: true } } },
    orderBy: { roomNumber: 'asc' },
  });
  const roomIds = rooms.map((r) => r.id);

  const records = await prisma.dailyEnergy.findMany({
    where: {
      roomId: { in: roomIds },
      date: { gte: fromDate, lt: toDateExclusive },
    },
    orderBy: [{ date: 'asc' }, { roomId: 'asc' }],
  });

  const roomMap = new Map(rooms.map((r) => [r.id, r]));

  const rows: Array<Array<unknown>> = [
    ['区域', '房间号', '房间名称', '楼层', '日期', '日用电(kWh)', '费用(€)', '峰值功率(W)'],
  ];
  for (const rec of records) {
    const room = roomMap.get(rec.roomId);
    rows.push([
      room?.site?.name ?? '默认区域',
      room?.roomNumber ?? '',
      room ? formatRoomDisplayName(room.roomNumber, room.name) : '',
      room?.floor ?? '',
      getDayKey(rec.date, timeZone),
      fmtNumber(rec.usageKwh),
      fmtNumber(rec.cost, 3),
      fmtNumber(rec.peakW, 1),
    ]);
  }

  return '\uFEFF' + toCsv(rows);
}

// ──────────────── Energy weekly ────────────────
// 每个房间每周一行：按业务周（周一为起始）聚合用电/费用

export async function generateEnergyWeeklyCsv(params: {
  siteId?: string;
  from?: string;
  to?: string;
}): Promise<string> {
  const { siteId, from, to } = params;
  const settings = await systemService.getSettings();
  const timeZone = settings.businessTimezone ?? DEFAULT_BUSINESS_TIMEZONE;

  const today = getBusinessDate(new Date(), timeZone);
  const defaultFrom = addDays(today, -55); // 默认最近 8 周
  const fromDate = from ? dayKeyToBusinessStart(from, timeZone) : defaultFrom;
  const toDateExclusive = to
    ? addDays(dayKeyToBusinessStart(to, timeZone), 1)
    : addDays(today, 1);

  const rooms = await prisma.room.findMany({
    where: siteId ? { siteId } : undefined,
    select: { id: true, roomNumber: true, name: true, site: { select: { name: true } } },
    orderBy: { roomNumber: 'asc' },
  });
  const roomIds = rooms.map((r) => r.id);

  const records = await prisma.dailyEnergy.findMany({
    where: {
      roomId: { in: roomIds },
      date: { gte: fromDate, lt: toDateExclusive },
    },
    orderBy: [{ date: 'asc' }, { roomId: 'asc' }],
  });

  // 按 (房间, 业务周周一) 聚合
  const weekMap = new Map<string, { roomId: string; monday: string; usage: number; cost: number }>();
  for (const rec of records) {
    const dayKey = getDayKey(rec.date, timeZone);
    const [y, m, d] = dayKey.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
    const daysToMonday = weekday === 0 ? 6 : weekday - 1;
    const mondayDate = addDays(dayKeyToBusinessStart(dayKey, timeZone), -daysToMonday);
    const monday = getDayKey(mondayDate, timeZone);
    const key = `${rec.roomId}|${monday}`;
    const entry = weekMap.get(key) ?? { roomId: rec.roomId, monday, usage: 0, cost: 0 };
    entry.usage += rec.usageKwh ?? 0;
    entry.cost += rec.cost ?? 0;
    weekMap.set(key, entry);
  }

  const roomMap = new Map(rooms.map((r) => [r.id, r]));
  const sorted = [...weekMap.values()].sort((a, b) => {
    const ra = roomMap.get(a.roomId)?.roomNumber ?? '';
    const rb = roomMap.get(b.roomId)?.roomNumber ?? '';
    if (ra !== rb) return ra.localeCompare(rb, 'en', { numeric: true });
    return a.monday.localeCompare(b.monday);
  });

  const rows: Array<Array<unknown>> = [
    ['区域', '房间号', '房间名称', '周起始(周一)', '周用电(kWh)', '周费用(€)'],
  ];
  for (const entry of sorted) {
    const room = roomMap.get(entry.roomId);
    rows.push([
      room?.site?.name ?? '默认区域',
      room?.roomNumber ?? '',
      room ? formatRoomDisplayName(room.roomNumber, room.name) : '',
      entry.monday,
      fmtNumber(entry.usage),
      fmtNumber(entry.cost, 3),
    ]);
  }

  return '\uFEFF' + toCsv(rows);
}

// ──────────────── Operations ────────────────

export async function generateOperationsCsv(params: {
  siteId?: string;
  from?: string;
  to?: string;
  category?: string;
}): Promise<string> {
  const { siteId, from, to, category } = params;

  const where: Record<string, unknown> = {};
  if (siteId) {
    where.OR = [{ room: { siteId } }, { roomId: null }];
  }
  if (from || to) {
    where.createdAt = {};
    if (from) (where.createdAt as Record<string, Date>).gte = new Date(`${from}T00:00:00`);
    if (to) (where.createdAt as Record<string, Date>).lte = new Date(`${to}T23:59:59.999`);
  }

  const include = {
    user: { select: { username: true } },
    room: {
      select: {
        roomNumber: true,
        name: true,
        devices: { select: { name: true }, orderBy: { createdAt: 'asc' as const }, take: 1 },
      },
    },
  } as const;

  const logs = await prisma.operationLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 20000,
    include,
  });

  const rows: Array<Array<unknown>> = [
    ['时间', '操作类型', '分类', '操作人', '来源', '房间', '详情', '结果'],
  ];
  for (const log of logs) {
    const resolvedCategory = getOperationCategory(log.type as OperationType, log.details);
    if (category && resolvedCategory !== category) continue;

    const targetInfo = getOperationTargetInfo(log.details);
    const detailsText = formatOperationDetailsText(log.type as OperationType, log.details);
    const resultMeta = getOperationResultMeta(log.success, log.details);
    const parsedDetails = parseOperationDetailsPayload(log.details);
    const sourceLabel = parsedDetails
      ? (parsedDetails.sourceLabel || getOperationSourceLabel(parsedDetails.source))
      : null;
    const roomLabel =
      (log.room?.roomNumber
        ? formatRoomDisplayName(log.room.roomNumber, log.room.name)
        : null) ||
      targetInfo.displayName ||
      targetInfo.roomName ||
      targetInfo.deviceName ||
      targetInfo.roomNumber ||
      '';

    const detailsWithResult = detailsText
      ? `${detailsText}\n结果：${resultMeta.label}`
      : `结果：${resultMeta.label}`;

    rows.push([
      fmtTime(log.createdAt),
      String(log.type),
      getOperationCategoryLabel(resolvedCategory),
      getOperationActorLabel(log.user?.username ?? null, log.details),
      sourceLabel ?? '',
      roomLabel,
      detailsWithResult,
      resultMeta.label,
    ]);
  }

  return '\uFEFF' + toCsv(rows);
}
