import prisma from '../../lib/prisma';
import { computeRoomRealtime } from '../energy/energy.service';
import { systemService } from '../system/system.service';
import { xiaomiAdapter } from '../system/xiaomi.adapter';
import type {
  DashboardSummary,
  DeviceItem,
  FiveGCpeRuntime,
  NetworkHistoryResponse,
  NetworkUsagePoint,
  WifiApRuntime,
} from '@shared/index';
import { DeviceStatus, DeviceCategory, inferDeviceCategory, networkGroupKey, pickPrimaryPublicNetworkDevice, publicNetworkPrimaryScore } from '@shared/index';
import { DeviceStatus as PrismaDeviceStatus } from '@prisma/client';
import { DEFAULT_BUSINESS_TIMEZONE, addDays, getBusinessDate, getDateKey } from '../../lib/business-time';
import { extractCameraRuntime, extractFiveGCpeRuntime, extractWifiApRuntime } from '../../lib/device-runtime';

const PRISMA_TO_SHARED_DEVICE_STATUS: Record<PrismaDeviceStatus, DeviceStatus> =
  {
    online: DeviceStatus.ONLINE,
    offline: DeviceStatus.OFFLINE,
    unknown: DeviceStatus.UNKNOWN,
  };

function tryParseJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const obj = JSON.parse(value);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeVendorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^(?:\*?\s*no company\s*\*?|unknown|n\/a|null|undefined|--?)$/i.test(text)) return null;
  return text;
}

function toNonNegativeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function bytesToGb(bytes: number): number {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function extractNetworkDaySnapshot(modelValue: unknown): { rxBytes: number; txBytes: number; totalBytes: number } | null {
  const parsed = tryParseJson(modelValue);
  const root =
    (parsed?.fiveGCpe && typeof parsed.fiveGCpe === 'object'
      ? (parsed.fiveGCpe as Record<string, unknown>)
      : parsed?.runtime && typeof parsed.runtime === 'object' && (parsed.runtime as any).fiveGCpe
        ? ((parsed.runtime as any).fiveGCpe as Record<string, unknown>)
        : null);
  if (!root) return null;
  const rxBytes = toNonNegativeNumber(root.dayRxBytes);
  const txBytes = toNonNegativeNumber(root.dayTxBytes);
  const totalBytes = rxBytes + txBytes;
  if (totalBytes <= 0) return null;
  return { rxBytes, txBytes, totalBytes };
}

type AggregatedNetworkRow = {
  dateKey: string;
  totalBytes: number;
};

function aggregateBytesByDate(rows: AggregatedNetworkRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.dateKey, Number(((out.get(row.dateKey) ?? 0) + row.totalBytes).toFixed(2)));
  }
  return out;
}

function buildDailyNetworkPoints(byDate: Map<string, number>, today: Date, days = 7): NetworkUsagePoint[] {
  const points: NetworkUsagePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    const dateKey = getDateKey(d);
    points.push({
      label: dateKey.slice(5),
      startDate: dateKey,
      endDate: dateKey,
      usage: bytesToGb(byDate.get(dateKey) ?? 0),
    });
  }
  return points;
}

function buildRollingWeekPoints(byDate: Map<string, number>, today: Date, weeks = 8): NetworkUsagePoint[] {
  const points: NetworkUsagePoint[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const end = addDays(today, -(i * 7));
    const start = addDays(end, -6);
    let totalBytes = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      totalBytes += byDate.get(getDateKey(addDays(start, offset))) ?? 0;
    }
    points.push({
      label: `${getDateKey(start).slice(5)}~${getDateKey(end).slice(5)}`,
      startDate: getDateKey(start),
      endDate: getDateKey(end),
      usage: bytesToGb(totalBytes),
    });
  }
  return points;
}

function buildMonthlyNetworkPoints(byDate: Map<string, number>, today: Date, months = 12): NetworkUsagePoint[] {
  const points: NetworkUsagePoint[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const nextStart = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    let totalBytes = 0;
    for (const [dateKey, bytes] of byDate.entries()) {
      const d = new Date(`${dateKey}T00:00:00`);
      if (d >= start && d < nextStart) totalBytes += bytes;
    }
    points.push({
      label: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      year: start.getFullYear(),
      month: start.getMonth() + 1,
      startDate: getDateKey(start),
      endDate: getDateKey(addDays(nextStart, -1)),
      usage: bytesToGb(totalBytes),
    });
  }
  return points;
}

function buildYearlyNetworkPoints(byDate: Map<string, number>, today: Date, years = 5): NetworkUsagePoint[] {
  const points: NetworkUsagePoint[] = [];
  for (let i = years - 1; i >= 0; i -= 1) {
    const year = today.getFullYear() - i;
    let totalBytes = 0;
    for (const [dateKey, bytes] of byDate.entries()) {
      if (dateKey.startsWith(`${year}-`)) totalBytes += bytes;
    }
    points.push({
      label: String(year),
      year,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      usage: bytesToGb(totalBytes),
    });
  }
  return points;
}

export async function persistNetworkHistory(businessTimeZone = DEFAULT_BUSINESS_TIMEZONE): Promise<number> {
  const today = getBusinessDate(new Date(), businessTimeZone);
  const devices = await prisma.device.findMany({
    where: {
      did: { startsWith: 'LAN_' },
    },
    select: {
      id: true,
      model: true,
    },
  });

  let persisted = 0;
  for (const device of devices) {
    const snapshot = extractNetworkDaySnapshot(device.model);
    if (!snapshot) continue;
    await prisma.dailyNetworkTraffic.upsert({
      where: {
        deviceId_date: {
          deviceId: device.id,
          date: today,
        },
      },
      update: {
        rxBytes: snapshot.rxBytes,
        txBytes: snapshot.txBytes,
        totalBytes: snapshot.totalBytes,
      },
      create: {
        deviceId: device.id,
        date: today,
        rxBytes: snapshot.rxBytes,
        txBytes: snapshot.txBytes,
        totalBytes: snapshot.totalBytes,
      },
    });
    persisted += 1;
  }
  return persisted;
}

const XIAOMI_STALE_OFFLINE_THRESHOLD_MS_DASHBOARD = 20 * 60 * 1000;

function pickModelText(modelValue: unknown): string {
  if (typeof modelValue !== 'string') return String(modelValue ?? '');
  const obj = tryParseJson(modelValue);
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
  const raw = (typeof obj._raw === 'string' && obj._raw) ? obj._raw : '';
  const brand = (typeof obj.brand === 'string' && obj.brand) ? obj.brand : '';
  const vendor = (typeof obj.vendorName === 'string' && obj.vendorName) ? obj.vendorName : '';
  return camModel || cpeModel || wifiModel || brand || camBrand || vendor || raw || modelValue;
}

async function toDeviceItem(d: any): Promise<DeviceItem> {
  let prismaStatus = (d.status ?? 'unknown') as PrismaDeviceStatus;
  const parsedModel = tryParseJson(d.model);
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
      : category === DeviceCategory.FIVE_G_CPE
        ? 'huawei_cpe'
        : category === DeviceCategory.WIFI_AP && /(nokia|beacon|ha-020)/i.test(adapterHaystack)
          ? 'nokia_beacon'
          : category === DeviceCategory.WIFI_AP && !!ipAddress && /\.1$/.test(ipAddress) && !/(nokia|beacon|ha-020)/i.test(adapterHaystack)
            ? 'huawei_cpe'
            : null;
  const normalizedVendorName =
    vendorName ?? (adapterKind === 'huawei_cpe' ? 'Huawei' : adapterKind === 'nokia_beacon' ? 'Nokia' : null);
  const ownership = parsedModel && typeof parsedModel.ownership === 'string' ? parsedModel.ownership : '';
  const source = parsedModel && typeof parsedModel.source === 'string' ? parsedModel.source : '';
  const scope = (parsedModel && (parsedModel as any).sourceScope === 'camera') ? 'camera' : 'main';
  const isXiaomi = ownership === 'xiaomi' || source === 'account_sync';
  const isLanDiscovered = !!d.did?.startsWith?.('LAN_') || source === 'lan_discovery';
  const lastSyncTs = d.lastSyncAt ? new Date(d.lastSyncAt).getTime() : 0;
  const stale = lastSyncTs > 0 && (Date.now() - lastSyncTs) > XIAOMI_STALE_OFFLINE_THRESHOLD_MS_DASHBOARD;
  let forceOffline = false;
  if (category === DeviceCategory.CAMERA) {
    if (!isLanDiscovered && (!lastSyncTs || stale)) forceOffline = true;
  }
  if (isXiaomi && !forceOffline) {
    const loggedIn = await xiaomiAdapter.isLoggedIn(scope).catch(() => false);
    if (!loggedIn) forceOffline = true;
  }
  // #region debug-point A:dashboard-camera-status
  if (category === DeviceCategory.CAMERA) { try { const fs=require('fs'); let u='http://127.0.0.1:7778/event', s='camera-status-sync'; try { const e=fs.readFileSync('.dbg/camera-status-sync.env','utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'A',location:'dashboard.service.ts:toDeviceItem',msg:'[DEBUG] dashboard camera status evaluated',data:{did:d.did,name:d.name,dbStatus:d.status,lastSyncAt:d.lastSyncAt?new Date(d.lastSyncAt).toISOString():null,scope,isXiaomi,stale,forceOffline,parsedCameraOnline:parsedModel&&parsedModel.camera&&typeof parsedModel.camera==='object'?!!(parsedModel.camera as any).online:null}})}).catch(()=>{}); } catch {} }
  // #endregion
  if (forceOffline && prismaStatus !== 'offline') {
    prismaStatus = 'offline';
  }
  const sharedStatus =
    PRISMA_TO_SHARED_DEVICE_STATUS[prismaStatus] ?? DeviceStatus.UNKNOWN;
  let cameraRuntime: DeviceItem['camera'] = extractCameraRuntime(parsedModel, prismaStatus);
  let wifiApRuntime: WifiApRuntime | null = extractWifiApRuntime(parsedModel);
  let fiveGCpeRuntime: FiveGCpeRuntime | null = extractFiveGCpeRuntime(parsedModel);
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
    ownership: d.did?.startsWith?.('LAN_') ? 'other' : d.ownership ?? null,
    source: d.did?.startsWith?.('LAN_') ? 'lan_discovery' : d.source ?? null,
    macAddress,
    ipAddress,
    vendorName: normalizedVendorName,
    adapterKind,
    camera: cameraRuntime,
    wifiAp: wifiApRuntime,
    fiveGCpe: fiveGCpeRuntime,
  };
}

export async function getDashboardSummary(siteId?: string): Promise<DashboardSummary> {
  await xiaomiAdapter.ensureRealtimeFresh();
  await xiaomiAdapter.ensureDailyHistoryFresh();
  await systemService.refreshDashboardNetworkRuntimes().catch(() => {});

  const businessTimeZone = await systemService.getSetting(
    'businessTimezone',
    DEFAULT_BUSINESS_TIMEZONE,
  );
  const today = getBusinessDate(new Date(), businessTimeZone);

  const pricePerKwh = await systemService.getSetting('pricePerKwh', 0.6);

  const [todayUsageRecords, totalDevices, onlineDevices, offlineDevices, alarmCount, rooms, rawDevices] = await Promise.all([
    prisma.dailyEnergy.findMany({
      where: {
        date: today,
        ...(siteId ? { room: { siteId } } : {}),
      },
    }),
    prisma.device.count({ where: siteId ? { siteId } : undefined }),
    prisma.device.count({
      where: {
        status: PrismaDeviceStatus.online,
        ...(siteId ? { siteId } : {}),
      },
    }),
    prisma.device.count({
      where: {
        status: PrismaDeviceStatus.offline,
        ...(siteId ? { siteId } : {}),
      },
    }),
    prisma.alarmLog.count({
      where: {
        resolved: false,
        ...(siteId ? { room: { siteId } } : {}),
      },
    }),
    prisma.room.findMany({
      where: siteId ? { siteId } : undefined,
      include: {
        site: { select: { name: true } },
        energyLimit: true,
        devices: {
          include: {
            site: { select: { name: true } },
          },
        },
      },
    }),
    prisma.device.findMany({
      where: siteId ? { siteId } : undefined,
      include: {
        room: { select: { roomNumber: true } },
        site: { select: { name: true } },
      },
      orderBy: [{ roomId: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const todayTotalUsage = todayUsageRecords.reduce((sum, r) => sum + r.usageKwh, 0);
  const estimatedCost = todayTotalUsage * pricePerKwh;

  const [roomData, rawDeviceItems] = await Promise.all([
    Promise.all(rooms.map(r => computeRoomRealtime(r, businessTimeZone))),
    Promise.all(rawDevices.map(toDeviceItem)),
  ]);

  const publicNetworkItems = rawDeviceItems.filter((d) =>
    d.category === DeviceCategory.WIFI_AP || d.category === DeviceCategory.FIVE_G_CPE,
  );
  const publicGroups = new Map<string, DeviceItem[]>();
  for (const d of publicNetworkItems) {
    const anyD = d as any;
    const runtime = anyD.runtime ?? anyD.modelRuntime ?? anyD.adapterRuntime ?? null;
    const wifiAp = runtime?.wifiAp ?? anyD.wifiAp ?? anyD.wifi_ap ?? null;
    const cpe = runtime?.fiveGCpe ?? anyD.fiveGCpe ?? anyD.cpe ?? runtime?.cpe ?? null;
    const ssid = String(wifiAp?.ssid ?? cpe?.ssid ?? anyD.ssid ?? '').trim() || null;
    const vendor = anyD.vendorName ?? anyD.vendor ?? anyD.manufacturer ?? anyD.brand ?? null;
    const gk = networkGroupKey({
      category: d.category,
      ip: anyD.ipAddress ?? anyD.ip ?? null,
      mac: anyD.mac ?? anyD.macAddress ?? null,
      vendor,
      name: anyD.name ?? null,
      model: anyD.model ?? null,
      hostname: anyD.hostname ?? anyD.hostName ?? null,
      ssid,
    });
    const key = gk ?? `s_${d.did}`;
    const arr = publicGroups.get(key) ?? [];
    arr.push(d);
    publicGroups.set(key, arr);
  }
  const keepDids = new Set(rawDeviceItems.map((d) => d.did));
  for (const [, list] of publicGroups) {
    if (list.length <= 1) continue;
    const scored = list.map((d) => {
      const anyD = d as any;
      const runtime = anyD.runtime ?? anyD.modelRuntime ?? anyD.adapterRuntime ?? null;
      const wifiAp = runtime?.wifiAp ?? anyD.wifiAp ?? anyD.wifi_ap ?? null;
      const cpe = runtime?.fiveGCpe ?? anyD.fiveGCpe ?? anyD.cpe ?? runtime?.cpe ?? null;
      const mesh = Array.isArray(wifiAp?.meshTopology)
        ? wifiAp.meshTopology
        : Array.isArray(cpe?.meshTopology)
          ? cpe.meshTopology
          : [];
      const cc = Number(
        wifiAp?.clientCount ??
          cpe?.clientCount ??
          (Array.isArray(wifiAp?.clients) ? wifiAp.clients.length : 0) ??
          (Array.isArray(cpe?.clients) ? cpe.clients.length : 0) ??
          0,
      );
      const roll = mesh.some((n: any) => String(n.role ?? '') === 'master')
        ? 'master'
        : null;
      const vendor = anyD.vendorName ?? anyD.vendor ?? anyD.manufacturer ?? anyD.brand ?? null;
      const ctx = {
        category: d.category,
        ip: anyD.ipAddress ?? anyD.ip ?? null,
        mac: anyD.mac ?? anyD.macAddress ?? null,
        vendor,
        name: anyD.name ?? null,
        model: anyD.model ?? null,
        hostname: anyD.hostname ?? anyD.hostName ?? null,
        clientCount: cc,
        meshNodeCount: mesh.length,
        status: d.status,
        uptimeSeconds: Number(anyD.uptimeSeconds ?? anyD.uptime ?? 0) || null,
        roll,
      } as any;
      return { d, ctx, score: publicNetworkPrimaryScore(ctx) };
    });
    scored.sort((a, b) => b.score - a.score);
    const primary = scored[0]?.d;
    if (!primary) continue;
    for (const x of list) {
      if (x.did !== primary.did) keepDids.delete(x.did);
    }
  }
  const devices = rawDeviceItems.filter((d) => keepDids.has(d.did));

  return {
    siteId: siteId ?? null,
    siteName:
      rooms[0]?.site?.name ??
      (siteId
        ? (await prisma.site.findUnique({
            where: { id: siteId },
            select: { name: true },
          }))?.name ?? null
        : null),
    todayTotalUsage,
    estimatedCost,
    totalDevices,
    onlineDevices,
    offlineDevices,
    alarmCount,
    roomData,
    devices,
  };
}

export async function getNetworkHistory(siteId?: string): Promise<NetworkHistoryResponse> {
  await systemService.refreshDashboardNetworkRuntimes().catch(() => {});
  const businessTimeZone = await systemService.getSetting(
    'businessTimezone',
    DEFAULT_BUSINESS_TIMEZONE,
  );
  await persistNetworkHistory(businessTimeZone).catch(() => {});

  const today = getBusinessDate(new Date(), businessTimeZone);
  const earliestDate = new Date(today.getFullYear() - 4, 0, 1);
  const rows = await prisma.dailyNetworkTraffic.findMany({
    where: {
      date: {
        gte: earliestDate,
        lte: today,
      },
      ...(siteId ? { device: { siteId } } : {}),
    },
    select: {
      date: true,
      totalBytes: true,
    },
    orderBy: {
      date: 'asc',
    },
  });

  const aggregatedRows: AggregatedNetworkRow[] = rows.map((row) => ({
    dateKey: getDateKey(new Date(row.date)),
    totalBytes: toNonNegativeNumber(row.totalBytes),
  }));
  const byDate = aggregateBytesByDate(aggregatedRows);

  return {
    day: buildDailyNetworkPoints(byDate, today, 7),
    week: buildRollingWeekPoints(byDate, today, 8),
    month: buildMonthlyNetworkPoints(byDate, today, 12),
    year: buildYearlyNetworkPoints(byDate, today, 5),
  };
}
