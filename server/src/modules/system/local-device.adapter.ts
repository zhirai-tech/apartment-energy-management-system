import axios from 'axios';
import net from 'net';

/**
 * 通用局域网设备适配器：
 * 支持 HTTP/JSON 开关、Modbus TCP（工业断路器）、涂鸦本地、MiIO LAN。
 * 控制完全走局域网，不依赖任何厂商云账号。
 */

export type LocalControlProtocol = 'http' | 'modbus_tcp' | 'tuya_local' | 'miio_lan';

export interface LocalControlConfig {
  protocol: LocalControlProtocol;
  // ── HTTP/JSON ──
  /** 开命令地址（GET 或带 body 的 POST） */
  onUrl?: string;
  /** 关命令地址 */
  offUrl?: string;
  /** 状态查询地址 */
  stateUrl?: string;
  /** onUrl 的请求方法（默认 GET） */
  onMethod?: string;
  /** offUrl 的请求方法（默认 GET） */
  offMethod?: string;
  /** onUrl 的请求体（JSON 字符串，POST 时用） */
  onBody?: string;
  /** offUrl 的请求体（JSON 字符串，POST 时用） */
  offBody?: string;
  /** 状态 JSON 里表示开关的字段路径，如 "state" 或 "relay.0.state" */
  statePath?: string;
  /** 状态字段布尔化规则：true/false、1/0、on/off 自动兼容 */
  httpTimeoutMs?: number;
  // ── Modbus TCP ──
  modbusPort?: number;
  modbusUnitId?: number;
  /** 线圈地址（写开关，功能码 0x05） */
  coilAddress?: number;
  // ── 涂鸦本地（占位）──
  tuyaDeviceId?: string;
  tuyaLocalKey?: string;
  // ── MiIO LAN（占位）──
  miioToken?: string;
}

export interface LocalDeviceState {
  on: boolean | null;
  powerW?: number | null;
  currentA?: number | null;
  voltageV?: number | null;
  reachable: boolean;
  error?: string;
}

const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const MODBUS_DEFAULT_PORT = 502;
const MODBUS_DEFAULT_UNIT = 1;

function getConfig(config?: LocalControlConfig | null): LocalControlConfig | null {
  if (!config || typeof config !== 'object') return null;
  return config;
}

// ────────────────────────────── HTTP/JSON ──────────────────────────────

function buildHttpRequest(
  url: string | undefined,
  method: string | undefined,
  body: string | undefined,
  timeoutMs: number,
) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('HTTP 控制缺少有效的 URL');
  }
  const m = (method ?? 'GET').toUpperCase();
  return {
    url,
    method: m as 'GET' | 'POST',
    ...(body && (m === 'POST' || m === 'PUT') ? { data: tryParseJson(body) } : {}),
    timeout: timeoutMs,
  };
}

function tryParseJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function resolvePath(obj: unknown, path?: string): unknown {
  if (!path || !obj || typeof obj !== 'object') return obj;
  const keys = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function toBooleanValue(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'on', '1', 'yes', 'enabled', 'open'].includes(s)) return true;
    if (['false', 'off', '0', 'no', 'disabled', 'closed'].includes(s)) return false;
  }
  return null;
}

async function httpControl(
  config: LocalControlConfig,
  action: 'on' | 'off',
): Promise<void> {
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const req = buildHttpRequest(
    action === 'on' ? config.onUrl : config.offUrl,
    action === 'on' ? config.onMethod : config.offMethod,
    action === 'on' ? config.onBody : config.offBody,
    timeoutMs,
  );
  await axios.request(req);
}

async function httpReadState(config: LocalControlConfig): Promise<LocalDeviceState> {
  if (!config.stateUrl) {
    return { on: null, reachable: true };
  }
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const res = await axios.request({
    url: config.stateUrl,
    method: 'GET',
    timeout: timeoutMs,
  });
  const data = res?.data;
  const raw = config.statePath ? resolvePath(data, config.statePath) : data;
  const on = toBooleanValue(raw);
  return { on, reachable: true };
}

// ────────────────────────────── Modbus TCP ──────────────────────────────

function crc16Modbus(buf: Buffer): number {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return crc & 0xffff;
}

function buildModbusFrame(payload: Buffer): Buffer {
  const withCrc = Buffer.alloc(payload.length + 2);
  payload.copy(withCrc, 0);
  const crc = crc16Modbus(payload);
  withCrc.writeUInt16LE(crc, payload.length);
  return withCrc;
}

function modbusRequest(
  ip: string,
  port: number,
  unitId: number,
  payload: Buffer,
  expectFn: (resp: Buffer) => void,
  timeoutMs = 4000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port, timeout: timeoutMs });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('Modbus 请求超时'));
    }, timeoutMs + 500);
    sock.on('connect', () => {
      sock.write(buildModbusFrame(payload));
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        expectFn(buf);
        clearTimeout(timer);
        sock.destroy();
        resolve();
      } catch {
        // 数据不完整，继续等待
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Modbus 连接失败：${err?.message || String(err)}`));
    });
    sock.on('close', () => clearTimeout(timer));
  });
}

/** 写单个线圈（功能码 0x05）：开关控制 */
async function modbusWriteCoil(
  ip: string,
  config: LocalControlConfig,
  on: boolean,
): Promise<void> {
  const port = config.modbusPort ?? MODBUS_DEFAULT_PORT;
  const unitId = config.modbusUnitId ?? MODBUS_DEFAULT_UNIT;
  const addr = config.coilAddress ?? 0;
  if (!Number.isFinite(addr) || addr < 0 || addr > 0xffff) {
    throw new Error('Modbus 线圈地址无效');
  }
  const payload = Buffer.alloc(5);
  payload[0] = unitId;
  payload[1] = 0x05; // write single coil
  payload.writeUInt16BE(addr, 2);
  payload.writeUInt16BE(on ? 0xff00 : 0x0000, 4);
  await modbusRequest(ip, port, unitId, payload, (resp) => {
    if (resp.length < 6) throw new Error('incomplete');
    if (resp[0] !== unitId || resp[1] !== 0x05) throw new Error('modbus ack mismatch');
    if (resp.readUInt16BE(2) !== addr) throw new Error('modbus address mismatch');
  });
}

/** 读单个线圈（功能码 0x01）：状态查询 */
async function modbusReadCoil(
  ip: string,
  config: LocalControlConfig,
): Promise<boolean | null> {
  const port = config.modbusPort ?? MODBUS_DEFAULT_PORT;
  const unitId = config.modbusUnitId ?? MODBUS_DEFAULT_UNIT;
  const addr = config.coilAddress ?? 0;
  if (!Number.isFinite(addr) || addr < 0 || addr > 0xffff) {
    throw new Error('Modbus 线圈地址无效');
  }
  const payload = Buffer.alloc(6);
  payload[0] = unitId;
  payload[1] = 0x01; // read coils
  payload.writeUInt16BE(addr, 2);
  payload.writeUInt16BE(1, 4);
  let result: boolean | null = null;
  await modbusRequest(ip, port, unitId, payload, (resp) => {
    if (resp.length < 4) throw new Error('incomplete');
    if (resp[0] !== unitId || resp[1] !== 0x01) throw new Error('modbus ack mismatch');
    const byteCount = resp[2];
    if (resp.length < 3 + byteCount + 2) throw new Error('incomplete');
    const dataByte = resp[3];
    result = (dataByte & 0x01) === 0x01;
  });
  return result;
}

// ────────────────────────────── 主入口 ──────────────────────────────

export const localDeviceAdapter = {
  /** 局域网设备开关控制 */
  async control(
    localip: string | null | undefined,
    config: LocalControlConfig | null | undefined,
    action: 'on' | 'off',
  ): Promise<void> {
    const cfg = getConfig(config);
    if (!localip) throw new Error('该局域网设备未配置 IP 地址');
    if (!cfg || !cfg.protocol) throw new Error('该局域网设备未配置控制协议');
    switch (cfg.protocol) {
      case 'http':
        await httpControl(cfg, action);
        return;
      case 'modbus_tcp':
        await modbusWriteCoil(localip, cfg, action === 'on');
        return;
      case 'tuya_local':
        throw new Error('涂鸦本地协议暂未支持，请选择 HTTP 或 Modbus TCP');
      case 'miio_lan':
        throw new Error('MiIO LAN 协议暂未支持，请选择 HTTP 或 Modbus TCP');
      default:
        throw new Error(`未知的控制协议：${(cfg as any)?.protocol}`);
    }
  },

  /** 局域网设备状态读取 */
  async readState(
    localip: string | null | undefined,
    config: LocalControlConfig | null | undefined,
  ): Promise<LocalDeviceState> {
    const cfg = getConfig(config);
    if (!localip) return { on: null, reachable: false, error: '未配置 IP' };
    if (!cfg || !cfg.protocol) return { on: null, reachable: false, error: '未配置控制协议' };
    try {
      switch (cfg.protocol) {
        case 'http':
          return await httpReadState(cfg);
        case 'modbus_tcp':
          return { on: await modbusReadCoil(localip, cfg), reachable: true };
        default:
          return { on: null, reachable: true };
      }
    } catch (e: any) {
      return { on: null, reachable: false, error: e?.message || String(e) };
    }
  },
};
