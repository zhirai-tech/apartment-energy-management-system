import { FiveGCpeRuntime, WifiApRuntime, DeviceCategory } from '@shared/index';

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
  lastMotionAt: string | null;
}

export function extractCameraRuntime(
  parsedModel: ParsedModelLike | null | undefined,
  prismaStatus: 'online' | 'offline' | 'unknown',
): DeviceCameraRuntime | null {
  const c = getSubObject(parsedModel, 'camera');
  if (!c) return null;
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
  return {
    online: prismaStatus === 'online' && onlineField,
    snapshotUrl: firstHttp && typeof firstHttp.url === 'string' ? firstHttp.url : null,
    streamUrl: null,
    hdStreamUrl: null,
    brand: typeof brandRaw === 'string' ? brandRaw : null,
    model: typeof modelRaw === 'string' ? modelRaw : null,
    hasAudio: typeof (c as any).hasAudio === 'boolean' ? (c as any).hasAudio : undefined,
    hasNightVision:
      typeof (c as any).hasNightVision === 'boolean' ? (c as any).hasNightVision : undefined,
    lastMotionAt: typeof (c as any).lastMotionAt === 'string' ? (c as any).lastMotionAt : null,
  };
}

export function deviceMatchesCategory(
  parsedModel: ParsedModelLike | null | undefined,
  category: DeviceCategory | string,
): boolean {
  if (!parsedModel) return false;
  switch (String(category)) {
    case String(DeviceCategory.CAMERA):
      return !!getSubObject(parsedModel, 'camera');
    case String(DeviceCategory.WIFI_AP):
      return !!extractWifiApRuntime(parsedModel);
    case String(DeviceCategory.FIVE_G_CPE):
      return !!extractFiveGCpeRuntime(parsedModel);
    default:
      return false;
  }
}
