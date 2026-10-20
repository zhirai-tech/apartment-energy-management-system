import dgram from 'node:dgram';
import crypto from 'node:crypto';

/**
 * miIO 局域网协议（UDP 54321）。
 *
 * 已对 lxzn.switch.cbcsmj（Wi-Fi 智能通断器，10 台实测）验证：
 * - 握手：32 字节 hello 包 `21 31 00 20` + 28×0xFF
 * - 设备应答 32 字节：header(16) + checksum(16)，其中 deviceId 在 header[8..12]、stamp 在 [12..16]（大端）
 * - 数据包：header(16) + checksum(16) + AES-128-CBC(payload)
 *   key = md5(token)，iv = md5(key + token)[0..16]
 *   checksum = md5(header + token + encrypted)
 * - 该型号命令：`get_properties` / `set_properties`（是这一批 lxzn 设备的方言；
 *   标准 miotspec/prop/get 会被回 -9999 undefined command）
 *
 * 属性映射（实测与云端值一致）：
 * - siid2.piid1  = 开关状态（boolean）
 * - siid2.piid6  = 温度（℃）
 * - siid3.piid1  = 累计电量（0.01 kWh）
 * - siid3.piid2  = 电流（mA）
 * - siid3.piid3  = 电压（0.1 V）
 * - siid3.piid6  = 功率（W）
 */

const PORT = 54321;
const MAGIC = [0x21, 0x31];

export interface MiioBreakerState {
  did: string;
  online: boolean;
  power: boolean;
  powerW: number;
  currentA: number;
  voltageV: number;
  totalKwh: number;
  temperatureC: number | null;
  raw: Record<string, unknown>;
}

export interface MiioBreakerCredentials {
  ip: string;
  token: string;
  did: string;
}

function md5(...parts: Buffer[]): Buffer {
  const hash = crypto.createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function decrypt(token: Buffer, encrypted: Buffer): Buffer {
  const key = md5(token);
  const iv = md5(key, token).subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function encrypt(token: Buffer, payload: Buffer): Buffer {
  const key = md5(token);
  const iv = md5(key, token).subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

interface MiioSession {
  socket: dgram.Socket;
  deviceId: number;
  stamp: number;
}

function udpSend(socket: dgram.Socket, packet: Buffer, ip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, 0, packet.length, PORT, ip, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitMessage(socket: dgram.Socket, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners('message');
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('message', (message) => {
      clearTimeout(timer);
      finish(Buffer.from(message));
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

function buildDataPacket(
  token: Buffer,
  deviceId: number,
  stamp: number,
  payload: Record<string, unknown>,
): Buffer {
  const encrypted = encrypt(token, Buffer.from(JSON.stringify(payload)));
  const header = Buffer.alloc(16);
  header[0] = MAGIC[0];
  header[1] = MAGIC[1];
  header.writeUInt16BE(32 + encrypted.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);
  const checksum = md5(header, token, encrypted);
  return Buffer.concat([header, checksum, encrypted]);
}

function parseDataResponse(token: Buffer, raw: Buffer): Record<string, any> | null {
  if (!raw || raw.length < 48 || raw[0] !== MAGIC[0] || raw[1] !== MAGIC[1]) return null;
  const total = raw.readUInt16BE(2) & 0x3fff;
  if (total < 48 || total > raw.length) return null;
  const header = raw.subarray(0, 16);
  const checksum = raw.subarray(16, 32);
  const encrypted = raw.subarray(32, total);
  const expected = md5(header, token, encrypted);
  if (!expected.equals(checksum)) return null;
  try {
    return JSON.parse(decrypt(token, encrypted).toString('utf8'));
  } catch {
    return null;
  }
}

async function openSession(credentials: MiioBreakerCredentials, timeoutMs = 1800): Promise<MiioSession | null> {
  const socket = dgram.createSocket('udp4');
  try {
    const hello = Buffer.alloc(32, 0xff);
    hello[0] = MAGIC[0];
    hello[1] = MAGIC[1];
    hello[2] = 0x00;
    hello[3] = 0x20;
    await udpSend(socket, hello, credentials.ip);
    const response = await waitMessage(socket, timeoutMs);
    if (!response || response.length !== 32 || response[0] !== MAGIC[0] || response[1] !== MAGIC[1]) {
      socket.close();
      return null;
    }
    const deviceId = response.readUInt32BE(8);
    const stamp = response.readUInt32BE(12);
    if (String(deviceId) !== String(credentials.did)) {
      socket.close();
      return null;
    }
    return { socket, deviceId, stamp };
  } catch {
    try {
      socket.close();
    } catch {
      /* noop */
    }
    return null;
  }
}

async function request(
  credentials: MiioBreakerCredentials,
  payload: Record<string, unknown>,
  timeoutMs = 2200,
): Promise<Record<string, any> | null> {
  const session = await openSession(credentials, timeoutMs);
  if (!session) return null;
  try {
    const token = Buffer.from(credentials.token, 'hex');
    const packet = buildDataPacket(token, session.deviceId, session.stamp, payload);
    await udpSend(session.socket, packet, credentials.ip);
    const response = await waitMessage(session.socket, timeoutMs);
    if (!response) return null;
    return parseDataResponse(token, response);
  } finally {
    try {
      session.socket.close();
    } catch {
      /* noop */
    }
  }
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 读取一台空开的实时状态（局域网直连，不依赖外网） */
export async function readBreakerState(
  credentials: MiioBreakerCredentials,
): Promise<MiioBreakerState | null> {
  const response = await request(credentials, {
    id: 1,
    method: 'get_properties',
    params: [
      { did: credentials.did, siid: 2, piid: 1 },
      { did: credentials.did, siid: 2, piid: 6 },
      { did: credentials.did, siid: 3, piid: 1 },
      { did: credentials.did, siid: 3, piid: 2 },
      { did: credentials.did, siid: 3, piid: 3 },
      { did: credentials.did, siid: 3, piid: 6 },
    ],
  });
  if (!response || !Array.isArray(response.result)) return null;
  const values: Record<string, unknown> = {};
  for (const item of response.result as Array<Record<string, any>>) {
    if (item?.code === 0) values[`${item.siid}_${item.piid}`] = item.value;
  }
  const num = (key: string): number => {
    const value = Number(values[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    did: String(credentials.did),
    online: true,
    power: values['2_1'] === true,
    powerW: Math.round(num('3_6')),
    currentA: round(num('3_2') / 1000, 3),
    voltageV: round(num('3_3') / 10, 1),
    totalKwh: round(num('3_1') / 100, 2),
    temperatureC: values['2_6'] !== undefined ? round(Number(values['2_6']), 1) : null,
    raw: values,
  };
}

/** 局域网开关空开（不依赖外网） */
export async function setBreakerPower(
  credentials: MiioBreakerCredentials,
  on: boolean,
): Promise<boolean> {
  const response = await request(credentials, {
    id: 2,
    method: 'set_properties',
    params: [{ did: credentials.did, siid: 2, piid: 1, value: on }],
  });
  if (!response || !Array.isArray(response.result)) return false;
  return (response.result as Array<Record<string, any>>).every((item) => item?.code === 0);
}
