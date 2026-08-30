import axios from 'axios';
import type {
  LoginRequest,
  LoginResponse,
  ForcePasswordChangeRequest,
  UserPayload,
  UserCreateRequest,
  UserManagementItem,
  UserUpdateRequest,
  DashboardSummary,
  NetworkHistoryResponse,
  RealtimeEnergyData,
  RoomEnergyDetail,
  RankingItem,
  SystemSettingsData,
  DeviceItem,
  SiteSummary,
  SiteCreateRequest,
  SiteUpdateRequest,
} from '../types';
import { useAuthStore } from '../store/auth';
import { getApiBaseUrl } from './runtime-config';

const apiBaseUrl = getApiBaseUrl();

const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 180_000,
});

// —— 并发相同 GET 请求合并：同一 URL 的在途请求直接复用其响应，
//    消除页面加载时重复请求产生的浏览器 net::ERR_ABORTED 噪音 ——
const inflightGets = new Map<string, Promise<unknown>>();
const apiRequest = api.request.bind(api) as (config: any) => Promise<any>;
api.request = ((config: any): Promise<any> => {
  const cfg = config ?? {};
  const method = String(cfg.method || 'get').toLowerCase();
  const key = `${cfg.baseURL ?? ''}${cfg.url ?? ''}`;
  if (method === 'get' && cfg.url) {
    const inflight = inflightGets.get(key);
    if (inflight) {
      // 已有相同 GET 在途：等待其完成后返回相同数据，不再发起第二次网络请求
      return inflight.then((payload) => ({
        data: payload,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: cfg,
        request: {},
      }));
    }
    const p = apiRequest(cfg).then(
      (res: any) => {
        inflightGets.delete(key);
        return res.data;
      },
      (err: any) => {
        inflightGets.delete(key);
        throw err;
      },
    );
    inflightGets.set(key, p);
    return p;
  }
  return apiRequest(cfg);
}) as typeof api.request;

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let redirecting401 = false;
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    if (status === 401) {
      const url: string | undefined = error.config?.url;
      const isAuthEndpoint =
        !!url && (url.includes('/auth/login') || url.includes('/auth/me'));
      if (!isAuthEndpoint) {
        try {
          await api.get('/auth/me');
          return api.request(error.config);
        } catch {
        }
      }
      if (!redirecting401) {
        redirecting401 = true;
        try {
          useAuthStore.getState().logout();
        } catch {
        }
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
        setTimeout(() => {
          redirecting401 = false;
        }, 800);
      }
    }
    const code = error?.code || error?.response?.data?.code;
    const httpStatus = status;
    const serverMessage =
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      '请求失败';
    const enriched = new Error(serverMessage) as Error & {
      code?: string
      httpStatus?: number
      isAxiosTimeout?: boolean
      isCanceled?: boolean
    };
    enriched.code = code;
    enriched.httpStatus = httpStatus;
    if (
      code === 'ECONNABORTED' ||
      error?.code === 'ECONNABORTED' ||
      /timeout|超过|time.?out/i.test(serverMessage || '')
    ) {
      enriched.isAxiosTimeout = true;
    }
    if (
      error?.code === 'ERR_CANCELED' ||
      error?.name === 'CanceledError' ||
      (typeof error?.message === 'string' && error.message.toLowerCase().includes('canceled'))
    ) {
      enriched.isCanceled = true;
    }
    return Promise.reject(enriched);
  },
);

export const auth = {
  login: (data: LoginRequest): Promise<LoginResponse> =>
    api.post('/auth/login', data).then((res) => res.data),
  forceChangePassword: (data: ForcePasswordChangeRequest): Promise<LoginResponse> =>
    api.post('/auth/force-change-password', data).then((res) => res.data),
  logout: (): void => {
    useAuthStore.getState().logout();
  },
  me: (): Promise<UserPayload> =>
    api.get('/auth/me').then((res) => res.data),
  listUsers: (): Promise<UserManagementItem[]> =>
    api.get('/auth/users').then((res) => res.data),
  createUser: (data: UserCreateRequest): Promise<UserManagementItem> =>
    api.post('/auth/users', data).then((res) => res.data),
  updateUser: (userId: string, data: UserUpdateRequest): Promise<UserManagementItem> =>
    api.put(`/auth/users/${userId}`, data).then((res) => res.data),
  deleteUser: (userId: string): Promise<{ ok: boolean }> =>
    api.delete(`/auth/users/${userId}`).then((res) => res.data),
};

export const dashboard = {
  get: (siteId?: string): Promise<DashboardSummary> =>
    api.get('/dashboard', { params: siteId ? { siteId } : undefined }).then((res) => res.data),
  getNetworkHistory: (siteId?: string): Promise<NetworkHistoryResponse> =>
    api.get('/dashboard/network-history', { params: siteId ? { siteId } : undefined }).then((res) => res.data),
};

export const energy = {
  getRooms: (siteId?: string): Promise<RealtimeEnergyData[]> =>
    api.get('/energy', { params: siteId ? { siteId } : undefined }).then((res) => res.data),
  getRoom: (roomId: string): Promise<RoomEnergyDetail> =>
    api.get(`/energy/${roomId}`).then((res) => res.data),
  getLimits: (siteId?: string): Promise<any[]> =>
    api.get('/energy/limits', { params: siteId ? { siteId } : undefined }).then((res) => res.data),
  updateLimit: (
    roomId: string,
    dailyLimit: number,
    enabled?: boolean,
    monthlyCostLimit?: number,
    costEnabled?: boolean,
  ): Promise<any> =>
    api.put(`/energy/limits/${roomId}`, {
      dailyLimit,
      enabled,
      monthlyCostLimit,
      costEnabled,
    }).then((res) => res.data),
  bulkToggleLimits: (enabled: boolean, siteId?: string): Promise<any> =>
    api.post('/energy/limits/bulk-toggle', { enabled, siteId }).then((res) => res.data),
  bulkUpdateLimit: (dailyLimit: number, siteId?: string): Promise<any> =>
    api.post('/energy/limits/bulk-update', { dailyLimit, siteId }).then((res) => res.data),
  cutoff: (roomId: string): Promise<any> =>
    api.post(`/energy/${roomId}/cutoff`).then((res) => res.data),
  restore: (roomId: string): Promise<any> =>
    api.post(`/energy/${roomId}/restore`).then((res) => res.data),
  ranking: (limit?: number, siteId?: string): Promise<RankingItem[]> =>
    api
      .get('/energy/stats/ranking', {
        params: {
          ...(limit ? { limit } : {}),
          ...(siteId ? { siteId } : {}),
        },
      })
      .then((res) => res.data),
};

export const system = {
  getSites: (): Promise<SiteSummary[]> =>
    api.get('/system/sites').then((res) => res.data),
  createSite: (data: SiteCreateRequest): Promise<SiteSummary> =>
    api.post('/system/sites', data).then((res) => res.data),
  updateSite: (siteId: string, data: SiteUpdateRequest): Promise<SiteSummary> =>
    api.put(`/system/sites/${siteId}`, data).then((res) => res.data),
  getSettings: (): Promise<SystemSettingsData> =>
    api.get('/system/settings').then((res) => res.data),
  updateSettings: (partial: Partial<SystemSettingsData>): Promise<any> =>
    api.put('/system/settings', partial).then((res) => res.data),
  refreshReferencePrice: (data?: {
    region?: string;
    businessTimezone?: string;
    autoEnabled?: boolean;
  }): Promise<{
    pricePerKwh: number;
    priceAutoRegion: string;
    priceAutoSource: string;
    priceAutoLastUpdatedAt: string;
    priceAutoEnabled: boolean;
  }> => api.post('/system/settings/price-reference/refresh', data ?? {}).then((res) => res.data),
  xiaomiStatus: (): Promise<{
    loggedIn: boolean;
    hasEnvCredentials: boolean;
    username?: string;
    auth?: {
      state: 'idle' | 'logged_in' | 'challenge_required' | 'error';
      needsVerification: boolean;
      verificationMethod?: 'browser' | 'email_code' | null;
      message?: string;
      notificationUrl?: string;
      securityStatus?: number | null;
      pwd?: number | null;
      code?: number | string | null;
      location?: string | null;
      codeSentAt?: string | null;
      username?: string;
      lastAttemptAt?: string | null;
    };
  }> => api.get('/system/xiaomi/status').then((res) => res.data),
  xiaomiDevices: (): Promise<{
    loggedIn: boolean;
    username?: string;
    region?: string;
    auth?: {
      state?: string | null;
      needsVerification?: boolean | null;
      verificationMethod?: 'email_code' | 'browser' | null;
      message?: string | null;
      notificationUrl?: string | null;
      username?: string | null;
      codeSentAt?: string | null;
      lastAttemptAt?: string | null;
      securityStatus?: number | null;
      pwd?: number | null;
      code?: string | null;
      location?: string | null;
      region?: string | null;
      notificationId?: string | null;
      emailMask?: string | null;
      emailBound?: boolean | null;
      sendFailed?: boolean | null;
      rawSendBody?: any;
    } | null;
    devices: Array<{
      did: string;
      name: string;
      model: string;
      localIp?: string | null;
      online?: boolean;
      vendorName?: string | null;
      sourceRegion?: string | null;
      sourceScope?: 'main' | 'camera';
    }>;
  }> => api.get('/system/xiaomi/devices').then((res) => res.data),
  xiaomiLogin: (
    username?: string,
    password?: string,
    sessionInput?: {
      userId?: string;
      serviceToken?: string;
      ssecurity?: string;
      region?: string;
    },
    region?: string,
  ): Promise<{ loggedIn: boolean; usedEnv: boolean; loginMode?: 'password' | 'session' }> =>
    api
      .post('/system/xiaomi/login', {
        username: username || undefined,
        password: password || undefined,
        userId: sessionInput?.userId || undefined,
        serviceToken: sessionInput?.serviceToken || undefined,
        ssecurity: sessionInput?.ssecurity || undefined,
        region: region || sessionInput?.region || undefined,
      })
      .then((res) => res.data),
  xiaomiContinueLogin: (): Promise<{ loggedIn: boolean; usedEnv: boolean; loginMode?: 'password' | 'session' }> =>
    api.post('/system/xiaomi/login/continue', { continueAfterVerification: true }).then((res) => res.data),
  xiaomiSendEmailVerificationCode: (): Promise<{
    sent: boolean;
    usedEnv: boolean;
    loginMode?: 'password' | 'session';
    verificationMethod?: 'email_code';
  }> =>
    api.post('/system/xiaomi/login', { sendEmailVerificationCode: true }).then((res) => res.data),
  xiaomiVerifyEmailCode: (verificationCode: string): Promise<{
    loggedIn: boolean;
    usedEnv: boolean;
    loginMode?: 'password' | 'session';
    verificationMethod?: 'email_code';
  }> =>
    api.post('/system/xiaomi/login', { verificationCode }).then((res) => res.data),
  xiaomiSync: (): Promise<{ synced: boolean }> =>
    api.post('/system/xiaomi/sync').then((res) => res.data),
  controlAllDevices: (action: 'on' | 'off', siteId?: string): Promise<{ ok: boolean; action: 'on' | 'off'; total: number; success: number; failed: number }> =>
    api.post('/system/devices/control-all', { action, siteId }).then((res) => res.data),
  controlDevice: (did: string, action: 'on' | 'off'): Promise<{ ok: boolean; did: string; action: 'on' | 'off' }> =>
    api.post(`/system/device/${did}/control`, { action }).then((res) => res.data),
  updateRoomAnnotation: (
    roomId: string,
    annotation: string,
  ): Promise<{ roomId: string; roomNumber: string; annotation: string | null; displayName: string }> =>
    api.put(`/system/room/${roomId}/annotation`, { annotation }).then((res) => res.data),
  updateRoomFloor: (
    roomId: string,
    floor: number,
  ): Promise<{ roomId: string; roomNumber: string; floor: number }> =>
    api.put(`/system/room/${roomId}/floor`, { floor }).then((res) => res.data),
  renameDevice: (did: string, name: string): Promise<{ did: string; name: string }> =>
    api.put(`/system/device/${did}/name`, { name }).then((res) => res.data),
  detectLanSubnets: (): Promise<{ subnets: string[] }> =>
    api.get('/system/lan-scan/subnets').then((res) => res.data),
  lanScan: (subnet: string, options?: { withVendorRemoteApi?: boolean }): Promise<{
    base: string
    totalTried: number
    aliveCount: number
    arpCount: number
    tcpTriggered?: number
    udpTriggered?: number
    arpPasses?: number
    devices: Array<{
      ip: string
      mac: string | null
      vendor: string | null
      name: string | null
      hostname: string | null
      pingAlive?: boolean
      fromArp?: boolean
    }>
  }> =>
    api.post('/system/lan-scan', {
      subnet,
      withHostname: true,
      withVendorRemoteApi: !!options?.withVendorRemoteApi,
      concurrency: 40,
      pingTimeoutMs: 800,
    }).then((res) => res.data),
  persistLanDevices: (items: Array<{
    ip: string;
    mac: string | null;
    vendor?: string | null;
    name?: string | null;
    hostname?: string | null;
    status?: 'online' | 'offline' | 'unknown';
    siteId?: string | null;
    roomId?: string | null;
  }>): Promise<{
    total: number;
    persisted: number;
    updated: number;
    skipped: number;
    failed: number;
    dids: string[];
    categorySummary: Record<string, number>;
    errors: Array<{ mac: string | null; ip: string; name?: string | null; message: string }>;
  }> => api.post('/system/lan-device/persist', { items }).then((res) => res.data),
  getDeviceSnapshotUrl: (did: string, options?: { fresh?: boolean }): string => {
    const base = `${getApiBaseUrl()}/system/device/${encodeURIComponent(did)}/snapshot`;
    const token = useAuthStore.getState().token;
    const query: string[] = [];
    if (token) query.push(`token=${encodeURIComponent(token)}`);
    if (options?.fresh) query.push('cache=no-cache');
    query.push(`t=${Date.now()}`);
    return `${base}?${query.join('&')}`;
  },
  updateDeviceCamera: (did: string, data: {
    manualSnapshotUrl?: string | null;
    manualAuthUsername?: string | null;
    manualAuthPassword?: string | null;
    manualAuthType?: 'digest' | 'basic' | 'none' | null;
    manualBrand?: string | null;
    manualModel?: string | null;
    hasAudio?: boolean | null;
    hasNightVision?: boolean | null;
  }): Promise<{ did: string }> =>
    api.put(`/system/device/${did}/camera`, data).then((res) => res.data),
  updateDeviceCategory: (did: string, category: string): Promise<{ did: string; category: string }> =>
    api.put(`/system/device/${did}/category`, { category }).then((res) => res.data),
  deleteDevice: (did: string): Promise<{ did: string }> =>
    api.delete(`/system/device/${did}`).then((res) => res.data),
  xiaomiCameraLogin: (params?: {
    username?: string;
    password?: string;
    userId?: string;
    serviceToken?: string;
    ssecurity?: string;
    region?: string;
    sendEmailVerificationCode?: boolean;
    verificationCode?: string;
  }): Promise<{
    loggedIn?: boolean;
    usedEnv?: boolean;
    loginMode?: 'password' | 'session' | 'env';
    username?: string;
    region?: string;
    message?: string;
    scope?: 'camera' | 'main';
    sent?: boolean;
    verificationMethod?: 'email_code' | 'browser' | null;
    needsVerification?: boolean | null;
    notificationUrl?: string | null;
    auth?: {
      state?: string | null;
      needsVerification?: boolean | null;
      verificationMethod?: 'email_code' | 'browser' | null;
      message?: string | null;
      notificationUrl?: string | null;
      username?: string | null;
      codeSentAt?: string | null;
      lastAttemptAt?: string | null;
      securityStatus?: number | null;
      pwd?: number | null;
      code?: string | null;
      location?: string | null;
      region?: string | null;
      notificationId?: string | null;
      emailMask?: string | null;
      emailBound?: boolean | null;
      sendFailed?: boolean | null;
      rawSendBody?: any;
    } | null;
  }> =>
    api.post('/system/xiaomi/camera/login', params ?? {}).then((res) => res.data),
  xiaomiCameraStatus: (): Promise<{
    loggedIn: boolean;
    hasEnvCredentials?: boolean;
    username?: string | null;
    region?: string | null;
    auth?: {
      state?: string | null;
      needsVerification?: boolean | null;
      verificationMethod?: 'email_code' | 'browser' | null;
      message?: string | null;
      notificationUrl?: string | null;
      username?: string | null;
      codeSentAt?: string | null;
      lastAttemptAt?: string | null;
      securityStatus?: number | null;
      pwd?: number | null;
      code?: string | null;
      location?: string | null;
      region?: string | null;
      notificationId?: string | null;
      emailMask?: string | null;
      emailBound?: boolean | null;
      sendFailed?: boolean | null;
      rawSendBody?: any;
    } | null;
  }> => api.get('/system/xiaomi/camera/status').then((res) => res.data),
  xiaomiCameraSendEmailCode: (): Promise<{
    sent?: boolean;
    scope?: 'camera';
    verificationMethod?: 'email_code';
    auth?: any;
  }> => api.post('/system/xiaomi/camera/send_email_code', {}).then((res) => res.data),
  xiaomiCameraVerifyEmailCode: (verificationCode: string): Promise<{
    loggedIn?: boolean;
    scope?: 'camera';
    verificationMethod?: 'email_code';
    auth?: any;
    message?: string;
  }> =>
    api
      .post('/system/xiaomi/camera/verify_email_code', { verificationCode })
      .then((res) => res.data),
  xiaomiCameraContinueLogin: (): Promise<{
    loggedIn?: boolean;
    usedEnv?: boolean;
    loginMode?: 'password' | 'session' | 'env';
    scope?: 'camera';
    verificationMethod?: 'email_code' | 'browser' | null;
    auth?: any;
    message?: string;
  }> => api.post('/system/xiaomi/camera/login/continue', { continueAfterVerification: true }).then((res) => res.data),
  xiaomiCameraDevices: (): Promise<{
    loggedIn: boolean;
    username?: string;
    region?: string;
    auth?: {
      state?: string | null;
      needsVerification?: boolean | null;
      verificationMethod?: 'email_code' | 'browser' | null;
      message?: string | null;
      notificationUrl?: string | null;
      username?: string | null;
      codeSentAt?: string | null;
      lastAttemptAt?: string | null;
      securityStatus?: number | null;
      pwd?: number | null;
      code?: string | null;
      location?: string | null;
      region?: string | null;
      notificationId?: string | null;
      emailMask?: string | null;
      emailBound?: boolean | null;
      sendFailed?: boolean | null;
      rawSendBody?: any;
    } | null;
    devices: Array<{
      did: string;
      name: string;
      model: string;
      localIp?: string | null;
      online?: boolean;
      vendorName?: string | null;
      sourceRegion?: string | null;
      sourceScope?: 'main' | 'camera';
    }>;
  }> => api.get('/system/xiaomi/camera/devices').then((res) => res.data),
  getCameraStream: (did: string, opts?: { fresh?: boolean }): Promise<{
    ok: boolean;
    did: string;
    streamAddress?: string;
    streamAuthToken?: string;
    proxyMode?: 'ffmpeg-hls' | 'none';
    hlsUrl?: string;
    webrtcUrl?: string;
    hlsReady?: boolean;
    processId?: number;
    startedAt?: string;
    ffmpegAvailable?: boolean;
    errorMessage?: string;
  }> =>
    api.get(`/system/device/${did}/camera_stream`, { params: opts?.fresh ? { cache: 'no-cache' } : undefined }).then((res) => res.data),
  controlCameraPTZ: (
    did: string,
    direction: 'left' | 'right' | 'up' | 'down' | 'stop' | 'calibrate',
    speed = 50,
  ): Promise<{
    ok: boolean;
    did: string;
    direction: string;
    raw?: any;
    errorMessage?: string;
  }> =>
    api.post(`/system/device/${did}/camera_ptz`, { direction, speed }).then((res) => res.data),
  startCameraRecording: (did: string, opts?: { mode?: 'motion' | 'continuous'; segmentMinutes?: number }): Promise<{
    did: string;
    recording: boolean;
    mode?: 'motion' | 'continuous';
    processId?: number;
    startedAt?: number;
    errorMessage?: string;
  }> => api.post(`/system/device/${did}/camera_record/start`, opts ?? {}).then((res) => res.data),
  stopCameraRecording: (did: string): Promise<{ did: string; recording: boolean }> =>
    api.post(`/system/device/${did}/camera_record/stop`).then((res) => res.data),
  getCameraRecordingStatus: (did: string): Promise<{ did: string; recording: boolean; mode?: 'motion' | 'continuous' | null }> =>
    api.get(`/system/device/${did}/camera_record/status`).then((res) => res.data),
  listCameraRecordings: (did: string): Promise<{
    did: string;
    files: Array<{ name: string; size: number; mtime: number; url: string }>;
  }> => api.get(`/system/device/${did}/camera_record/list`).then((res) => res.data),
  deleteCameraRecording: (did: string, name: string): Promise<{
    did: string;
    name: string;
    deleted: boolean;
    errorMessage?: string;
  }> => api.delete(`/system/device/${did}/camera_record/${encodeURIComponent(name)}`).then((res) => res.data),
  listAllCameraRecordings: (): Promise<{
    files: Array<{ did: string; name: string; size: number; mtime: number; url: string }>;
  }> => api.get('/system/camera/recordings').then((res) => res.data),
  getCameraCapabilities: (did: string): Promise<CameraCapabilities> =>
    api.get(`/system/device/${did}/camera_capabilities`).then((res) => res.data),
  controlCameraCapability: (did: string, capability: string, value?: unknown): Promise<{
    did: string;
    capability: string;
    ok: boolean;
    state?: unknown;
    hint?: string;
  }> => api.post(`/system/device/${did}/camera_control`, { capability, value }).then((res) => res.data),
  getCameraMotionSettings: (): Promise<{ threshold: number; tailSeconds: number; ringSeconds: number }> =>
    api.get('/system/camera/motion-settings').then((res) => res.data),
  updateCameraMotionSettings: (data: { threshold?: number; tailSeconds?: number; ringSeconds?: number }): Promise<{
    threshold: number;
    tailSeconds: number;
    ringSeconds: number;
  }> => api.put('/system/camera/motion-settings', data).then((res) => res.data),
  listCameraSchedules: (did?: string): Promise<{ schedules: CameraScheduleRule[] }> =>
    api.get('/system/camera/schedules', { params: did ? { did } : undefined }).then((res) => res.data),
  upsertCameraSchedule: (data: {
    id?: string;
    did: string;
    enabled?: boolean;
    mode?: 'motion' | 'continuous';
    days?: number[];
    start?: string;
    end?: string;
  }): Promise<{ rule: CameraScheduleRule }> => api.post('/system/camera/schedules', data).then((res) => res.data),
  deleteCameraSchedule: (id: string): Promise<{ deleted: boolean }> =>
    api.delete(`/system/camera/schedules/${encodeURIComponent(id)}`).then((res) => res.data),
  getDeviceAdapterConfig: (did: string): Promise<{
    kind: 'huawei_cpe' | 'nokia_beacon' | null;
    baseUrl: string | null;
    username: string | null;
    password: string | null;
    sessionSid: string | null;
    hasPersistedPassword: boolean;
  }> => api.get(`/system/device/${did}/adapter_config`).then((res) => res.data),
  saveDeviceAdapterConfig: (did: string, data: {
    kind?: 'huawei_cpe' | 'nokia_beacon' | null;
    baseUrl?: string | null;
    username?: string | null;
    password?: string | null;
    sessionSid?: string | null;
  }): Promise<{
    ok: boolean;
    kind: 'huawei_cpe' | 'nokia_beacon' | null;
    message?: string;
    hasPersistedPassword?: boolean;
  }> => api.put(`/system/device/${did}/adapter_config`, data).then((res) => res.data),
  refreshDeviceRuntime: (did: string): Promise<{
    ok: boolean;
    kind: string;
    runtime?: any;
    errorMessage?: string;
  }> => api.get(`/system/device/${did}/refresh_runtime`).then((res) => res.data),
  // ── Generic local-LAN device control (HTTP / Modbus / Tuya / MiIO) ──
  getDeviceControlConfig: (did: string): Promise<{
    did: string;
    name?: string;
    localip?: string | null;
    controlProtocol?: string | null;
    controlConfig?: any;
  }> => api.get(`/system/device/${did}/control-config`).then((res) => res.data),
  updateDeviceControlConfig: (did: string, data: {
    localip?: string | null;
    controlProtocol?: string | null;
    controlConfig?: any;
  }): Promise<{
    ok: boolean;
    did: string;
    localip: string | null;
    controlProtocol: string | null;
    name?: string;
  }> => api.put(`/system/device/${did}/control-config`, data).then((res) => res.data),
  testDeviceControlConfig: (did: string, data: {
    localip?: string;
    controlProtocol?: string;
    controlConfig?: any;
    action?: 'on' | 'off';
  }): Promise<{
    ok: boolean;
    mode?: string;
    action?: string;
    state?: { on?: boolean | null; powerW?: number | null; reachable?: boolean; error?: string };
  }> => api.post(`/system/device/${did}/control-config/test`, data).then((res) => res.data),
};

export const logs = {
  operations: (params?: any): Promise<any> =>
    api.get('/logs/operations', { params }).then((res) => res.data),
  alarms: (params?: any): Promise<any> =>
    api.get('/logs/alarms', { params }).then((res) => res.data),
  clearAlarms: (data?: any): Promise<any> =>
    api.delete('/logs/alarms', { data }).then((res) => res.data),
  resolveAlarm: (id: string): Promise<any> =>
    api.post(`/logs/alarms/${id}/resolve`).then((res) => res.data),
};

// ──────────────── 数据导出 ────────────────

function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function downloadCsv(filename: string, url: string, params?: object): Promise<void> {
  const res = await api.get(url, { params, responseType: 'blob', timeout: 120_000 });
  const blob = res.data as Blob;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export interface ExportQuery {
  siteId?: string;
  from?: string;
  to?: string;
  category?: string;
}

export interface CameraCapabilityState {
  supported: boolean;
  controllable: boolean;
  state?: boolean | string | number | null;
  hint?: string;
}

export interface CameraCapabilities {
  did: string;
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

export interface CameraScheduleRule {
  id: string;
  did: string;
  enabled: boolean;
  mode: 'motion' | 'continuous';
  days: number[]; // 0=周日…6=周六
  start: string;
  end: string;
}

export const exportData = {
  /** 每个房间的用电汇总（实时功率/累计/今日/昨日/本周/本月/本年/费用/限额） */
  energySummary: (params: { siteId?: string } = {}): Promise<void> =>
    downloadCsv(`zhirai-用电汇总-${dateStamp()}.csv`, '/export/energy-summary', params),
  /** 每个房间逐日用电（日期范围，默认最近 30 天） */
  energyDaily: (params: ExportQuery = {}): Promise<void> =>
    downloadCsv(`zhirai-逐日用电-${dateStamp()}.csv`, '/export/energy-daily', params),
  /** 每个房间每周用电（按周一到周日，日期范围，默认最近 8 周） */
  energyWeekly: (params: ExportQuery = {}): Promise<void> =>
    downloadCsv(`zhirai-每周用电-${dateStamp()}.csv`, '/export/energy-weekly', params),
  /** 设备/系统操作记录 */
  operations: (params: ExportQuery = {}): Promise<void> =>
    downloadCsv(`zhirai-操作记录-${dateStamp()}.csv`, '/export/operations', params),
};

export type { DeviceItem };
export default api;
