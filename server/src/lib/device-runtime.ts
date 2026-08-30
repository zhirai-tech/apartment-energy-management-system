import { FiveGCpeRuntime, WifiApRuntime } from '@shared/index';

// 设备离线超过该时长后，仪表盘运行时将其归类为“未分类设备”（上线后自动恢复原分类）。
export const OFFLINE_TO_UNCATEGORIZED_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// 依据设备上一状态与新在线状态，计算应持久化的 offlineSince 时间点。
// 在线 → 清空；离线且此前已记录 → 保留原始离线起始时间（避免每轮探测都重置 24h 计时）。
export function resolveOfflineSince(
  previousStatus: string | null | undefined,
  previousOfflineSince: Date | string | null | undefined,
  online: boolean,
): Date | null {
  if (online) return null;
  if (previousStatus === 'offline' && previousOfflineSince) {
    const existing =
      previousOfflineSince instanceof Date
        ? previousOfflineSince
        : new Date(previousOfflineSince);
    if (!Number.isNaN(existing.getTime())) return existing;
  }
  return new Date();
}

interface ParsedModelLike {
  camera?: unknown;
  wifiAp?: unknown;
  fiveGCpe?: unknown;
  runtime?: unknown;
  [key: string]: unknown;
}

function getSubObject<T extends object = Record<string, unknown>>(
  obj: unknown,
  ...keys: readonly string[]
): T | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (!obj) continue;
    const v = (obj as Record<string, unknown>)[k];
    if (v != null && typeof v === 'object' && !Array.isArray(v)) return v as T;
  }
  return null;
}

export function extractWifiApRuntime(
  parsedModel: ParsedModelLike | null | undefined,
): WifiApRuntime | null {
  return (
    getSubObject<WifiApRuntime>(parsedModel, 'wifiAp') ??
    getSubObject<WifiApRuntime>(getSubObject(parsedModel, 'runtime'), 'wifiAp')
  );
}

export function extractFiveGCpeRuntime(
  parsedModel: ParsedModelLike | null | undefined,
): FiveGCpeRuntime | null {
  return (
    getSubObject<FiveGCpeRuntime>(parsedModel, 'fiveGCpe') ??
    getSubObject<FiveGCpeRuntime>(getSubObject(parsedModel, 'runtime'), 'fiveGCpe')
  );
}

export interface DeviceCameraRuntime {
  online: boolean;
  snapshotUrl: string | null;
  streamUrl: null;
  hdStreamUrl: null;
  brand: string | null;
  model: string | null;
  hasAudio?: boolean;
  hasNightVision?: boolean;
  hasMotion?: boolean;
  hasRecording?: boolean;
  hasPTZ?: boolean;
  lastMotionAt: string | null;
}

interface CameraCapabilities {
  hasAudio?: boolean;
  hasNightVision?: boolean;
  hasMotion?: boolean;
  hasRecording?: boolean;
  hasPTZ?: boolean;
}

// 已知米家摄像头型号的能力映射（仅标注可确认的能力，未列出的能力返回 undefined，前端会隐藏对应按钮）。
export function cameraCapabilitiesForModel(model: string | null | undefined): CameraCapabilities {
  const m = String(model ?? '').toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => m.includes(k));
  // Xiaomi Smart Camera C301 (MBC23) / C300：2K 室内机，双向语音、红外夜视、移动侦测、microSD 本地存储。
  if (has('c301', 'mbc23', 'c300', 'mxiang.camera', 'xiaomi.camera.c301')) {
    return { hasAudio: true, hasNightVision: true, hasMotion: true, hasRecording: true };
  }
  return {};
}

function isXiaomiCameraModel(parsedModel: ParsedModelLike, model: string | null): boolean {
  return (
    parsedModel.ownership === 'xiaomi' ||
    (typeof (parsedModel as any).xiaomiDid === 'string' && !!((parsedModel as any).xiaomiDid as string).trim()) ||
    /mxiang\.camera|xiaomi\.camera|mbc23|c30[01]|c200|aw20[0-9]|aw30[0-9]|mjsxj/i.test(String(model ?? ''))
  );
}

export function extractCameraRuntime(
  parsedModel: ParsedModelLike | null | undefined,
  prismaStatus: 'online' | 'offline' | 'unknown',
): DeviceCameraRuntime | null {
  if (!parsedModel) return null;
  const modelOfDevice =
    typeof (parsedModel as any).model === 'string' ? (parsedModel as any).model : null;
  const caps = cameraCapabilitiesForModel(modelOfDevice);
  const c = getSubObject(parsedModel, 'camera');

  // 米家云摄像头（如 C301）model 中可能没有 camera 子对象，按型号补充已知能力。
  if (!c) {
    if (!isXiaomiCameraModel(parsedModel, modelOfDevice)) return null;
    const brand = typeof (parsedModel as any).brand === 'string' ? (parsedModel as any).brand : null;
    return {
      online: prismaStatus === 'online',
      snapshotUrl: null,
      streamUrl: null,
      hdStreamUrl: null,
      brand,
      model: modelOfDevice,
      hasAudio: caps.hasAudio,
      hasNightVision: caps.hasNightVision,
      hasMotion: caps.hasMotion,
      hasRecording: caps.hasRecording,
      hasPTZ: caps.hasPTZ,
      lastMotionAt: null,
    };
  }

  const candidates = Array.isArray((c as any).snapshotCandidates) ? (c as any).snapshotCandidates : null;
  const manualUrl = typeof (c as any).manualSnapshotUrl === 'string' ? (c as any).manualSnapshotUrl : null;
  const firstHttp =
    manualUrl && /^https?:/i.test(manualUrl)
      ? { url: manualUrl }
      : (candidates as Array<Record<string, unknown>> | null)?.find(
          (x) => typeof x?.url === 'string' && /^https?:/i.test(x.url as string),
        );
  const brandRaw =
    typeof (c as any).manualBrand === 'string' ? (c as any).manualBrand : (c as any).brand;
  const modelRaw =
    typeof (c as any).manualModel === 'string' ? (c as any).manualModel : (c as any).model;
  const onlineField = !!(c as any).online;
  const boolOf = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    online: prismaStatus === 'online' && onlineField,
    snapshotUrl: firstHttp && typeof firstHttp.url === 'string' ? firstHttp.url : null,
    streamUrl: null,
    hdStreamUrl: null,
    brand: typeof brandRaw === 'string' ? brandRaw : null,
    model: typeof modelRaw === 'string' ? modelRaw : null,
    hasAudio: boolOf((c as any).hasAudio) ?? caps.hasAudio,
    hasNightVision: boolOf((c as any).hasNightVision) ?? caps.hasNightVision,
    hasMotion: boolOf((c as any).hasMotion) ?? caps.hasMotion,
    hasRecording: boolOf((c as any).hasRecording) ?? caps.hasRecording,
    hasPTZ: boolOf((c as any).hasPTZ) ?? caps.hasPTZ,
    lastMotionAt: typeof (c as any).lastMotionAt === 'string' ? (c as any).lastMotionAt : null,
  };
}
