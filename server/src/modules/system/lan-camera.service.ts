import { OperationType, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { writeOperation } from '../../lib/logger';
import { OperationActorContext } from '../../lib/operation-log';
import { AppError } from '../../lib/errors';
import { xiaomiAdapter } from './xiaomi.adapter';
import { systemService } from './system.service';
import {
  discoverOnvifDevices,
  guessRtspUrls,
  injectRtspCredentials,
  probeOnvifDevice,
  testRtspSource,
  type OnvifDiscoveredDevice,
  type OnvifProfile,
  type OnvifProbeResult,
  type RtspTestResult,
} from './lib/onvif';
import { DeviceCategory, inferDeviceCategory } from '@shared/index';

/**
 * 局域网（ONVIF/RTSP）摄像头接入服务。
 *
 * 存储方式：复用 Device.model 的 JSON（与项目现有摄像头配置一致），
 * 结构：{ manualCategory: 'camera', source: 'lan_discovery', camera: { lan: {...}, ... } }
 * 不新增数据库字段，避免迁移风险；后续重构时再迁到独立表。
 */

export interface CameraCapabilities {
  ptz: boolean;
  events: boolean;
  motion: boolean;
  human: boolean;
  face: boolean;
  line: boolean;
  intrusion: boolean;
  tamper: boolean;
  objectLeft?: boolean;
  objectRemoved?: boolean;
  smartTracking?: boolean;
  audio: boolean;
  analytics: boolean;
  recording: boolean;
}

export const EMPTY_CAMERA_CAPABILITIES: CameraCapabilities = {
  ptz: false,
  events: false,
  motion: false,
  human: false,
  face: false,
  line: false,
  intrusion: false,
  tamper: false,
  audio: false,
  analytics: false,
  recording: true,
};

function normalizeCapabilities(raw: unknown): CameraCapabilities {
  if (!isRecord(raw)) return { ...EMPTY_CAMERA_CAPABILITIES };
  const bool = (key: keyof CameraCapabilities): boolean => raw[key] === true;
  return {
    ptz: bool('ptz'),
    events: bool('events'),
    motion: bool('motion'),
    human: bool('human'),
    face: bool('face'),
    line: bool('line'),
    intrusion: bool('intrusion'),
    tamper: bool('tamper'),
    audio: bool('audio'),
    analytics: bool('analytics'),
    recording: true,
  };
}

export interface LanCameraConfig {
  source: 'onvif' | 'rtsp';
  ip: string;
  port: number;
  username: string;
  password: string;
  brand: string | null;
  model: string | null;
  rtspUrl: string;
  subRtspUrl: string | null;
  snapshotUrl: string | null;
  hasPTZ: boolean;
  transcodeH264: boolean;
  /** 直播/录像使用子码流（推荐：多数摄像头子码流为 H.264，浏览器兼容性好、省 CPU） */
  preferSubStream: boolean;
  /** ONVIF 自动识别到的智能能力（移动侦测/人形侦测/人脸/越界等） */
  capabilities: CameraCapabilities;
  addedAt: string | null;
  updatedAt: string | null;
}

export interface CameraListItem {
  did: string;
  name: string;
  online: boolean;
  source: 'lan' | 'xiaomi';
  brand: string | null;
  model: string | null;
  localIp: string | null;
  roomId: string | null;
  roomNumber: string | null;
  roomName: string | null;
  hasPTZ: boolean;
  /** 局域网摄像头：是否有可直接播放的 RTSP 源 */
  hasLocalStream: boolean;
  capabilities: CameraCapabilities;
}

export interface CameraListResponse {
  loggedIn: boolean;
  username: string | null;
  region: string | null;
  auth: unknown | null;
  cameras: CameraListItem[];
}

const LAN_CAMERA_DID_PREFIX = 'LAN_CAM_';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseModel(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return isRecord(obj) ? obj : {};
  } catch {
    return {};
  }
}

/** 保证写入 DB 的 model JSON 不会无限膨胀（同时保证永远是合法 JSON） */
function safeStringifyModel(obj: Record<string, unknown>, maxLen = 6000): string {
  const strip = (input: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...input };
    if (isRecord(next.camera)) {
      const cam = { ...(next.camera as Record<string, unknown>) };
      delete cam.snapshotCandidates;
      delete cam._raw;
      next.camera = cam;
    }
    delete next._raw;
    if (Array.isArray(next.capabilities)) next.capabilities = next.capabilities.slice(0, 5);
    return next;
  };
  let current = strip(obj);
  let text = JSON.stringify(current);
  for (let i = 0; i < 5 && text.length > maxLen; i += 1) {
    current = strip(current);
    text = JSON.stringify(current);
  }
  return text;
}

function readLanConfigFromModel(model: string | null | undefined): LanCameraConfig | null {
  const parsed = parseModel(model);
  const cam = isRecord(parsed.camera) ? parsed.camera : null;
  const lan = cam && isRecord(cam.lan) ? cam.lan : null;
  if (!lan) return null;
  const rtspUrl = typeof lan.rtspUrl === 'string' ? lan.rtspUrl.trim() : '';
  const ip = typeof lan.ip === 'string' ? lan.ip.trim() : '';
  if (!rtspUrl && !ip) return null;
  return {
    source: lan.source === 'rtsp' ? 'rtsp' : 'onvif',
    ip,
    port: Number(lan.port) || 80,
    username: typeof lan.username === 'string' ? lan.username : '',
    password: typeof lan.password === 'string' ? lan.password : '',
    brand: typeof lan.brand === 'string' && lan.brand.trim() ? lan.brand.trim() : null,
    model: typeof lan.model === 'string' && lan.model.trim() ? lan.model.trim() : null,
    rtspUrl,
    subRtspUrl: typeof lan.subRtspUrl === 'string' && lan.subRtspUrl.trim() ? lan.subRtspUrl.trim() : null,
    snapshotUrl:
      typeof lan.snapshotUrl === 'string' && lan.snapshotUrl.trim() ? lan.snapshotUrl.trim() : null,
    hasPTZ: lan.hasPTZ === true,
    transcodeH264: lan.transcodeH264 === true,
    preferSubStream: lan.preferSubStream !== false,
    capabilities: normalizeCapabilities(lan.capabilities),
    addedAt: typeof lan.addedAt === 'string' ? lan.addedAt : null,
    updatedAt: typeof lan.updatedAt === 'string' ? lan.updatedAt : null,
  };
}

/** 直播/录像优先使用子码流（若已配置），否则使用主码流 */
function pickLiveRtspUrl(config: LanCameraConfig): string {
  if (config.preferSubStream && config.subRtspUrl) return config.subRtspUrl;
  return config.rtspUrl;
}

function getDeviceModelText(parsed: Record<string, unknown>): string {
  const cam = isRecord(parsed.camera) ? parsed.camera : null;
  const candidates = [
    cam && typeof cam.model === 'string' ? cam.model : null,
    typeof parsed.model === 'string' ? parsed.model : null,
    typeof parsed.vendorName === 'string' ? parsed.vendorName : null,
  ];
  return candidates.map((x) => (x ?? '').trim()).find(Boolean) ?? '';
}

function isCameraLikeDevice(device: {
  name: string;
  model: string | null;
  did: string;
  localip?: string | null;
}): boolean {
  const parsed = parseModel(device.model);
  const manualCategory = typeof parsed.manualCategory === 'string' ? parsed.manualCategory : '';
  if (manualCategory === DeviceCategory.CAMERA) return true;
  if (readLanConfigFromModel(device.model)) return true;
  const category = inferDeviceCategory({
    name: device.name,
    model: getDeviceModelText(parsed) || device.model,
    ip: device.localip ?? null,
  });
  return category === DeviceCategory.CAMERA;
}

function normalizeIp(ip: string): string {
  return String(ip ?? '').trim();
}

function validateIp(ip: string): string {
  const value = normalizeIp(ip);
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(value)) {
    throw new AppError(400, 'INVALID_IP', '请填写正确的 IPv4 地址');
  }
  const parts = value.split('.').map((x) => Number(x));
  if (parts.some((n) => n < 0 || n > 255)) {
    throw new AppError(400, 'INVALID_IP', 'IP 地址每段必须在 0-255 之间');
  }
  return value;
}

function validateStreamUrl(url: string): string {
  const value = String(url ?? '').trim();
  if (!/^(rtsp|http|https):\/\//i.test(value)) {
    throw new AppError(400, 'INVALID_STREAM_URL', '直播地址必须是 rtsp:// 或 http(s):// 开头');
  }
  return value;
}

async function getPrimarySiteId(): Promise<string> {
  const site =
    (await prisma.site.findFirst({
      where: { isPrimary: true },
      select: { id: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })) ??
    (await prisma.site.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }));
  if (!site) throw new AppError(400, 'NO_SITE', '系统中尚未配置默认区域，无法保存摄像头');
  return site.id;
}

function toCameraListItem(device: {
  did: string;
  name: string;
  model: string | null;
  localip: string | null;
  status: string;
  roomId: string | null;
  room: { roomNumber: string; name: string } | null;
}): CameraListItem | null {
  const parsed = parseModel(device.model);
  const lan = readLanConfigFromModel(device.model);
  const isLan = !!lan;
  const isCam = isLan || isCameraLikeDevice(device);
  if (!isCam) return null;
  const cam = isRecord(parsed.camera) ? parsed.camera : null;
  const ownership = typeof parsed.ownership === 'string' ? parsed.ownership : '';
  const source = typeof parsed.source === 'string' ? parsed.source : '';
  const isXiaomi = !isLan && (ownership === 'xiaomi' || source === 'account_sync');
  const brand =
    (cam && typeof cam.brand === 'string' && cam.brand.trim() ? cam.brand.trim() : null) ??
    lan?.brand ??
    (typeof parsed.vendorName === 'string' && parsed.vendorName.trim() ? parsed.vendorName.trim() : null) ??
    null;
  const modelText =
    (cam && typeof cam.model === 'string' && cam.model.trim() ? cam.model.trim() : null) ??
    lan?.model ??
    getDeviceModelText(parsed) ??
    null;
  return {
    did: device.did,
    name: device.name,
    online: device.status === 'online',
    source: isLan ? 'lan' : 'xiaomi',
    brand,
    model: modelText,
    localIp: device.localip ?? lan?.ip ?? null,
    roomId: device.roomId ?? null,
    roomNumber: device.room?.roomNumber ?? null,
    roomName: device.room?.name ?? null,
    hasPTZ: lan?.hasPTZ === true || (cam != null && cam.hasPTZ === true),
    hasLocalStream: !!lan?.rtspUrl,
    capabilities: lan?.capabilities
      ? lan.capabilities
      : {
          ...EMPTY_CAMERA_CAPABILITIES,
          ptz: cam != null && cam.hasPTZ === true,
          motion: cam != null && cam.hasMotion === true,
          audio: cam != null && cam.hasAudio === true,
        },
  };
}

/** 摄像头列表：纯 DB 读取（不调用小米云），保证监控墙在断网时也能打开 */
export async function listCameras(): Promise<CameraListResponse> {
  const [devices, loggedIn, authStatus, session] = await Promise.all([
    prisma.device.findMany({
      include: { room: { select: { roomNumber: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    xiaomiAdapter.isLoggedIn('camera').catch(() => false),
    xiaomiAdapter.getAuthStatus('camera').catch(() => null),
    xiaomiAdapter.peekSession('camera').catch(() => null),
  ]);
  const cameras: CameraListItem[] = [];
  for (const device of devices) {
    const item = toCameraListItem(device);
    if (!item) continue;
    // 小米云摄像头：未登录时直接标记离线（本地 DB 状态可能滞后）
    if (item.source === 'xiaomi' && !loggedIn) item.online = false;
    cameras.push(item);
  }
  // 局域网摄像头排前面（本地优先），同类按名称
  cameras.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'lan' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const auth = (authStatus ?? null) as unknown | null;
  return {
    loggedIn,
    username: session?.username ?? authStatus?.username ?? null,
    region: session?.region ?? (authStatus as { region?: string | null } | null)?.region ?? null,
    auth,
    cameras,
  };
}

/** 局域网 ONVIF 设备发现（组播；失败不影响手动添加） */
export async function discoverCameras(): Promise<{
  devices: OnvifDiscoveredDevice[];
  errorMessage?: string;
}> {
  try {
    const devices = await discoverOnvifDevices(5000);
    return { devices };
  } catch (error: any) {
    return { devices: [], errorMessage: error?.message || String(error) };
  }
}

export interface ProbeCameraInput {
  ip: string;
  port?: number;
  username?: string;
  password?: string;
  brand?: string | null;
  /** 手动指定 RTSP 地址时跳过 ONVIF 探测，直接测流 */
  rtspUrl?: string | null;
}

export interface ProbeCameraResult {
  ok: boolean;
  mode: 'onvif' | 'rtsp';
  ip: string;
  port: number;
  brand: string | null;
  model: string | null;
  manufacturer: string | null;
  hasPTZ: boolean;
  profiles: OnvifProfile[];
  capabilities: CameraCapabilities;
  rtspUrl: string | null;
  subRtspUrl: string | null;
  snapshotUrl: string | null;
  rtspTest: RtspTestResult | null;
  subRtspTest: RtspTestResult | null;
  errorMessage?: string;
  warnings: string[];
}

/**
 * 探测摄像头：优先 ONVIF（拿品牌/型号/主次码流/快照地址），
 * ONVIF 不可用时按品牌模板猜 RTSP 并逐个实测。
 */
export async function probeCamera(input: ProbeCameraInput): Promise<ProbeCameraResult> {
  const ip = validateIp(input.ip);
  const port = Number(input.port) || 80;
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const warnings: string[] = [];

  const base: ProbeCameraResult = {
    ok: false,
    mode: 'onvif',
    ip,
    port,
    brand: input.brand ?? null,
    model: null,
    manufacturer: null,
    hasPTZ: false,
    profiles: [],
    capabilities: { ...EMPTY_CAMERA_CAPABILITIES },
    rtspUrl: null,
    subRtspUrl: null,
    snapshotUrl: null,
    rtspTest: null,
    subRtspTest: null,
    warnings,
  };

  // 手动指定 RTSP 时直接测
  if (input.rtspUrl && input.rtspUrl.trim()) {
    const url = injectRtspCredentials(validateStreamUrl(input.rtspUrl), username, password);
    const test = await testRtspSource(url, 12000);
    return {
      ...base,
      mode: 'rtsp',
      rtspUrl: url,
      rtspTest: test,
      ok: test.ok,
      errorMessage: test.ok ? undefined : test.errorMessage,
    };
  }

  const onvif: OnvifProbeResult = await probeOnvifDevice({ ip, port, username, password });
  if (onvif.ok && onvif.mainRtspUrl) {
    const testedUrl = injectRtspCredentials(onvif.mainRtspUrl, username, password);
    const subTestedUrl = onvif.subRtspUrl
      ? injectRtspCredentials(onvif.subRtspUrl, username, password)
      : null;
    const [test, subTest] = await Promise.all([
      testRtspSource(testedUrl, 12000),
      subTestedUrl ? testRtspSource(subTestedUrl, 12000) : Promise.resolve(null),
    ]);
    if (!test.ok) {
      warnings.push(`ONVIF 取到了地址，但直接测流失败：${test.errorMessage ?? '未知原因'}（也可能是摄像头同一时间只允许一个客户端）`);
    }
    // 很多摄像头 ONVIF 把主码流标成 H264、实际是 H265；浏览器无法直接播放 H265，
    // 这里根据实际探测结果给出提示，并推荐使用 H264 子码流。
    const mainIsHevc = /hevc|h\.?265/i.test(test.videoInfo ?? '');
    const subIsH264 = /h264|avc/i.test(subTest?.videoInfo ?? '');
    if (mainIsHevc && subIsH264) {
      warnings.push('主码流实际为 H.265（浏览器通常无法直接播放），建议勾选「直播使用子码流」');
    }
    return {
      ...base,
      mode: 'onvif',
      brand: onvif.manufacturer ?? input.brand ?? null,
      model: onvif.model,
      manufacturer: onvif.manufacturer,
      hasPTZ: onvif.hasPTZ,
      profiles: onvif.profiles,
      capabilities: { ...onvif.capabilities },
      rtspUrl: testedUrl,
      subRtspUrl: subTestedUrl,
      snapshotUrl: onvif.snapshotUrl,
      rtspTest: test,
      subRtspTest: subTest,
      ok: true,
    };
  }

  // ONVIF 失败：品牌模板兜底（前 3 个候选并行实测，避免串行等待过久）
  const guesses = guessRtspUrls({ ip, brand: input.brand, username, password }).slice(0, 3);
  let lastError = onvif.errorMessage ?? 'ONVIF 探测失败';
  const tested = await Promise.all(
    guesses.map(async (candidate) => ({
      candidate,
      test: await testRtspSource(candidate.url, 8000),
    })),
  );
  for (const { candidate, test } of tested) {
    if (test.ok) {
      return {
        ...base,
        mode: 'rtsp',
        rtspUrl: candidate.url,
        rtspTest: test,
        ok: true,
        warnings: [...warnings, `ONVIF 不可用（${lastError}），已使用 RTSP 模板：${candidate.label}`],
      };
    }
    lastError = test.errorMessage ?? lastError;
  }
  return {
    ...base,
    errorMessage: `连接失败：${lastError}`,
    warnings,
  };
}

export interface SaveLanCameraInput {
  did?: string;
  name?: string;
  ip: string;
  port?: number;
  username?: string;
  password?: string;
  brand?: string | null;
  model?: string | null;
  source?: 'onvif' | 'rtsp';
  rtspUrl: string;
  subRtspUrl?: string | null;
  snapshotUrl?: string | null;
  hasPTZ?: boolean;
  transcodeH264?: boolean;
  preferSubStream?: boolean;
  capabilities?: Partial<CameraCapabilities> | null;
  roomId?: string | null;
}

export interface SaveLanCameraResult {
  did: string;
  name: string;
  isNew: boolean;
  camera: CameraListItem;
}

/** 新增/更新局域网摄像头（新设备自动建 Device 记录） */
export async function saveLanCamera(
  input: SaveLanCameraInput,
  operatorUserId: string | null,
  actorContext?: OperationActorContext,
): Promise<SaveLanCameraResult> {
  const ip = validateIp(input.ip);
  const rtspUrl = validateStreamUrl(input.rtspUrl);
  const port = Number(input.port) || 80;
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const subRtspUrl = input.subRtspUrl ? String(input.subRtspUrl).trim() : null;
  const snapshotUrl = input.snapshotUrl ? String(input.snapshotUrl).trim() : null;
  const brand = input.brand ? String(input.brand).trim() : null;
  const modelText = input.model ? String(input.model).trim() : null;
  const nowIso = new Date().toISOString();

  const orConditions: Prisma.DeviceWhereInput[] = [{ localip: ip }];
  if (input.did) orConditions.unshift({ did: input.did });
  const existing = await prisma.device.findFirst({
    where: { OR: orConditions },
    orderBy: { createdAt: 'asc' },
  });

  const did = existing?.did ?? `${LAN_CAMERA_DID_PREFIX}${ip.replace(/\./g, '_')}`;
  const parsed = parseModel(existing?.model ?? null);
  const prevCamera = isRecord(parsed.camera) ? parsed.camera : {};
  const prevLan = isRecord(prevCamera.lan) ? (prevCamera.lan as Record<string, unknown>) : {};
  const defaultName =
    input.name?.trim() ||
    existing?.name ||
    `${brand || 'ONVIF'} 摄像头 (${ip})`;
  const displayModel = [brand, modelText].filter(Boolean).join(' ').trim() || modelText || brand || 'ONVIF Camera';

  const prevCapabilities = normalizeCapabilities(prevLan.capabilities);
  const capabilities: CameraCapabilities = input.capabilities
    ? normalizeCapabilities({ ...prevCapabilities, ...input.capabilities })
    : prevCapabilities;
  if (input.hasPTZ === true) capabilities.ptz = true;
  const cameraObj: Record<string, unknown> = {
    ...prevCamera,
    online: true,
    brand: brand ?? (typeof prevCamera.brand === 'string' ? prevCamera.brand : null),
    model: displayModel,
    // 以下字段供现有摄像头详情 UI 复用（自动识别到什么就显示什么）
    hasPTZ: capabilities.ptz,
    hasMotion: capabilities.motion || capabilities.human || capabilities.intrusion,
    hasAudio: capabilities.audio,
    hasRecording: true,
    hasNightVision: prevCamera.hasNightVision === true,
    capabilities,
    // 兼容项目原有"手动快照"逻辑：快照地址/认证方式同步进去
    manualSnapshotUrl: snapshotUrl ?? (typeof prevCamera.manualSnapshotUrl === 'string' ? prevCamera.manualSnapshotUrl : null),
    manualAuthUsername: username || (typeof prevCamera.manualAuthUsername === 'string' ? prevCamera.manualAuthUsername : null),
    manualAuthPassword: password || (typeof prevCamera.manualAuthPassword === 'string' ? prevCamera.manualAuthPassword : null),
    manualAuthType: 'digest',
    manualBrand: brand ?? (typeof prevCamera.manualBrand === 'string' ? prevCamera.manualBrand : null),
    manualModel: modelText ?? (typeof prevCamera.manualModel === 'string' ? prevCamera.manualModel : null),
    lan: {
      ...prevLan,
      source: input.source === 'rtsp' ? 'rtsp' : 'onvif',
      ip,
      port,
      username,
      password,
      brand,
      model: modelText,
      rtspUrl,
      subRtspUrl,
      snapshotUrl,
      hasPTZ: capabilities.ptz,
      transcodeH264: input.transcodeH264 === true,
      preferSubStream: input.preferSubStream !== false,
      capabilities,
      addedAt: typeof prevLan.addedAt === 'string' ? prevLan.addedAt : nowIso,
      updatedAt: nowIso,
    },
  };

  const nextModel = safeStringifyModel({
    ...parsed,
    ownership: 'other',
    source: 'lan_discovery',
    manualCategory: DeviceCategory.CAMERA,
    ipAddress: ip,
    vendorName: brand ?? (typeof parsed.vendorName === 'string' ? parsed.vendorName : null),
    model: displayModel,
    camera: cameraObj,
  });

  let saved;
  if (existing) {
    saved = await prisma.device.update({
      where: { did: existing.did },
      data: {
        name: defaultName,
        model: nextModel,
        localip: ip,
        status: 'online',
        lastSyncAt: new Date(),
        offlineSince: null,
        roomId: input.roomId !== undefined ? input.roomId : existing.roomId,
      },
      include: { room: { select: { roomNumber: true, name: true } } },
    });
  } else {
    const siteId = input.roomId
      ? (
          await prisma.room.findUnique({
            where: { id: input.roomId },
            select: { siteId: true },
          })
        )?.siteId ?? (await getPrimarySiteId())
      : await getPrimarySiteId();
    saved = await prisma.device.create({
      data: {
        did,
        siteId,
        name: defaultName,
        model: nextModel,
        localip: ip,
        roomId: input.roomId ?? null,
        status: 'online',
        lastSyncAt: new Date(),
      },
      include: { room: { select: { roomNumber: true, name: true } } },
    });
  }

  // 摄像头参数变化后，旧的 ffmpeg HLS 进程要停掉，避免继续拉旧地址
  try {
    systemService.stopCameraStreamProxy(did);
  } catch {
    /* noop */
  }

  await writeOperation(
    operatorUserId,
    OperationType.update_settings,
    saved.roomId,
    {
      action: existing ? 'update_lan_camera' : 'create_lan_camera',
      actionLabel: existing ? '更新局域网摄像头' : '新增局域网摄像头',
      source: actorContext?.source,
      sourceLabel: actorContext?.sourceLabel,
      did,
      deviceName: saved.name,
      note: `${input.source === 'rtsp' ? 'RTSP' : 'ONVIF'} ${ip}:${port}`,
    },
    true,
  ).catch(() => {});

  const item = toCameraListItem(saved);
  if (!item) throw new AppError(500, 'CAMERA_SAVE_FAILED', '摄像头已保存，但读取设备信息失败');
  return { did, name: saved.name, isNew: !existing, camera: item };
}

/** 删除局域网摄像头：自己创建的设备直接删记录，扫描来的设备只清除摄像头配置 */
export async function deleteLanCamera(
  did: string,
  operatorUserId: string | null,
  actorContext?: OperationActorContext,
): Promise<{ did: string; deleted: boolean }> {
  const existing = await prisma.device.findUnique({
    where: { did },
    select: { did: true, name: true, model: true, roomId: true },
  });
  if (!existing) throw new AppError(404, 'DEVICE_NOT_FOUND', '未找到该摄像头');
  try {
    systemService.stopCameraStreamProxy(did);
    systemService.stopMotionRecording(did);
    systemService.stopContinuousRecording(did);
  } catch {
    /* noop */
  }

  const parsed = parseModel(existing.model);
  const cam = isRecord(parsed.camera) ? parsed.camera : null;
  const isOwnDevice = did.startsWith(LAN_CAMERA_DID_PREFIX);

  if (isOwnDevice) {
    await prisma.device.delete({ where: { did } }).catch(() => {});
  } else if (cam && isRecord(cam.lan)) {
    const nextCamera = { ...cam };
    delete (nextCamera as Record<string, unknown>).lan;
    delete nextCamera.manualSnapshotUrl;
    delete nextCamera.manualAuthUsername;
    delete nextCamera.manualAuthPassword;
    delete nextCamera.manualAuthType;
    await prisma.device.update({
      where: { did },
      data: {
        model: safeStringifyModel({ ...parsed, camera: nextCamera }),
        lastSyncAt: new Date(),
      },
    });
  }

  await writeOperation(
    operatorUserId,
    OperationType.update_settings,
    existing.roomId,
    {
      action: 'delete_lan_camera',
      actionLabel: '删除局域网摄像头',
      source: actorContext?.source,
      sourceLabel: actorContext?.sourceLabel,
      did,
      deviceName: existing.name,
    },
    true,
  ).catch(() => {});

  return { did, deleted: isOwnDevice };
}

/** 读取单台局域网摄像头配置（供 stream/录制/snapshot 复用） */
export async function getLanCameraConfig(did: string): Promise<LanCameraConfig | null> {
  const device = await prisma.device.findUnique({
    where: { did },
    select: { model: true },
  });
  if (!device) return null;
  return readLanConfigFromModel(device.model);
}

const GO2RTC_API_BASE = (process.env.GO2RTC_API_URL || 'http://127.0.0.1:1984').replace(/\/+$/, '');
const GO2RTC_RTSP_BASE = (process.env.GO2RTC_RTSP_BASE || 'rtsp://127.0.0.1:8554').replace(/\/+$/, '');
const go2rtcBridgeCache = new Map<string, { src: string; at: number }>();

/**
 * 把局域网摄像头的 RTSP 注册到本地 go2rtc，并返回 go2rtc 的本地 RTSP 地址。
 *
 * 目的：多数局域网摄像头只允许 1~2 路 RTSP 并发（水星 MIPC852W 上限 2 路）。
 * 直播（HLS 代理）和录像如果各自直连摄像头，很容易把路数占满导致掉线；
 * 统一经 go2rtc 复用后，摄像头只被 go2rtc 拉 1 路，其他消费者都从 go2rtc 取。
 *
 * go2rtc 不可用时自动降级为摄像头直连地址，不影响功能。
 */
async function ensureGo2rtcBridge(did: string, rtspUrl: string): Promise<string> {
  if (!rtspUrl) return rtspUrl;
  const name = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'cam';
  try {
    const cached = go2rtcBridgeCache.get(name);
    if (cached && cached.src === rtspUrl && Date.now() - cached.at < 10 * 60_000) {
      return `${GO2RTC_RTSP_BASE}/${name}`;
    }
    const controller = new AbortController();
    const checkTimer = setTimeout(() => controller.abort(), 3000);
    let needRegister = true;
    try {
      const check = await fetch(`${GO2RTC_API_BASE}/api/streams?src=${encodeURIComponent(name)}`, {
        signal: controller.signal,
      });
      if (check.ok) {
        const info = (await check.json().catch(() => null)) as
          | { producers?: Array<{ url?: string }> }
          | null;
        const producerUrl = info?.producers?.[0]?.url ?? null;
        needRegister = producerUrl !== rtspUrl;
      }
    } catch {
      needRegister = true;
    } finally {
      clearTimeout(checkTimer);
    }
    if (needRegister) {
      const putController = new AbortController();
      const putTimer = setTimeout(() => putController.abort(), 5000);
      try {
        const put = await fetch(
          `${GO2RTC_API_BASE}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(rtspUrl)}`,
          { method: 'PUT', signal: putController.signal },
        );
        if (!put.ok) return rtspUrl;
      } finally {
        clearTimeout(putTimer);
      }
    }
    go2rtcBridgeCache.set(name, { src: rtspUrl, at: Date.now() });
    return `${GO2RTC_RTSP_BASE}/${name}`;
  } catch {
    return rtspUrl;
  }
}

/** 解析局域网摄像头的直播/录像 RTSP 源（优先子码流；经 go2rtc 复用） */
export async function resolveLanCameraRtsp(did: string): Promise<string | null> {
  const config = await getLanCameraConfig(did);
  if (!config) return null;
  const directUrl = pickLiveRtspUrl(config) || null;
  if (!directUrl) return null;
  return ensureGo2rtcBridge(did, directUrl);
}

/** 确保局域网摄像头的 HLS 代理已启动，返回与小米摄像头一致的响应结构 */
export async function ensureLanCameraStream(
  did: string,
  options?: { fresh?: boolean },
): Promise<{
  did: string;
  name: string;
  hlsUrl: string | null;
  hlsReady: boolean;
  proxyMode: 'ffmpeg-hls' | 'none';
  processId: number | null;
  startedAt: number | null;
  ffmpegAvailable: boolean;
  rtspUrl: string;
  errorMessage?: string;
}> {
  const config = await getLanCameraConfig(did);
  if (!config || !config.rtspUrl) {
    throw new AppError(404, 'LAN_CAMERA_NOT_FOUND', '该设备不是已配置的局域网摄像头');
  }
  if (options?.fresh) {
    try {
      systemService.stopCameraStreamProxy(did);
    } catch {
      /* noop */
    }
  }
  const device = await prisma.device.findUnique({ where: { did }, select: { name: true } });
  // 直播源同样走 go2rtc 复用，避免直播 + 录像各自占用摄像头 RTSP 连接
  const liveUrl = await ensureGo2rtcBridge(did, pickLiveRtspUrl(config));
  const stream = await systemService.ensureCameraStreamProxy(did, liveUrl, {
    name: device?.name ?? did,
    transcodeH264: config.transcodeH264,
  });
  let hlsReady = stream.hlsReady;
  if (!hlsReady && stream.processId) {
    hlsReady = await systemService.waitForHlsReadyOrExit(did, 12000);
  }
  if (hlsReady && !stream.hlsReady) {
    // 流已就绪，但第一次返回的 snapshot 状态是旧的，补一次
    const again = await systemService.ensureCameraStreamProxy(did, liveUrl, {
      name: device?.name ?? did,
      transcodeH264: config.transcodeH264,
    });
    return {
      did,
      name: device?.name ?? did,
      hlsUrl: again.hlsUrl,
      hlsReady: true,
      proxyMode: 'ffmpeg-hls',
      processId: again.processId,
      startedAt: again.startedAt,
      ffmpegAvailable: again.ffmpegAvailable,
      rtspUrl: liveUrl,
    };
  }
  if (hlsReady) {
    void markLanCameraOnline(did);
  }
  return {
    did,
    name: device?.name ?? did,
    hlsUrl: hlsReady ? stream.hlsUrl : stream.hlsUrl,
    hlsReady,
    proxyMode: stream.proxyMode === 'none' ? 'none' : 'ffmpeg-hls',
    processId: stream.processId,
    startedAt: stream.startedAt,
    ffmpegAvailable: stream.ffmpegAvailable,
    rtspUrl: liveUrl,
    errorMessage: hlsReady
      ? undefined
      : stream.errorMessage ?? '摄像头流正在连接，请稍后重试（若持续失败请检查 RTSP 地址/账号密码）',
  };
}

/** 测试已保存的局域网摄像头：RTSP 直连 + HLS 代理状态 */
export async function testLanCamera(did: string): Promise<{
  did: string;
  rtspUrl: string | null;
  rtspTest: RtspTestResult | null;
  stream: Awaited<ReturnType<typeof ensureLanCameraStream>> | null;
}> {
  const config = await getLanCameraConfig(did);
  if (!config) throw new AppError(404, 'LAN_CAMERA_NOT_FOUND', '该设备不是已配置的局域网摄像头');
  const liveUrl = pickLiveRtspUrl(config);
  const rtspTest = await testRtspSource(liveUrl, 12000);
  let stream: Awaited<ReturnType<typeof ensureLanCameraStream>> | null = null;
  try {
    stream = await ensureLanCameraStream(did);
  } catch (error: any) {
    stream = null;
  }
  return { did, rtspUrl: liveUrl, rtspTest, stream };
}

/** 摄像头取流/云台成功 → 标记设备在线（修复列表偶发显示离线的问题） */
export async function markLanCameraOnline(did: string): Promise<void> {
  try {
    await prisma.device.update({
      where: { did },
      data: { status: 'online' as any, lastSyncAt: new Date(), offlineSince: null },
    });
  } catch {
    /* 设备不存在或更新失败时忽略 */
  }
}

export const lanCameraService = {
  listCameras,
  discoverCameras,
  probeCamera,
  saveLanCamera,
  deleteLanCamera,
  getLanCameraConfig,
  resolveLanCameraRtsp,
  ensureLanCameraStream,
  testLanCamera,
};
