export type XiaomiSessionScope = 'main' | 'camera';

export interface XiaomiSession {
  userId: string;
  serviceToken: string;
  ssecurity: string;
  nonce?: number;
  username: string;
  loggedAt: string;
  region?: string;
}

export interface RawDevice {
  did: string;
  name?: string;
  model?: string;
  isOnline?: boolean;
  show_mode?: number;
  localip?: string;
  token?: string;
  status?: number;
  room_id?: number | string;
  bssid?: string;
  parent_id?: string;
}

export interface MiotPropQueryItem {
  did: string;
  siid: number;
  piid: number;
}

export interface DevicePropSnapshot {
  power?: boolean;
  powerW?: number;
  currentA?: number;
  voltageV?: number;
  totalKwh?: number;
}

export interface PowerConfirmationOptions {
  initialDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampFinite(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

type DeviceTelemetryMetric = 'powerW' | 'currentA' | 'voltageV' | 'totalKwh';

export function normalizeDeviceTelemetryValue(
  model: string,
  metric: DeviceTelemetryMetric,
  value: number | null | undefined,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const lowerModel = String(model ?? '').toLowerCase();

  // lxzn smart breaker returns raw device units:
  // 3.1 = 0.01 kWh, 3.2 = mA, 3.3 = 0.1 V, 3.6 = W
  if (/lxzn\.switch\.cbcsmj/i.test(lowerModel)) {
    if (metric === 'totalKwh') return Number((value / 100).toFixed(3));
    if (metric === 'currentA') return Number((value / 1000).toFixed(3));
    if (metric === 'voltageV') return Number((value / 10).toFixed(1));
    if (metric === 'powerW') return Number(value.toFixed(1));
  }

  return value;
}

export interface DeviceRuntimeRealtime {
  powerW?: number | null;
  currentA?: number | null;
  voltageV?: number | null;
  totalKwh?: number | null;
  online?: boolean | null;
}

export interface DeviceRuntimePrevious {
  powerW?: number | null;
  currentA?: number | null;
  voltageV?: number | null;
  totalKwh?: number | null;
  power?: boolean | null;
}

const RANGE: {
  powerW: [number, number];
  currentA: [number, number];
  voltageV: [number, number];
  totalKwh: [number, number];
  totalKwhMaxIncrement: number;
} = {
  powerW: [0, 50000],
  currentA: [0, 200],
  voltageV: [80, 500],
  totalKwh: [0, 1_000_000],
  totalKwhMaxIncrement: 500,
};

function inRange(n: number | undefined | null, min: number, max: number): n is number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  return n >= min && n <= max;
}

function isLikelyScaledTotalKwh(previous: number, incoming: number): boolean {
  if (!(previous > 0 && incoming > 0)) return false;
  const ratio = previous / incoming;
  return (
    (ratio >= 9.5 && ratio <= 10.5) ||
    (ratio >= 95 && ratio <= 105) ||
    (ratio >= 950 && ratio <= 1050)
  );
}

export function sanitizeRuntimeForUpsert(
  incoming: DeviceRuntimeRealtime,
  previous: DeviceRuntimePrevious | null,
): Required<DeviceRuntimeRealtime> & { power?: boolean | null } {
  const safePowerW = inRange(incoming.powerW ?? null, RANGE.powerW[0], RANGE.powerW[1])
    ? (incoming.powerW as number)
    : (inRange(previous?.powerW ?? null, RANGE.powerW[0], RANGE.powerW[1])
        ? (previous!.powerW as number)
        : null);
  const safeCurrentA = inRange(incoming.currentA ?? null, RANGE.currentA[0], RANGE.currentA[1])
    ? (incoming.currentA as number)
    : (inRange(previous?.currentA ?? null, RANGE.currentA[0], RANGE.currentA[1])
        ? (previous!.currentA as number)
        : null);
  const safeVoltageV = inRange(incoming.voltageV ?? null, RANGE.voltageV[0], RANGE.voltageV[1])
    ? (incoming.voltageV as number)
    : (inRange(previous?.voltageV ?? null, RANGE.voltageV[0], RANGE.voltageV[1])
        ? (previous!.voltageV as number)
        : null);

  let safeTotalKwh: number | null = null;
  const prevTotal = inRange(previous?.totalKwh ?? null, RANGE.totalKwh[0], RANGE.totalKwh[1])
    ? (previous!.totalKwh as number)
    : null;
  if (inRange(incoming.totalKwh ?? null, RANGE.totalKwh[0], RANGE.totalKwh[1])) {
    const incomingTotal = incoming.totalKwh as number;
    if (prevTotal == null) {
      safeTotalKwh = incomingTotal;
    } else if (incomingTotal >= prevTotal && incomingTotal - prevTotal <= RANGE.totalKwhMaxIncrement) {
      safeTotalKwh = incomingTotal;
    } else if (
      incomingTotal < prevTotal &&
      isLikelyScaledTotalKwh(prevTotal, incomingTotal)
    ) {
      // Allow recovery from previously polluted 10x/100x/1000x bad values back to the true value.
      safeTotalKwh = incomingTotal;
    } else {
      safeTotalKwh = prevTotal;
    }
  } else {
    safeTotalKwh = prevTotal;
  }

  const online = incoming.online;
  const power =
    previous?.power !== undefined && previous?.power !== null
      ? (safePowerW == null ? previous.power : safePowerW > 0)
      : (safePowerW == null ? null : safePowerW > 0);

  return {
    powerW: safePowerW,
    currentA: safeCurrentA,
    voltageV: safeVoltageV,
    totalKwh: safeTotalKwh,
    online: online == null ? (safePowerW == null ? null : safePowerW > 0) : online,
    power,
  };
}

export function buildMiotPropQueriesForDevice(device: RawDevice): MiotPropQueryItem[] {
  const model = String(device.model ?? '');
  const did = device.did;
  const qu: MiotPropQueryItem[] = [];
  qu.push({ did, siid: 2, piid: 1 });
  if (model.startsWith('ZNCZ') || /lxzn\.switch\.cbcsmj/i.test(model)) {
    qu.push({ did, siid: 3, piid: 1 });
    qu.push({ did, siid: 3, piid: 2 });
    qu.push({ did, siid: 3, piid: 3 });
    qu.push({ did, siid: 3, piid: 6 });
  } else if (/BL0937|chdj.*electr/i.test(model)) {
    qu.push({ did, siid: 3, piid: 1 });
    qu.push({ did, siid: 3, piid: 2 });
    qu.push({ did, siid: 3, piid: 3 });
    qu.push({ did, siid: 3, piid: 4 });
  } else {
    qu.push({ did, siid: 2, piid: 2 });
    qu.push({ did, siid: 2, piid: 3 });
    qu.push({ did, siid: 2, piid: 4 });
    qu.push({ did, siid: 2, piid: 5 });
    qu.push({ did, siid: 2, piid: 6 });
    qu.push({ did, siid: 3, piid: 1 });
    qu.push({ did, siid: 3, piid: 2 });
    qu.push({ did, siid: 3, piid: 3 });
    qu.push({ did, siid: 3, piid: 6 });
  }
  return qu;
}

export function parseDevicePropResponse(
  device: RawDevice,
  results: Array<{ did?: string; siid?: number; piid?: number; value?: unknown; code?: number }> | null | undefined,
): DevicePropSnapshot {
  if (!Array.isArray(results)) return {};
  const model = String(device.model ?? '');
  const isLxznCbcsmj = /lxzn\.switch\.cbcsmj/i.test(model);
  const isZNCZ = !isLxznCbcsmj && model.startsWith('ZNCZ');
  const isBL0937 = !isLxznCbcsmj && !isZNCZ && /BL0937|chdj.*electr/i.test(model);
  let hasStandardPower = false;
  const out: DevicePropSnapshot = {};
  for (const r of results) {
    if (!r || r.did !== device.did) continue;
    if (r.code !== undefined && r.code !== 0) continue;
    const siid = Number(r.siid);
    const piid = Number(r.piid);
    const raw = r.value;
    if (siid === 2 && piid === 1) {
      hasStandardPower = true;
      if (typeof raw === 'boolean') { out.power = raw; }
      else {
        const nv = clampFinite(raw);
        if (nv != null) out.power = nv === 1;
      }
      continue;
    }
    const numeric = clampFinite(raw);
    if (isLxznCbcsmj) {
      if (siid === 3 && piid === 1) { out.totalKwh = normalizeDeviceTelemetryValue(model, 'totalKwh', numeric); continue; }
      if (siid === 3 && piid === 2) { out.currentA = normalizeDeviceTelemetryValue(model, 'currentA', numeric); continue; }
      if (siid === 3 && piid === 3) { out.voltageV = normalizeDeviceTelemetryValue(model, 'voltageV', numeric); continue; }
      if (siid === 3 && piid === 6) { out.powerW = normalizeDeviceTelemetryValue(model, 'powerW', numeric); continue; }
      continue;
    }
    if (isZNCZ) {
      if (siid === 5 && piid === 2) { out.voltageV = numeric; continue; }
      if (siid === 5 && piid === 3) { out.currentA = numeric; continue; }
      if (siid === 5 && piid === 4) { out.powerW = numeric; continue; }
      if (siid === 5 && piid === 6) { out.totalKwh = numeric; continue; }
      continue;
    }
    if (isBL0937) {
      if (siid === 3 && piid === 1) { out.powerW = numeric; continue; }
      if (siid === 3 && piid === 2) { out.voltageV = numeric; continue; }
      if (siid === 3 && piid === 3) { out.currentA = numeric; continue; }
      if (siid === 3 && piid === 4) { out.totalKwh = numeric; continue; }
      continue;
    }
    if (siid === 3 && piid === 6) { out.powerW = numeric; continue; }
    if (siid === 2 && piid === 4) { out.powerW = numeric; continue; }
    if (siid === 3 && piid === 1) { if (out.powerW == null || !Number.isFinite(out.powerW)) out.powerW = numeric; continue; }
    if (siid === 2 && piid === 2) { out.voltageV = numeric; continue; }
    if (siid === 3 && piid === 3) { if (out.voltageV == null || !Number.isFinite(out.voltageV)) out.voltageV = numeric; continue; }
    if (siid === 2 && piid === 3) { out.currentA = numeric; continue; }
    if (siid === 3 && piid === 2) { if (out.currentA == null || !Number.isFinite(out.currentA)) out.currentA = numeric; continue; }
    if (siid === 2 && piid === 5) { out.totalKwh = numeric; continue; }
    if (siid === 2 && piid === 6) { if (out.totalKwh == null || !Number.isFinite(out.totalKwh)) out.totalKwh = numeric; continue; }
    if (siid === 3 && piid === 4) { if (out.totalKwh == null || !Number.isFinite(out.totalKwh)) out.totalKwh = numeric; continue; }
  }
  if (!hasStandardPower && typeof out.powerW === 'number' && Number.isFinite(out.powerW)) {
    out.power = out.powerW > 0;
  }
  return out;
}

export interface RoomLite {
  id: string;
  roomNumber: string | number | null;
  name: string | null;
}

export interface ExistingDeviceLite {
  did: string;
  roomId: string | null;
}

import { OperationType, DeviceStatus } from '@prisma/client';
import type { XiaomiDeviceInfo } from '@shared/index';
import prisma from '../../../lib/prisma';
import { writeOperation } from '../../../lib/logger';
import type { OperationActorContext } from '../../../lib/operation-log';
import { formatRoomDisplayName } from '../../../lib/room-display';

export function resolveRoomIdForDevice(
  rooms: RoomLite[],
  raw: { did: string; name?: string; room_id?: number | string; parent_id?: string },
  lastRoomMap: Record<string, string | null>,
): string | null {
  if (raw.room_id != null) {
    const num = Number(raw.room_id);
    if (!Number.isNaN(num)) {
      const hit = rooms.find((r) => Number(r.roomNumber) === num);
      if (hit) return hit.id;
    }
  }
  if (raw.did && lastRoomMap[raw.did] !== undefined) return lastRoomMap[raw.did] ?? null;
  if (raw.name) {
    const nameMatch = rooms.find((r) => {
      const rlabel = r.roomNumber
        ? formatRoomDisplayName(String(r.roomNumber), r.name ?? null)
        : '';
      return (
        (r.roomNumber && String(raw.name || '').includes(String(r.roomNumber))) ||
        (r.name && String(raw.name).includes(r.name)) ||
        (rlabel && String(raw.name).includes(rlabel))
      );
    });
    if (nameMatch) return nameMatch.id;
  }
  return null;
}

export function assignFallbackRoomIds(
  devices: Array<{ did: string; roomId: string | null }>,
  rooms: RoomLite[],
  existingDevices: ExistingDeviceLite[],
  lastRoomMap: Record<string, string | null>,
): void {
  const existingRoomMap = new Map(
    existingDevices
      .filter((device) => !!device.roomId)
      .map((device) => [device.did, device.roomId as string]),
  );
  const occupiedRoomIds = new Set<string>();
  for (const device of devices) {
    if (device.roomId) occupiedRoomIds.add(device.roomId);
  }
  for (const device of devices) {
    if (device.roomId) continue;
    const existingRoomId = existingRoomMap.get(device.did);
    if (existingRoomId && rooms.some((room) => room.id === existingRoomId) && !occupiedRoomIds.has(existingRoomId)) {
      device.roomId = existingRoomId;
      occupiedRoomIds.add(existingRoomId);
      lastRoomMap[device.did] = existingRoomId;
    }
  }
  const availableRooms = rooms.filter((room) => !occupiedRoomIds.has(room.id));
  for (const device of devices) {
    if (device.roomId) continue;
    const nextRoom = availableRooms.shift();
    if (!nextRoom) break;
    device.roomId = nextRoom.id;
    lastRoomMap[device.did] = nextRoom.id;
    occupiedRoomIds.add(nextRoom.id);
  }
}

export function buildDeviceInfoItem(
  raw: RawDevice,
  index: number,
  rooms: RoomLite[],
  _existingDevices: ExistingDeviceLite[],
  lastRoomMap: Record<string, string | null>,
  snapshot: DevicePropSnapshot,
  sessionRegion: string | undefined,
  scope: 'main' | 'camera' = 'main',
): XiaomiDeviceInfo {
  const roomId = resolveRoomIdForDevice(rooms, raw, lastRoomMap);
  return {
    did: raw.did,
    name: raw.name ?? raw.model ?? `device_${index + 1}`,
    model: raw.model ?? 'unknown',
    online: raw.isOnline === true || raw.status === 1,
    roomId: roomId ?? null,
    power: snapshot.power,
    powerW: snapshot.powerW,
    currentA: snapshot.currentA,
    voltageV: snapshot.voltageV ?? 220,
    totalKwh: snapshot.totalKwh,
    sourceRegion: sessionRegion || 'cn',
    sourceScope: scope,
    localIp: typeof raw.localip === 'string' ? raw.localip : null,
  };
}

export async function syncXiaomiDevicesToDb(
  devices: XiaomiDeviceInfo[],
  operatorUserId: string | null,
  actorContext?: OperationActorContext,
): Promise<void> {
  if (devices.length === 0) {
    throw new Error('米家登录已建立，但本次没有拉取到任何真实设备。请检查该账号下是否真的已绑定设备，或先完成米家安全验证。');
  }

  const [defaultSite, rooms] = await Promise.all([
    prisma.site.findFirst({
      where: { isPrimary: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.room.findMany({ select: { id: true, siteId: true } }),
  ]);
  const fallbackSiteId = defaultSite?.id;
  if (!fallbackSiteId) {
    throw new Error('系统中尚未配置默认区域，暂时无法同步设备');
  }
  const roomSiteMap = new Map(rooms.map((room) => [room.id, room.siteId]));

  const now = new Date();
  for (const device of devices) {
    const existing = await prisma.device.findUnique({
      where: { did: device.did },
      select: { name: true, siteId: true, powerW: true, currentA: true, voltageV: true, totalKwh: true, power: true },
    });
    const siteId =
      (device.roomId ? roomSiteMap.get(device.roomId) : null) ??
      (device as { siteId?: string | null }).siteId ??
      existing?.siteId ??
      fallbackSiteId;
    const previous = existing as DeviceRuntimePrevious | null;
    const safe = sanitizeRuntimeForUpsert(
      {
        powerW: device.powerW,
        currentA: device.currentA,
        voltageV: device.voltageV,
        totalKwh: device.totalKwh,
        online: device.online,
      },
      previous,
    );

    await prisma.device.upsert({
      where: { did: device.did },
      update: {
        siteId,
        name: existing?.name?.trim() || device.name,
        model: device.model,
        roomId: device.roomId,
        status: safe.online ? DeviceStatus.online : DeviceStatus.offline,
        power: safe.power,
        powerW: safe.powerW,
        currentA: safe.currentA,
        voltageV: safe.voltageV,
        totalKwh: safe.totalKwh,
        lastSyncAt: now,
      },
      create: {
        did: device.did,
        siteId,
        name: device.name,
        model: device.model,
        roomId: device.roomId ?? null,
        status: safe.online ? DeviceStatus.online : DeviceStatus.offline,
        power: safe.power,
        powerW: safe.powerW,
        currentA: safe.currentA,
        voltageV: safe.voltageV,
        totalKwh: safe.totalKwh,
        lastSyncAt: now,
      },
    });
  }

  await writeOperation(
    operatorUserId,
    OperationType.sync_devices,
    null,
    {
      action: 'sync_devices',
      actionLabel: '同步米家设备',
      source: actorContext?.source,
      sourceLabel: actorContext?.sourceLabel,
      totalCount: devices.length,
      note: `同步 ${devices.length} 台设备`,
    },
    true,
  );
}
