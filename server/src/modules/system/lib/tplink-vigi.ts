import http from 'node:http';
import crypto from 'node:crypto';

/** TP-Link IPC / VIGI 本地控制（网页管理接口，非 ONVIF） */
export interface TplinkAuthConfig {
  ip: string;
  port?: number;
  username: string;
  password: string;
}

export interface TplinkDetectionState {
  human?: { supported: boolean; enabled: boolean; sensitivity?: number };
  intrusion?: { supported: boolean; enabled: boolean };
}

const DICT =
  'yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW';
const KEY2 = 'RDpbLfCPsJZ7fiv';

/** TP-Link 网页登录的密码混淆算法（与摄像头网页 JS 一致） */
function securityEncode(input: string): string {
  let out = '';
  const l1 = input.length;
  const l2 = KEY2.length;
  const h = DICT.length;
  const max = Math.max(l1, l2);
  for (let m = 0; m < max; m += 1) {
    const a = m < l1 ? input.charCodeAt(m) : 187;
    const b = m < l2 ? KEY2.charCodeAt(m) : 187;
    out += DICT.charAt((a ^ b) % h);
  }
  return out;
}

function requestJson(host: string, port: number, path: string, body: unknown, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': data.length },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf || '{}'));
          } catch {
            reject(new Error(`摄像头返回非 JSON：${buf.slice(0, 120)}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('摄像头响应超时'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

interface CachedSession {
  stok: string;
  at: number;
}

const sessionCache = new Map<string, CachedSession>();
const SESSION_TTL_MS = 8 * 60 * 1000;

function cacheKey(cfg: TplinkAuthConfig): string {
  return `${cfg.ip}:${cfg.port ?? 80}:${cfg.username}`;
}

/** 登录摄像头网页接口，拿 stok（TP-Link IPC 私有加密登录） */
export async function tplinkLogin(cfg: TplinkAuthConfig): Promise<string> {
  const key = cacheKey(cfg);
  const cached = sessionCache.get(key);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.stok;

  const port = cfg.port ?? 80;
  // 1) 探测登录参数（空密码会返回 401 + 公钥/nonce，用于后续 RSA 加密）
  const probe = await requestJson(cfg.ip, port, '/', {
    method: 'do',
    login: { username: cfg.username, password: '', encrypt_type: '2' },
  });
  let authData: any = probe?.data;
  if (typeof authData === 'string') {
    try {
      authData = JSON.parse(authData);
    } catch {
      authData = null;
    }
  }
  if (!authData?.key || !authData?.nonce) {
    if (Number(authData?.sec_left) > 0) {
      throw new Error(`摄像头登录被限流，请 ${Math.ceil(Number(authData.sec_left) / 60)} 分钟后再试`);
    }
    throw new Error('摄像头登录参数获取失败');
  }
  // 2) 密码混淆后 RSA 加密（密码:nonce），再登录
  const der = Buffer.from(decodeURIComponent(String(authData.key)), 'base64');
  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const plain = `${securityEncode(cfg.password)}:${authData.nonce}`;
  const encrypted = crypto
    .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain))
    .toString('base64');
  const login = await requestJson(cfg.ip, port, '/', {
    method: 'do',
    login: { username: cfg.username, password: encodeURIComponent(encrypted), encrypt_type: '2' },
  });
  if (login?.error_code !== 0 || !login?.stok) {
    throw new Error(login?.error_code === -40401 ? '摄像头登录失败（密码或账号不对）' : `摄像头登录失败：${JSON.stringify(login).slice(0, 120)}`);
  }
  sessionCache.set(key, { stok: String(login.stok), at: Date.now() });
  return String(login.stok);
}

/** 调用摄像头的 /ds 配置接口（会话失效时自动重新登录重试一次） */
async function dsCall(cfg: TplinkAuthConfig, payload: unknown): Promise<any> {
  const key = cacheKey(cfg);
  const call = async (): Promise<any> => {
    const stok = await tplinkLogin(cfg);
    return requestJson(cfg.ip, cfg.port ?? 80, `/stok=${encodeURIComponent(stok)}/ds`, payload);
  };
  const first = await call();
  if (first && typeof first === 'object' && first.error_code !== 0) {
    // 摄像头重启/会话过期：清缓存重新登录再试一次
    sessionCache.delete(key);
    return call();
  }
  return first;
}

/** 读取侦测配置（人形侦测 / 区域入侵） */
export async function getTplinkDetectionState(cfg: TplinkAuthConfig): Promise<TplinkDetectionState> {
  const state: TplinkDetectionState = {};
  try {
    const human = await dsCall(cfg, { method: 'get', people_detection: { name: ['detection'] } });
    const det = human?.people_detection?.detection;
    if (det) {
      state.human = {
        supported: true,
        enabled: det.enabled === 'on',
        sensitivity: det.sensitivity != null ? Number(det.sensitivity) : undefined,
      };
    }
  } catch {
    /* 忽略单项失败 */
  }
  try {
    const intrusion = await dsCall(cfg, { method: 'get', intrusion_detection: { name: ['detection'] } });
    const det = intrusion?.intrusion_detection?.detection;
    if (det) state.intrusion = { supported: true, enabled: det.enabled === 'on' };
  } catch {
    /* 忽略单项失败 */
  }
  return state;
}

/** 打开/关闭摄像头侦测开关（人形侦测 / 区域入侵） */
export async function setTplinkDetectionEnabled(
  cfg: TplinkAuthConfig,
  feature: 'human' | 'intrusion',
  enabled: boolean,
): Promise<void> {
  const section = feature === 'human' ? 'people_detection' : 'intrusion_detection';
  const sectionName = feature === 'human' ? 'people' : 'intrusion';
  const result = await dsCall(cfg, {
    method: 'set',
    [section]: { detection: { enabled: enabled ? 'on' : 'off' } },
  });
  if (result?.error_code !== 0) {
    throw new Error(`摄像头写入失败（${sectionName}）：${JSON.stringify(result).slice(0, 120)}`);
  }
  // 写后读一次校验
  const verify = await dsCall(cfg, { method: 'get', [section]: { name: ['detection'] } });
  const det = verify?.[section]?.detection;
  if (det && (det.enabled === 'on') !== enabled) {
    throw new Error('摄像头未接受设置，请稍后重试');
  }
}
