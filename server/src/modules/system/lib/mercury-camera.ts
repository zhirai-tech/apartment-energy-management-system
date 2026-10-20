import crypto from 'crypto';
import {
  getLanCameraConfig,
  type LanCameraConfig,
} from '../lan-camera.service';

/**
 * 水星 / MERCURY（以及同源 IP-Camera Web 协议）摄像头厂商接口。
 *
 * 协议要点（2026-10 实测 MIPC852W 固件 1.0.2）：
 * 1. GET /pc/Basic.htm（未授权）返回 401 JSON：{ data: { nonce } }
 * 2. POST / body { method:'do', login:{ username, password: md5(密码 + ':' + nonce), encrypt_type:2, md5_encrypt_type:'1' } }
 *    → { stok: '...' }
 * 3. POST /stok=<stok>/ds body { method:'get'|'set', <section>:{...} }
 *
 * 已确认可读写的功能：
 * - motion_detection.motion_det.enabled       移动侦测 on/off
 * - people_detection.detection.enabled 人形侦测 on/off（独立智能事件，非 motion AI 人形过滤）
 * - motion_detection.motion_det.sensitivity  灵敏度 low/medium/high
 * - record_plan.chn1_channel.enabled 摄像头本地录像总开关 on/off（无 SD 卡时不会落盘）
 * - motion_detection.motion_notif_list.record_enabled 移动侦测联动录像 on/off
 * - audio_config.microphone.mute             录音静音（on=关闭录音，off=开启录音）
 */
const VENDOR_KEY_HINT = 'MERCURY';
const LOGIN_PATH = '/pc/Basic.htm';
const REQUEST_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
};

export interface CameraFeatureState {
  /** 是否支持厂商功能接口（登录成功且返回配置） */
  supported: boolean;
  vendor: 'mercury' | 'unknown';
  motionDetected: boolean;
  humanDetected: boolean;
  sensitivity: 'low' | 'medium' | 'high' | string;
  humanSensitivity?: string;
  /** 摄像头本地录像总开关（record_plan） */
  localRecording: boolean;
  /** 摄像头是否检测到存储卡（无卡时本地录像不落盘） */
  storageOnline: boolean;
  /** 移动侦测联动录像（motion_notif_list.record_enabled） */
  motionLinkRecording: boolean;
  audioEnabled: boolean;
  audioMuted: boolean;
  noiseCancelling: boolean;
  raw?: Record<string, unknown>;
}

export interface CameraFeaturePatch {
  motionDetected?: boolean;
  humanDetected?: boolean;
  sensitivity?: 'low' | 'medium' | 'high';
  localRecording?: boolean;
  motionLinkRecording?: boolean;
  audioEnabled?: boolean;
}

function onOff(value: boolean): 'on' | 'off' {
  return value ? 'on' : 'off';
}

class MercuryCameraClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private stok = '';
  private stokAt = 0;

  constructor(config: Pick<LanCameraConfig, 'ip' | 'username' | 'password'>, timeoutMs = 8000) {
    this.baseUrl = `http://${config.ip}`;
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.timeoutMs = timeoutMs;
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...REQUEST_HEADERS, ...(init.headers ?? {}) },
      });
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  private async login(): Promise<void> {
    if (this.stok && Date.now() - this.stokAt < 5 * 60_000) return;
    const unauth = await this.request(LOGIN_PATH, { method: 'GET' });
    let nonce: string | undefined;
    try {
      const parsed = JSON.parse(unauth.text ?? '{}');
      nonce = parsed?.data?.nonce;
    } catch {
      nonce = undefined;
    }
    if (!nonce) {
      throw new Error('摄像头未返回登录 nonce（可能固件不支持该接口）');
    }
    const password = crypto
      .createHash('md5')
      .update(`${this.password}:${nonce}`)
      .digest('hex');
    const login = await this.request('/', {
      method: 'POST',
      body: JSON.stringify({
        method: 'do',
        login: {
          username: this.username,
          password,
          encrypt_type: 2,
          md5_encrypt_type: '1',
        },
      }),
    });
    let stok: string | undefined;
    try {
      const parsed = JSON.parse(login.text ?? '{}');
      stok = parsed?.stok;
    } catch {
      stok = undefined;
    }
    if (!stok) {
      throw new Error('摄像头登录失败，请检查用户名密码');
    }
    this.stok = stok;
    this.stokAt = Date.now();
  }

  private dsPath(): string {
    return `/stok=${encodeURIComponent(this.stok)}/ds`;
  }

  private async ds(payload: Record<string, unknown>): Promise<Record<string, any>> {
    await this.login();
    let result = await this.request(this.dsPath(), { method: 'POST', body: JSON.stringify(payload) });
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(result.text ?? '{}');
    } catch {
      throw new Error('摄像头返回内容不是合法 JSON');
    }
    // stok 失效（-40401/-40407）：重新登录后重试一次
    if (parsed?.error_code === -40401 || parsed?.error_code === -40407) {
      this.stok = '';
      await this.login();
      result = await this.request(this.dsPath(), { method: 'POST', body: JSON.stringify(payload) });
      parsed = JSON.parse(result.text ?? '{}');
    }
    if (parsed?.error_code !== 0 && parsed?.error_code !== undefined) {
      throw new Error(`摄像头返回错误码 ${parsed.error_code}`);
    }
    return parsed;
  }

  async getFeatures(): Promise<CameraFeatureState> {
    const data = await this.ds({
      motion_detection: {
        name: ['motion_det', 'motion_notif_list', 'sound_alarm_info'],
        table: ['region_info'],
      },
      people_detection: { name: ['detection'], table: ['region_info'] },
      record_plan: { name: ['chn1_channel'] },
      harddisk_manage: { table: ['hd_info'] },
      audio_config: { name: ['microphone', 'speaker'] },
      method: 'get',
    });
    const motion = data?.motion_detection?.motion_det ?? {};
    const notification = data?.motion_detection?.motion_notif_list ?? {};
    const people = data?.people_detection?.detection ?? {};
    const recordPlan = data?.record_plan?.chn1_channel ?? {};
    const microphone = data?.audio_config?.microphone ?? {};
    const disks = Array.isArray(data?.harddisk_manage?.hd_info) ? data.harddisk_manage.hd_info : [];
    const diskStatuses = disks
      .map((entry: any) => entry?.hd_info_1?.status)
      .filter((status: unknown) => typeof status === 'string');
    return {
      supported: true,
      vendor: VENDOR_KEY_HINT.toLowerCase() as 'mercury',
      motionDetected: String(motion.enabled ?? 'off') === 'on',
      humanDetected: String(people.enabled ?? 'off') === 'on',
      sensitivity: String(motion.sensitivity ?? 'medium'),
      humanSensitivity: String(people.sensitivity ?? ''),
      localRecording: String(recordPlan.enabled ?? 'off') === 'on',
      storageOnline: diskStatuses.length > 0 && diskStatuses.every((status: string) => status !== 'offline'),
      motionLinkRecording: String(notification.record_enabled ?? 'on') === 'on',
      audioEnabled: String(microphone.mute ?? 'off') === 'off',
      audioMuted: String(microphone.mute ?? 'off') === 'on',
      noiseCancelling: String(microphone.noise_cancelling ?? 'off') === 'on',
      raw: data,
    };
  }

  async updateFeatures(patch: CameraFeaturePatch): Promise<CameraFeatureState> {
    const motion: Record<string, string> = {};
    if (typeof patch.motionDetected === 'boolean') motion.enabled = onOff(patch.motionDetected);
    if (patch.sensitivity) motion.sensitivity = patch.sensitivity;

    if (Object.keys(motion).length > 0) {
      await this.ds({ motion_detection: { motion_det: motion }, method: 'set' });
    }
    if (typeof patch.humanDetected === 'boolean') {
      await this.ds({
        people_detection: { detection: { enabled: onOff(patch.humanDetected) } },
        method: 'set',
      });
    }
    if (typeof patch.localRecording === 'boolean') {
      await this.ds({
        record_plan: { chn1_channel: { enabled: onOff(patch.localRecording) } },
        method: 'set',
      });
    }
    if (typeof patch.motionLinkRecording === 'boolean') {
      await this.ds({
        motion_detection: { motion_notif_list: { record_enabled: onOff(patch.motionLinkRecording) } },
        method: 'set',
      });
    }
    if (typeof patch.audioEnabled === 'boolean') {
      await this.ds({
        audio_config: { microphone: { mute: onOff(!patch.audioEnabled) } },
        method: 'set',
      });
    }
    return this.getFeatures();
  }
}

export const CAMERA_FEATURE_UNSUPPORTED: CameraFeatureState = {
  supported: false,
  vendor: 'unknown',
  motionDetected: false,
  humanDetected: false,
  sensitivity: '',
  localRecording: false,
  storageOnline: false,
  motionLinkRecording: false,
  audioEnabled: false,
  audioMuted: false,
  noiseCancelling: false,
};

async function resolveClient(did: string): Promise<MercuryCameraClient> {
  const config = await getLanCameraConfig(did);
  if (!config) {
    throw new Error('该设备不是已保存的局域网摄像头');
  }
  return new MercuryCameraClient(config);
}

export async function readCameraFeatures(did: string): Promise<CameraFeatureState> {
  const client = await resolveClient(did);
  return client.getFeatures();
}

export async function writeCameraFeatures(
  did: string,
  patch: CameraFeaturePatch,
): Promise<CameraFeatureState> {
  const client = await resolveClient(did);
  return client.updateFeatures(patch);
}
