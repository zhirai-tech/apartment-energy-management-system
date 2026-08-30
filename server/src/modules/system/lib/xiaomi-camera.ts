import { XiaomiDeviceInfo, inferDeviceCategory, DeviceCategory } from '@shared/index';
import prisma from '../../../lib/prisma';
import { AppError } from '../../../lib/errors';
import { cameraCapabilitiesForModel } from '../../../lib/device-runtime';
import { buildApiBaseUrl, type XiaomiSession, type XiaomiSessionScope } from './xiaomi-auth';
import { type RawDevice } from './xiaomi-devices';

const DEVICE_LIST_URL = 'https://api.io.mi.com/app/home/device_list';

// ──────────────── Camera capability probe types ────────────────
export interface CameraCapabilityState {
  supported: boolean;
  controllable: boolean;
  state?: boolean | string | number | null;
  hint?: string;
}

export interface CameraCapabilitiesProbe {
  controlMode: 'xiaomi-cloud' | 'local' | 'none';
  ptz: CameraCapabilityState & { calibrate: boolean; directions: string[] };
  nightVision: CameraCapabilityState;
  audio: CameraCapabilityState;
  humanDetection: CameraCapabilityState;
  motionDetection: CameraCapabilityState;
  faceRecognition: CameraCapabilityState;
  privacy: CameraCapabilityState;
  recording: CameraCapabilityState;
  snapshot: CameraCapabilityState;
  fetchedAt: number;
}

/** XiaomiCamera 对宿主 XiaomiAdapter 的最小依赖集 */
export interface XiaomiCameraHost {
  getSession(scope: XiaomiSessionScope): Promise<XiaomiSession | null>;
  requestIo(
    session: XiaomiSession,
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, any>,
    body?: any,
  ): Promise<any>;
  resolveRoomId(rooms: { id: string; roomNumber: string; name: string }[], raw: RawDevice): string | null;
}

// 摄像头云 API 职责（RTSP/HLS/PTZ/能力探测/设备列表）独立模块，
// 通过 XiaomiCameraHost 回调复用宿主适配器的会话与请求能力。
export class XiaomiCamera {
  private cameraCapabilityCache = new Map<string, { at: number; data: CameraCapabilitiesProbe }>();
  private hlsUrlCache = new Map<string, { url: string; at: number }>();
  // 摄像头设备列表缓存：前端每 ~15s 轮询一次（broadcastDashboard → refreshAllRoomsRealtime），
  // 每次都打多个区域端点既浪费又可能触发账号级限流；60s 内复用列表即可。
  private cameraDevicesCache: { at: number; devices: XiaomiDeviceInfo[] } | null = null;
  private static CAMERA_DEVICES_TTL_MS = 60_000;
  private static CAP_TTL_MS = 60_000;
  // 云端 HLS 会话时效通常较短；TTL 太长会把已失效的 URL 复用给前端导致黑屏。
  private static HLS_TTL_MS = 45_000;

  constructor(private readonly host: XiaomiCameraHost) {}

  // ──────────────── MiOT Spec Action generic wrapper ────────────────

  public async callDeviceAction(
    did: string,
    siid: number,
    aiid: number,
    input: any[] = [],
    scope: XiaomiSessionScope = 'main',
  ): Promise<any> {
    const session = await this.host.getSession(scope);
    if (!session) {
      throw new AppError(400, 'XIAOMI_NOT_LOGGED_IN', `米家${scope === 'camera' ? '摄像头区' : ''}未登录，无法调用设备 Action`);
    }
    if (/^mock_/.test(session.serviceToken)) {
      throw new AppError(400, 'XIAOMI_SESSION_INVALID', `当前米家${scope === 'camera' ? '摄像头区' : ''}会话不是真实会话`);
    }
    const path = '/app/miotspec/action';
    // MiOT /app/miotspec/action 的 body 为 { params: { did, siid, aiid, in } }（单个对象），
    // 扁平 { did, siid, aiid, in } → code=-6，数组 { params: [...] } → code=-8
    const payload = { params: { did, siid, aiid, in: input } };
    const result = await this.host.requestIo(session, 'POST', path, undefined, payload);
    return result;
  }

  // ──────────────── Camera Spec mapping (MBC23 / C300 / C200 etc.) ────────────────

  private getCameraSpecForModel(model: string): {
    rtsp: { siid: number; aiid_start: number; aiid_stop?: number; input?: any[] };
    ptz?: { siid: number; aiid_move: number; aiid_stop?: number };
  } {
    const m = (model || '').toLowerCase();
    // 米家摄像头云端 RTSP 启动统一在「camera-stream-for-amazon-alexa」服务：
    //   siid=19, aiid=1 = start-rtsp-stream
    //   入参 [视频编码属性]（1=1920_1080_30，2=1280_720_30）
    // 旧映射 siid=18 会返回 code=-6 / -8
    // Xiaomi Smart Camera C301 (MBC23) - EU version
    if (m.includes('mbc23') || m.includes('c301') || m.includes('xiaomi.camera.c301')) {
      return {
        rtsp: { siid: 19, aiid_start: 1, input: [1] },
        ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
      };
    }
    // Xiaomi Outdoor Camera AW200 / AW300
    if (m.includes('aw200') || m.includes('aw300') || m.includes('aw301')) {
      return {
        rtsp: { siid: 19, aiid_start: 1, input: [1] },
      };
    }
    // Xiaomi Camera C200 (MJSXJ03HL)
    if (m.includes('mjsxj03hl') || m.includes('c200')) {
      return {
        rtsp: { siid: 19, aiid_start: 1, input: [1] },
        ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
      };
    }
    // Mi Home Security Camera 360° 1080P (MJSXJ05CM / MJSXJ02CM)
    if (m.includes('mjsxj05cm') || m.includes('mjsxj02cm') || m.includes('2k') || m.includes('360')) {
      return {
        rtsp: { siid: 19, aiid_start: 1, input: [1] },
        ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
      };
    }
    // Default generic camera Spec (shared by most Xiaomi cameras)
    return {
      rtsp: { siid: 19, aiid_start: 1, input: [1] },
      ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
    };
  }

  // ──────────────── Camera: start / stop RTSP stream ────────────────

  public async startRTSPStream(
    did: string,
    model: string = '',
    scope: XiaomiSessionScope = 'camera',
  ): Promise<{
    streamAddress: string;
    streamAuthToken: string;
    rtspUrl: string;
    snapshotUrl: string;
    rawResult: any;
  }> {
    const spec = this.getCameraSpecForModel(model);
    const raw = await this.callDeviceAction(did, spec.rtsp.siid, spec.rtsp.aiid_start, spec.rtsp.input ?? [], scope);
    // Xiaomi usually returns the result in {result: {out: [...]}} or directly as an array
    let outArr: any[] = [];
    if (Array.isArray(raw)) outArr = raw;
    else if (Array.isArray(raw?.out)) outArr = raw.out;
    else if (Array.isArray(raw?.result?.out)) outArr = raw.result.out;
    else if (raw && typeof raw === 'object') {
      const vals = Object.values(raw);
      const arr = vals.find((v: any) => Array.isArray(v)) as any[] | undefined;
      if (arr) outArr = arr;
    }
    // out[0] = 流地址；out[1] 可能是鉴权 token（局域网直连）或快照 URL（云端转码流）
    const streamAddress = String(
      outArr[0] ?? raw?.stream_address ?? raw?.['stream-address'] ?? raw?.address ?? '',
    ).trim();
    const second = String(outArr[1] ?? '').trim();
    const isSecondUrl = /^(https?|rtsp):\/\//i.test(second);
    const streamAuthToken = isSecondUrl
      ? ''
      : String(outArr[1] ?? raw?.stream_auth_token ?? raw?.['stream-auth-token'] ?? raw?.token ?? '').trim();
    const snapshotUrl = isSecondUrl
      ? second
      : String(raw?.image_snapshot ?? raw?.['image-snapshot'] ?? '').trim();
    if (!streamAddress) {
      console.error('[XiaomiAdapter] startRTSPStream 未解析到 streamAddress，原始返回：', JSON.stringify(raw).slice(0, 800));
      throw new Error('米家摄像头未返回 stream_address，请确认设备型号与 Spec 映射是否匹配');
    }
    // Build an authenticated RTSP URL (only inject basic auth when a real token exists)
    let rtspUrl = streamAddress;
    if (streamAuthToken) {
      try {
        const u = new URL(streamAddress);
        u.username = 'admin';
        u.password = streamAuthToken;
        rtspUrl = u.toString();
      } catch {
        rtspUrl = streamAddress.includes('rtsp://')
          ? streamAddress.replace('rtsp://', `rtsp://admin:${encodeURIComponent(streamAuthToken)}@`)
          : streamAddress;
      }
    }
    // 小米云端 RTSP 走 443 端口（TLS 加密），必须用 rtsps:// 协议才能建立连接
    if (/^rtsp:\/\//i.test(rtspUrl)) {
      const hostPort = rtspUrl.replace(/^rtsp:\/\//i, '').split('/')[0];
      if (/:443$/i.test(hostPort)) {
        rtspUrl = rtspUrl.replace(/^rtsp:\/\//i, 'rtsps://');
      }
    }
    return {
      streamAddress,
      streamAuthToken,
      rtspUrl,
      snapshotUrl,
      rawResult: raw,
    };
  }

  // ──────────────── Camera: start HLS stream (Google Home) ────────────────

  public async startHLSStream(
    did: string,
    scope: XiaomiSessionScope = 'camera',
  ): Promise<{ hlsUrl: string; rawResult: any }> {
    // Google Home 集成：camera-stream-for-google-home (siid=20), start-hls-stream (aiid=1)
    const raw = await this.callDeviceAction(did, 20, 1, [1], scope);
    console.info('[XiaomiAdapter] startHLSStream raw did=', did, '=', JSON.stringify(raw).slice(0, 1200));
    let outArr: any[] = [];
    if (Array.isArray(raw)) outArr = raw;
    else if (Array.isArray(raw?.out)) outArr = raw.out;
    else if (Array.isArray(raw?.result?.out)) outArr = raw.result.out;
    else if (raw && typeof raw === 'object') {
      const vals = Object.values(raw);
      const arr = vals.find((v: any) => Array.isArray(v)) as any[] | undefined;
      if (arr) outArr = arr;
    }
    const hlsUrl = String(outArr[0] ?? '').trim();
    return { hlsUrl, rawResult: raw };
  }

  // ──────────────── Camera: PTZ control ────────────────

  public async moveCameraPTZ(
    did: string,
    direction: 'left' | 'right' | 'up' | 'down' | 'stop',
    speed: number = 50,
    model: string = '',
    scope: XiaomiSessionScope = 'camera',
  ): Promise<boolean> {
    const spec = this.getCameraSpecForModel(model);
    if (!spec.ptz) {
      throw new Error(`当前摄像头型号 ${model} 未配置云台 Spec 映射`);
    }
    // PTZ move input:
    // [0] = direction: 0=left,1=right,2=up,3=down, or a string
    // [1] = speed: 0-100
    const dirMap: Record<string, number> = { left: 0, right: 1, up: 2, down: 3 };
    if (direction === 'stop') {
      const aiid = spec.ptz.aiid_stop ?? spec.ptz.aiid_move;
      try {
        await this.callDeviceAction(did, spec.ptz.siid, aiid, [], scope);
        return true;
      } catch {
        await this.callDeviceAction(did, spec.ptz.siid, spec.ptz.aiid_move, [4, 0], scope);
        return true;
      }
    }
    const dirCode = dirMap[direction];
    if (dirCode === undefined) throw new Error(`未知云台方向：${direction}`);
    const speedSafe = Math.max(0, Math.min(100, Number(speed) || 50));
    await this.callDeviceAction(did, spec.ptz.siid, spec.ptz.aiid_move, [dirCode, speedSafe], scope);
    return true;
  }

  // ──────────────── Camera: PTZ 回中/校准 ────────────────
  // C301 云 API 只暴露 camera-control(siid=2) → ptz-calibrate(aiid=1)，无方向控制动作。
  public async calibrateCameraPTZ(did: string, scope: XiaomiSessionScope = 'camera'): Promise<boolean> {
    await this.callDeviceAction(did, 2, 1, [], scope);
    return true;
  }

  // ──────────────── Camera region: fetch camera device list ────────────────

  public async fetchCameraDevices(): Promise<XiaomiDeviceInfo[]> {
    // 60s 缓存：避免 broadcastDashboard（~15s 一次）每次都触发多区域探测
    if (
      this.cameraDevicesCache &&
      Date.now() - this.cameraDevicesCache.at < XiaomiCamera.CAMERA_DEVICES_TTL_MS
    ) {
      return this.cameraDevicesCache.devices;
    }
    const session = await this.host.getSession('camera');
    console.info('[XiaomiAdapter.fetchCameraDevices] 诊断入参：', {
      hasSession: !!session,
      region: session?.region ?? null,
      userId: session?.userId ?? null,
      mock: session?.serviceToken ? /^mock_/.test(session.serviceToken) : null,
      apiBase: session ? buildApiBaseUrl(session.region) : null,
    });
    if (!session || /^mock_/.test(session.serviceToken)) {
      return [];
    }
    const rooms = await prisma.room.findMany({ select: { id: true, roomNumber: true, name: true } });
    const listReal: XiaomiDeviceInfo[] = [];
    const isIntlRegion = !!(session.region && session.region.toLowerCase() !== 'cn');
    try {
      const ioPathOptions = isIntlRegion
        ? ['/home/device_list', '/app/home/device_list']
        : [DEVICE_LIST_URL.replace(/^https:\/\/api\.io\.mi\.com/, '')];
      const bodyVariants = isIntlRegion
        ? [
          { getVirtualModel: false, getHuamiDevices: 0, getSplitHumanDeviceInfos: 1 },
          { getVirtualModel: true, getHuamiDevices: 1, getSplitHumanDeviceInfos: 1 },
          { getVirtualModel: false, getHuamiDevices: 0 },
        ]
        : [
          { getVirtualModel: false, getHuamiDevices: 0 },
        ];
      let list: RawDevice[] | null = null;
      let finalPath: string | null = null;
      let finalBody: any = null;
      let finalRaw: any = null;
      endpointLoop:
      for (const ioPath of ioPathOptions) {
        const fullUrl = `${buildApiBaseUrl(session.region)}${ioPath.startsWith('/') ? '' : '/'}${ioPath}`;
        for (const body of bodyVariants) {
          console.info('[XiaomiAdapter.fetchCameraDevices] EU 探测尝试：', {
            region: session.region,
            ioPath,
            fullUrl,
            body,
          });
          try {
            const deviceResponse = (await this.host.requestIo(session, 'POST', ioPath, undefined, body)) as unknown;
            const head = JSON.stringify(deviceResponse ?? {}).slice(0, 1500);
            console.info('[XiaomiAdapter.fetchCameraDevices] EU 探测返回：', { ioPath, body, head });
            const devicePayload = deviceResponse as {
              list?: RawDevice[];
              result?: { list?: RawDevice[]; device_list?: RawDevice[] };
              device_list?: RawDevice[];
            } | RawDevice[] | null;
            const tryList: RawDevice[] | null = Array.isArray(devicePayload)
              ? devicePayload
              : Array.isArray(devicePayload?.list) && devicePayload.list.length > 0
                ? devicePayload.list
                : Array.isArray(devicePayload?.device_list) && devicePayload.device_list.length > 0
                  ? devicePayload.device_list
                  : Array.isArray(devicePayload?.result?.list) && devicePayload.result.list.length > 0
                    ? devicePayload.result.list
                    : Array.isArray(devicePayload?.result?.device_list) && devicePayload.result.device_list.length > 0
                      ? devicePayload.result.device_list
                      : Array.isArray(devicePayload?.list)
                        ? devicePayload.list
                        : Array.isArray(devicePayload?.result?.list)
                          ? devicePayload.result.list
                          : Array.isArray(devicePayload?.result?.device_list)
                            ? devicePayload.result.device_list
                            : Array.isArray(devicePayload?.device_list)
                              ? devicePayload.device_list
                              : null;
            if (tryList && tryList.length > 0) {
              list = tryList;
              finalPath = ioPath;
              finalBody = body;
              finalRaw = deviceResponse;
              break endpointLoop;
            }
            if (!list && tryList) {
              list = tryList;
              finalPath = ioPath;
              finalBody = body;
              finalRaw = deviceResponse;
            }
          } catch (probeErr: any) {
            console.warn('[XiaomiAdapter.fetchCameraDevices] EU 探测失败：', {
              ioPath, body, msg: probeErr?.message,
            });
          }
        }
      }
      console.info('[XiaomiAdapter.fetchCameraDevices] EU 探测完成：', {
        isIntlRegion,
        finalPath,
        finalBody,
        finalLen: list?.length ?? null,
        firstDevice: list && list.length > 0
          ? { did: list[0].did, name: list[0].name, model: list[0].model, isOnline: (list[0] as any).isOnline ?? null }
          : null,
        finalRawKeys: finalRaw && typeof finalRaw === 'object' ? Object.keys(finalRaw as Record<string, any>) : null,
        finalHead: finalRaw ? JSON.stringify(finalRaw).slice(0, 2400) : null,
      });
      if (Array.isArray(list) && list.length > 0) {
        for (let i = 0; i < list.length; i++) {
          const raw = list[i];
          const roomId = this.host.resolveRoomId(rooms, raw);
          listReal.push({
            did: raw.did,
            name: raw.name ?? raw.model ?? `camera_${i + 1}`,
            model: raw.model ?? 'unknown',
            online: raw.isOnline === true || raw.status === 1,
            roomId,
            localIp: raw.localip,
            sourceRegion: session?.region || 'de',
            sourceScope: 'camera',
          });
        }
      }
    } catch (err: any) {
      console.warn(
        '[XiaomiAdapter] fetchCameraDevices 失败：',
        err?.message,
        '\n  stack=',
        err?.stack ?? '',
      );
    }
    const result = listReal.sort((a, b) => {
      const aCam = inferDeviceCategory({ name: a.name, model: a.model }) === DeviceCategory.CAMERA ? 0 : 1;
      const bCam = inferDeviceCategory({ name: b.name, model: b.model }) === DeviceCategory.CAMERA ? 0 : 1;
      if (aCam !== bCam) return aCam - bCam;
      return Number(b.online === true) - Number(a.online === true);
    });
    this.cameraDevicesCache = { at: Date.now(), devices: result };
    return result;
  }

  // ──────────────── Camera: capability probing (auto-detect & degrade) ────────────────

  // 从 device.model 解析原始型号字符串：model 可能为 JSON（含 xiaomiDid/model）或直接是型号文本
  private resolveRawModel(model: string): string {
    try {
      const parsed = model ? JSON.parse(model) : null;
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).model === 'string' && (parsed as any).model.trim()) {
        return (parsed as any).model.trim();
      }
    } catch {
      /* 不是 JSON，直接按型号文本处理 */
    }
    return model ?? '';
  }

  // 探测摄像头真实能力。识别到的能力前端显示对应控制按钮；识别不到的降级为 hint 提示。
  public async probeCameraCapabilities(
    did: string,
    model: string = '',
    scope: XiaomiSessionScope = 'camera',
  ): Promise<CameraCapabilitiesProbe> {
    const cacheKey = `${scope}:${did}`;
    const cached = this.cameraCapabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.at < XiaomiCamera.CAP_TTL_MS) return cached.data;
    const probe = await this.probeCameraCapabilitiesUncached(did, model, scope);
    this.cameraCapabilityCache.set(cacheKey, { at: Date.now(), data: probe });
    return probe;
  }

  public invalidateCapabilityCache(did: string, scope: XiaomiSessionScope = 'camera'): void {
    this.cameraCapabilityCache.delete(`${scope}:${did}`);
  }

  private async probeCameraCapabilitiesUncached(
    did: string,
    model: string,
    scope: XiaomiSessionScope,
  ): Promise<CameraCapabilitiesProbe> {
    // device.model 可能存的是 JSON（含 xiaomiDid / model），先解析出原始型号字符串
    const rawModel = this.resolveRawModel(model);
    const base = cameraCapabilitiesForModel(rawModel);
    const m = String(rawModel || '').toLowerCase();
    // 已知云台机型（360/云台系列）：云端仅暴露 calibrate（回中），方向转动不可用
    const knownPtz = ['mbc23', 'c301', 'c300', 'c200', 'mjsxj02', 'mjsxj03', 'mjsxj05', 'aw20', 'aw30', '360', 'xiaomi.camera']
      .some((k) => m.includes(k));

    // 尽力读取 camera-control(siid=2) 属性，能读到的记为"有状态可读"，读不到不影响结论
    let readOk = false;
    try {
      const session = await this.host.getSession(scope);
      if (session && !/^mock_/.test(session.serviceToken)) {
        const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((piid) => ({ did, siid: 2, piid }));
        const resp = await this.host.requestIo(session, 'POST', '/app/miotspec/prop/get', {}, { params: payload });
        const items = Array.isArray(resp)
          ? resp
          : Array.isArray((resp as any)?.list)
            ? (resp as any).list
            : Array.isArray((resp as any)?.result)
              ? (resp as any).result
              : Array.isArray((resp as any)?.result?.list)
                ? (resp as any).result.list
                : [];
        readOk = Array.isArray(items) && items.some((it: any) => it?.piid !== undefined && (it.code === 0 || it.value !== undefined));
      }
    } catch {
      readOk = false;
    }

    const mkCap = (
      supported: boolean | undefined,
      controllable: boolean,
      hint?: string,
      state?: unknown,
    ): CameraCapabilityState => {
      const s = !!supported;
      return {
        supported: s,
        controllable: s && controllable,
        state: s && state !== undefined ? (state as any) : undefined,
        hint: s && !controllable ? hint : undefined,
      };
    };

    const now = Date.now();
    return {
      controlMode: 'xiaomi-cloud',
      ptz: {
        supported: knownPtz,
        controllable: false,
        calibrate: knownPtz,
        directions: [],
        hint: knownPtz ? '方向控制不可用 · 仅支持云台回中' : undefined,
      },
      nightVision: mkCap(base.hasNightVision, false, '设备支持夜视，云端暂不可控，可在米家 App 操作', readOk ? null : undefined),
      audio: mkCap(base.hasAudio, false, '设备支持语音，云端暂不可控，可在米家 App 操作', readOk ? null : undefined),
      humanDetection: mkCap(base.hasMotion, false, '设备内置人形侦测，云端暂不可控', readOk ? null : undefined),
      motionDetection: mkCap(base.hasMotion, false, '设备支持移动侦测，云端暂不可控', readOk ? null : undefined),
      faceRecognition: mkCap(false, false),
      privacy: mkCap(false, false),
      recording: { supported: true, controllable: true },
      snapshot: { supported: true, controllable: true },
      fetchedAt: now,
    };
  }

  // 通用能力控制：对可控能力下发真实指令；不可控能力返回明确错误供前端降级。
  public async controlCameraCapability(
    did: string,
    model: string,
    scope: XiaomiSessionScope,
    capability: string,
    value?: unknown,
  ): Promise<{ ok: boolean; state?: unknown; hint?: string }> {
    const probe = await this.probeCameraCapabilities(did, model, scope);
    const entry = (probe as unknown as Record<string, CameraCapabilityState>)[capability];
    if (!entry || !entry.supported) {
      throw new AppError(400, 'CAPABILITY_UNSUPPORTED', `该摄像头不支持功能：${capability}`);
    }
    if (!entry.controllable) {
      throw new AppError(400, 'CAPABILITY_NOT_CONTROLLABLE', entry.hint || '该能力当前接入方式暂不可控');
    }
    // 预留扩展：局域网控制通道（ONVIF / RTSP 控制）在此实现，能力探测结果会相应返回 controllable=true
    throw new AppError(400, 'CAPABILITY_NOT_CONTROLLABLE', entry.hint || '该能力当前接入方式暂不可控');
  }

  // 获取设备 MiOT V1 token（供 go2rtc 等局域网拉流工具使用，避免依赖云端 CDN）
  public async getDeviceMiotToken(
    did: string,
    scope: XiaomiSessionScope = 'camera',
  ): Promise<string> {
    const session = await this.host.getSession(scope);
    if (!session || /^mock_/.test(session.serviceToken)) {
      throw new AppError(400, 'XIAOMI_NOT_LOGGED_IN', '米家未登录，无法获取设备 token');
    }
    const resp = await this.host.requestIo(session, 'POST', '/v1/miotspec/token', undefined, { params: { did } });
    let token = '';
    if (resp && typeof resp === 'object') {
      const r = resp as Record<string, any>;
      token = r.token ?? r.result?.token ?? r.result ?? '';
      if (typeof token !== 'string') token = String(token);
    }
    if (!token) {
      console.warn('[XiaomiAdapter] getDeviceMiotToken 未解析到 token，resp=', JSON.stringify(resp).slice(0, 600));
    }
    return token;
  }

  // ──────────────── Camera: HLS URL short-lived caching ────────────────
  // 云端 HLS 会话短时效且每次 start 都会新建云端会话；在 TTL 内复用同一 URL，
  // 减少云端会话泛滥、避免前端每次刷新都换地址导致画面中断。

  public async startHLSStreamCached(
    did: string,
    scope: XiaomiSessionScope = 'camera',
  ): Promise<{ hlsUrl: string; cached: boolean }> {
    const key = `${scope}:${did}`;
    const cached = this.hlsUrlCache.get(key);
    if (cached && Date.now() - cached.at < XiaomiCamera.HLS_TTL_MS) {
      return { hlsUrl: cached.url, cached: true };
    }
    const { hlsUrl } = await this.startHLSStream(did, scope);
    if (hlsUrl) this.hlsUrlCache.set(key, { url: hlsUrl, at: Date.now() });
    return { hlsUrl, cached: false };
  }

  public invalidateHlsCache(did: string, scope: XiaomiSessionScope = 'camera'): void {
    this.hlsUrlCache.delete(`${scope}:${did}`);
  }
}
