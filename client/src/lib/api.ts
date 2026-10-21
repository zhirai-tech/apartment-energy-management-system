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
  getCameraStream: (did: string): Promise<{
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
  }> => api.get(`/system/device/${did}/camera_stream`).then((res) => res.data),
  controlCameraPTZ: (
    did: string,
    direction: 'left' | 'right' | 'up' | 'down' | 'stop',
    speed = 50,
  ): Promise<{
    ok: boolean;
    did: string;
    direction: string;
    raw?: any;
    errorMessage?: string;
  }> =>
    api.post(`/system/device/${did}/camera_ptz`, { direction, speed }).then((res) => res.data),
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

export type { DeviceItem };
export default api;
