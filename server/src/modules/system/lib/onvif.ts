import dgram from 'node:dgram';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import axios from 'axios';

/**
 * ONVIF 局域网摄像头接入（零第三方依赖实现）
 *
 * 能力：
 * - WS-Discovery 组播发现局域网内 ONVIF 摄像头
 * - 标准 OFFVIF SOAP 调用：GetDeviceInformation / GetCapabilities / GetProfiles /
 *   GetStreamUri / GetSnapshotUri（含 WS-Security UsernameToken 摘要认证）
 * - RTSP 地址品牌模板兜底（ONVIF 不可用时）
 * - ffmpeg 探测 RTSP 源是否真的可拉流（不依赖 ffprobe）
 *
 * 说明：本文件只做"发现/探测/取地址"，不负责播放与录像；
 * 播放/录像复用项目已有的 ffmpeg HLS 代理（systemService.ensureCameraStreamProxy）。
 */

export interface OnvifDiscoveredDevice {
  ip: string;
  xaddr?: string | null;
  scopes?: string | null;
  name?: string | null;
  hardware?: string | null;
}

export interface OnvifProfile {
  token: string;
  name: string;
  encoding: string | null;
  width: number | null;
  height: number | null;
  rtspUrl: string | null;
  snapshotUrl: string | null;
}

/** 从 ONVIF 协议自动识别到的摄像头能力（不同摄像头支持的功能不一样，前端按需显示） */
export interface OnvifCapabilities {
  /** 云台 */
  ptz: boolean;
  /** 事件服务可用 */
  events: boolean;
  /** 移动侦测 */
  motion: boolean;
  /** 人形侦测 */
  human: boolean;
  /** 人脸侦测 */
  face: boolean;
  /** 越界/绊线侦测 */
  line: boolean;
  /** 区域入侵侦测 */
  intrusion: boolean;
  /** 遮挡/防拆报警 */
  tamper: boolean;
  /** 物品遗留（画面中多出物体） */
  objectLeft: boolean;
  /** 物品拿取（画面中物体消失） */
  objectRemoved: boolean;
  /** 智能追踪 */
  smartTracking: boolean;
  /** 音频输入 */
  audio: boolean;
  /** 具备智能分析能力 */
  analytics: boolean;
  /** 录像能力（本系统统一支持，恒为 true） */
  recording: boolean;
}

export interface OnvifProbeResult {
  ok: boolean;
  ip: string;
  port: number;
  manufacturer: string | null;
  model: string | null;
  firmwareVersion: string | null;
  serialNumber: string | null;
  hardwareId: string | null;
  mediaXAddr: string | null;
  hasPTZ: boolean;
  capabilities: OnvifCapabilities;
  profiles: OnvifProfile[];
  mainRtspUrl: string | null;
  subRtspUrl: string | null;
  snapshotUrl: string | null;
  errorMessage?: string;
  triedUrls?: string[];
}

export interface RtspTestResult {
  ok: boolean;
  url: string;
  errorMessage?: string;
  /** ffmpeg 解析到的流信息摘要（编码/分辨率），解析不到则为 null */
  videoInfo?: string | null;
}

const ONVIF_MULTICAST_ADDR = '239.255.255.250';
const ONVIF_DISCOVERY_PORT = 3702;
const DEFAULT_TIMEOUT_MS = 12000;

// ───────────────────────────── 通用工具 ─────────────────────────────

function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 取第一个匹配标签（忽略命名空间前缀）的文本内容 */
function firstTagText(xml: string, localName: string): string | null {
  if (!xml) return null;
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
    'i',
  );
  const m = xml.match(re);
  if (!m) return null;
  const text = xmlUnescape(m[1].replace(/<[^>]+>/g, '').trim());
  return text || null;
}

/** 取所有匹配标签（忽略命名空间前缀）的完整块（含属性） */
function allTagBlocks(xml: string, localName: string): string[] {
  if (!xml) return [];
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>[\\s\\S]*?</(?:[\\w.-]+:)?${localName}>`,
    'gi',
  );
  return xml.match(re) ?? [];
}

/** 取标签的某个属性值 */
function attrValue(tag: string, attrName: string): string | null {
  const re = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? xmlUnescape(m[1]) : null;
}

function normalizeIp(ip: string): string {
  return String(ip ?? '').trim();
}

function buildHostUrl(ip: string, port: number, pathname: string): string {
  const host = normalizeIp(ip);
  const p = Number(port) || 80;
  const portPart = p === 80 ? '' : `:${p}`;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `http://${host}${portPart}${path}`;
}

/** 从 ONVIF 返回的 XAddr/Uri 中提取主机 IP */
function extractHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/:?]+)/i);
  return m ? m[1] : null;
}

// ───────────────────────────── WS-Security ─────────────────────────────

interface OnvifCallContext {
  timeoutMs: number;
  /** 摄像头与服务器的时钟偏差（毫秒）。WS-Security 摘要包含时间戳，偏差过大会认证失败 */
  clockOffsetMs: number;
}

function buildWsSecurityHeader(
  username: string,
  password: string,
  clockOffsetMs: number,
): string {
  const nonceBytes = randomBytes(16);
  const nonce = nonceBytes.toString('base64');
  const created = new Date(Date.now() + (Number(clockOffsetMs) || 0)).toISOString();
  const digest = createHash('sha1')
    .update(Buffer.concat([nonceBytes, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');
  return (
    '<s:Header>' +
    '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
    'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" s:mustUnderstand="1">' +
    '<wsse:UsernameToken>' +
    `<wsse:Username>${xmlEscape(username)}</wsse:Username>` +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' +
    `${digest}</wsse:Password>` +
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' +
    `${nonce}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    '</wsse:UsernameToken>' +
    '</wsse:Security>' +
    '</s:Header>'
  );
}

function buildSoapEnvelope(body: string, securityHeader: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope ' +
    'xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
    'xmlns:tev="http://www.onvif.org/ver10/events/wsdl" ' +
    'xmlns:tt="http://www.onvif.org/ver10/schema">' +
    securityHeader +
    `<s:Body>${body}</s:Body>` +
    '</s:Envelope>'
  );
}

async function onvifRequest(
  url: string,
  body: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<{ ok: boolean; status: number; xml: string; errorMessage?: string }> {
  const security = username ? buildWsSecurityHeader(username, password, ctx.clockOffsetMs) : '<s:Header/>';
  const envelope = buildSoapEnvelope(body, security);
  const headers: Record<string, string> = {
    'Content-Type': 'application/soap+xml; charset=utf-8',
    'Accept': 'application/soap+xml, application/xml, text/xml',
  };
  if (username) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  }
  const timeoutMs = ctx.timeoutMs;
  try {
    const resp = await axios.post(url, envelope, {
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
      responseType: 'text',
      transitional: { silentJSONParsing: true },
    });
    const xml = typeof resp.data === 'string' ? resp.data : String(resp.data ?? '');
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, status: resp.status, xml };
    }
    // 400/500 时 ONVIF 也可能返回 Fault 文本，保留用于诊断
    return {
      ok: false,
      status: resp.status,
      xml,
      errorMessage: `ONVIF HTTP ${resp.status}: ${xml.slice(0, 300)}`,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      xml: '',
      errorMessage:
        error?.code === 'ECONNREFUSED'
          ? '摄像头 ONVIF 端口拒绝连接（请确认端口/IP 正确，或设备开启 ONVIF）'
          : error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED'
            ? '连接摄像头超时'
            : error?.message || String(error),
    };
  }
}

// ───────────────────────────── 发现 ─────────────────────────────

function buildDiscoveryProbe(): string {
  const messageId = `uuid:${randomUUID()}`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    '<e:Header>' +
    `<w:MessageID>${messageId}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header>' +
    '<e:Body>' +
    '<d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>' +
    '</e:Body>' +
    '</e:Envelope>'
  );
}

/** WS-Discovery：组播发现局域网内 ONVIF 设备（部分 AP 会拦截组播，失败时用手动 IP 添加） */
export async function discoverOnvifDevices(timeoutMs = 5000): Promise<OnvifDiscoveredDevice[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, OnvifDiscoveredDevice>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* noop */
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, Math.max(1500, timeoutMs));

    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    socket.on('message', (msg, rinfo) => {
      const xml = msg.toString('utf8');
      if (!/ProbeMatches|ProbeMatch/i.test(xml)) return;
      const xaddrs = firstTagText(xml, 'XAddrs');
      const scopes = firstTagText(xml, 'Scopes');
      const endpoint = firstTagText(xml, 'Address');
      const ip = extractHostFromUrl(xaddrs) ?? rinfo.address;
      if (!ip) return;
      const decodedScopes = scopes ? decodeURIComponent(scopes.replace(/\+/g, ' ')) : '';
      const nameMatch = decodedScopes.match(/onvif:\/\/www\.onvif\.org\/name\/([^/\s]+)/i);
      const hardwareMatch = decodedScopes.match(/onvif:\/\/www\.onvif\.org\/hardware\/([^/\s]+)/i);
      found.set(ip, {
        ip,
        xaddr: xaddrs,
        scopes: decodedScopes || null,
        name: nameMatch ? decodeURIComponent(nameMatch[1]) : null,
        hardware: hardwareMatch ? decodeURIComponent(hardwareMatch[1]) : null,
      });
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(2);
      } catch {
        /* noop */
      }
      const probe = Buffer.from(buildDiscoveryProbe(), 'utf8');
      socket.send(probe, ONVIF_DISCOVERY_PORT, ONVIF_MULTICAST_ADDR, (err) => {
        if (err) {
          clearTimeout(timer);
          finish();
        }
      });
    });
  });
}

// ───────────────────────────── ONVIF 设备探测 ─────────────────────────────

/** 请求 GetSystemDateAndTime（ONVIF 规范允许未认证），用于校正摄像头与服务器的时钟偏差 */
async function getSystemDateAndTime(
  deviceServiceUrl: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<number> {
  const resp = await onvifRequest(
    deviceServiceUrl,
    '<tds:GetSystemDateAndTime/>',
    '',
    '',
    { timeoutMs: Math.min(ctx.timeoutMs, 6000), clockOffsetMs: ctx.clockOffsetMs },
  );
  if (!resp.ok) return 0;
  const block = allTagBlocks(resp.xml, 'UTCDateTime')[0] ?? resp.xml;
  const num = (tag: string): number => Number(firstTagText(block, tag) ?? '') || 0;
  const year = num('Year');
  const month = num('Month');
  const day = num('Day');
  const hour = num('Hour');
  const minute = num('Minute');
  const second = num('Second');
  if (!year || !month || !day) return 0;
  const cameraTime = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = cameraTime - Date.now();
  // 偏差超过 ±1 天视为摄像头时间异常/解析错误，不采用
  if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 3600 * 1000) return 0;
  return offset;
}

/** 请求 GetDeviceInformation */
async function getDeviceInformation(
  deviceServiceUrl: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<{ ok: boolean; info: Record<string, string | null>; errorMessage?: string }> {
  const resp = await onvifRequest(
    deviceServiceUrl,
    '<tds:GetDeviceInformation/>',
    username,
    password,
    ctx,
  );
  if (!resp.ok) return { ok: false, info: {}, errorMessage: resp.errorMessage };
  return {
    ok: true,
    info: {
      manufacturer: firstTagText(resp.xml, 'Manufacturer'),
      model: firstTagText(resp.xml, 'Model'),
      firmwareVersion: firstTagText(resp.xml, 'FirmwareVersion'),
      serialNumber: firstTagText(resp.xml, 'SerialNumber'),
      hardwareId: firstTagText(resp.xml, 'HardwareId'),
    },
  };
}

/** 请求 GetCapabilities，拿 Media/Events/Analytics 服务地址与 PTZ 能力 */
async function getCapabilities(
  deviceServiceUrl: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<{
  mediaXAddr: string | null;
  eventsXAddr: string | null;
  analyticsXAddr: string | null;
  hasPTZ: boolean;
}> {
  const resp = await onvifRequest(
    deviceServiceUrl,
    '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
    username,
    password,
    ctx,
  );
  if (!resp.ok) return { mediaXAddr: null, eventsXAddr: null, analyticsXAddr: null, hasPTZ: false };
  const mediaBlock = allTagBlocks(resp.xml, 'Media')[0] ?? '';
  const eventsBlock = allTagBlocks(resp.xml, 'Events')[0] ?? '';
  const analyticsBlock = allTagBlocks(resp.xml, 'Analytics')[0] ?? '';
  const ptzBlock = allTagBlocks(resp.xml, 'PTZ')[0] ?? '';
  return {
    mediaXAddr: firstTagText(mediaBlock, 'XAddr'),
    eventsXAddr: firstTagText(eventsBlock, 'XAddr'),
    analyticsXAddr: firstTagText(analyticsBlock, 'XAddr'),
    hasPTZ: !!ptzBlock,
  };
}

/** 请求 GetProfiles，解析出每个档位的编码/分辨率 */
async function getProfiles(
  mediaServiceUrl: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<{ profiles: OnvifProfile[]; hasAudio: boolean }> {
  const resp = await onvifRequest(mediaServiceUrl, '<trt:GetProfiles/>', username, password, ctx);
  if (!resp.ok) return { profiles: [], hasAudio: false };
  const profileBlocks = allTagBlocks(resp.xml, 'Profiles');
  const profiles: OnvifProfile[] = [];
  let hasAudio = false;
  for (const block of profileBlocks) {
    const token = attrValue(block, 'token') ?? attrValue(block, 'Token') ?? '';
    const name = firstTagText(block, 'Name') ?? token;
    const encoderBlock = allTagBlocks(block, 'VideoEncoderConfiguration')[0] ?? block;
    const encoding = firstTagText(encoderBlock, 'Encoding');
    const width = Number(firstTagText(block, 'Width') ?? '') || null;
    const height = Number(firstTagText(block, 'Height') ?? '') || null;
    if (/AudioEncoderConfiguration/i.test(block)) hasAudio = true;
    profiles.push({
      token: token || name,
      name,
      encoding,
      width,
      height,
      rtspUrl: null,
      snapshotUrl: null,
    });
  }
  return { profiles, hasAudio };
}

/** 请求 GetEventProperties，用于识别摄像头支持哪些智能侦测功能（移动/人形/人脸/越界等） */
async function getEventProperties(
  eventsServiceUrl: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<{ ok: boolean; raw: string }> {
  const resp = await onvifRequest(eventsServiceUrl, '<tev:GetEventProperties/>', username, password, ctx);
  if (!resp.ok) return { ok: false, raw: '' };
  return { ok: true, raw: resp.xml };
}

function deriveCapabilities(input: {
  hasPTZ: boolean;
  hasAudio: boolean;
  eventsOk: boolean;
  analytics: boolean;
  raw: string;
}): OnvifCapabilities {
  const raw = input.raw ?? '';
  const test = (re: RegExp): boolean => re.test(raw);
  const motion = test(/CellMotionDetector|MotionDetector|MotionAlarm|Motion\b/i);
  const human = test(/PeopleDetect|HumanDetector|HumanDetection|HumanRecognition|MyRuleDetector\/PeopleDetect/i);
  const face = test(/FaceDetect|FaceDetection|FaceRecognition|FaceAnalytics/i);
  const line = test(/LineDetector|LineCross|Tripwire/i);
  const intrusion = test(/FieldDetector|IntrusionDetect|RegionEntrance|RegionExiting|LoiteringDetect/i);
  const tamper = test(/TamperDetector|Tamper|SceneChangeDetect|VideoBlur|VideoLoss|VideoTamper/i);
  const objectLeft = test(/ObjectLeft|AbandonedObject|UnattendedObject|ObjectAbandoned|LeftObject/i);
  const objectRemoved = test(/ObjectRemoved|MissingObject|ObjectMissing|ObjectTaken|TakenObject/i);
  const smartTracking = test(/AutoTracking|SmartTracking|TrackingDetect|ObjectTracking/i);
  const audio = input.hasAudio || test(/AudioDetector|AudioAnalytics|SoundDetect/i);
  return {
    ptz: input.hasPTZ,
    events: input.eventsOk,
    motion,
    human,
    face,
    line,
    intrusion,
    tamper,
    objectLeft,
    objectRemoved,
    smartTracking,
    audio,
    analytics: input.analytics || human || face || line || intrusion,
    // 本系统对局域网摄像头统一支持录像（ffmpeg 拉流录制）
    recording: true,
  };
}

/** 请求 GetStreamUri */
async function getStreamUri(
  mediaServiceUrl: string,
  profileToken: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<string | null> {
  const body =
    '<trt:GetStreamUri>' +
    '<trt:StreamSetup>' +
    '<tt:Stream>RTP-Unicast</tt:Stream>' +
    '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>' +
    '</trt:StreamSetup>' +
    `<trt:ProfileToken>${xmlEscape(profileToken)}</trt:ProfileToken>` +
    '</trt:GetStreamUri>';
  const resp = await onvifRequest(mediaServiceUrl, body, username, password, ctx);
  if (!resp.ok) return null;
  return firstTagText(resp.xml, 'Uri');
}

/** 请求 GetSnapshotUri */
async function getSnapshotUri(
  mediaServiceUrl: string,
  profileToken: string,
  username: string,
  password: string,
  ctx: OnvifCallContext,
): Promise<string | null> {
  const body =
    '<trt:GetSnapshotUri>' +
    `<trt:ProfileToken>${xmlEscape(profileToken)}</trt:ProfileToken>` +
    '</trt:GetSnapshotUri>';
  const resp = await onvifRequest(mediaServiceUrl, body, username, password, ctx);
  if (!resp.ok) return null;
  return firstTagText(resp.xml, 'Uri');
}

/**
 * 探测单台 ONVIF 摄像头：设备信息 + 媒体档位 + RTSP/快照地址。
 * 依次尝试 /onvif/device_service 与 /onvif/Media 两个标准入口，兼容不同品牌。
 */
export async function probeOnvifDevice(input: {
  ip: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}): Promise<OnvifProbeResult> {
  const ip = normalizeIp(input.ip);
  const port = Number(input.port) || 80;
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const timeoutMs = Math.max(3000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS);
  // 摄像头时钟与服务器可能有偏差；WS-Security 摘要带时间戳，偏差大会导致认证失败，
  // 所以先发一次未认证的 GetSystemDateAndTime 校正（失败也不影响后续）。
  const ctx: OnvifCallContext = { timeoutMs, clockOffsetMs: 0 };

  const result: OnvifProbeResult = {
    ok: false,
    ip,
    port,
    manufacturer: null,
    model: null,
    firmwareVersion: null,
    serialNumber: null,
    hardwareId: null,
    mediaXAddr: null,
    hasPTZ: false,
    capabilities: {
      ptz: false,
      events: false,
      motion: false,
      human: false,
      face: false,
      line: false,
      intrusion: false,
      tamper: false,
      objectLeft: false,
      objectRemoved: false,
      smartTracking: false,
      audio: false,
      analytics: false,
      recording: true,
    },
    profiles: [],
    mainRtspUrl: null,
    subRtspUrl: null,
    snapshotUrl: null,
    triedUrls: [],
  };
  if (!ip) {
    result.errorMessage = '缺少摄像头 IP 地址';
    return result;
  }
  if (!username) {
    result.errorMessage = 'ONVIF 需要填写账号密码';
  }

  const candidates = [
    buildHostUrl(ip, port, '/onvif/device_service'),
    buildHostUrl(ip, port, '/onvif/device_service/'),
    buildHostUrl(ip, port, '/onvif/device'),
  ];
  let deviceServiceUrl: string | null = null;
  let lastError: string | undefined;
  // 设备信息探测限制单次超时，避免 IP 填错时探测等待过久（3 个候选路径 × 12s 太久）
  const probeCtx: OnvifCallContext = { ...ctx, timeoutMs: Math.min(timeoutMs, 8000) };

  for (const url of candidates) {
    result.triedUrls!.push(url);
    const info = await getDeviceInformation(url, username, password, probeCtx);
    if (info.ok) {
      deviceServiceUrl = url;
      result.manufacturer = info.info.manufacturer;
      result.model = info.info.model;
      result.firmwareVersion = info.info.firmwareVersion;
      result.serialNumber = info.info.serialNumber;
      result.hardwareId = info.info.hardwareId;
      break;
    }
    lastError = info.errorMessage;
    // 网络层不可达/端口拒绝时，换 URL 路径也不会成功，直接结束探测（避免等待 3 倍超时）
    if (/拒绝|超时|refused|timed out|econn|ehost|enet|ehostunreach/i.test(lastError ?? '')) break;
  }

  if (!deviceServiceUrl) {
    const authFailed = /401|403|not authorized|notauthorized|unauthorized|sender|fault/i.test(
      lastError ?? '',
    );
    result.errorMessage = authFailed
      ? 'ONVIF 认证失败：账号或密码不正确（注意是摄像头的 ONVIF 账号，不是 App 登录密码）'
      : lastError ||
        'ONVIF 探测失败：设备未开启 ONVIF、端口不对或 IP 不可达（常见端口 80 / 8000 / 2020 / 8899）';
    return result;
  }

  // 校正摄像头时钟偏差（部分设备时间不准会导致 WS-Security 认证被拒）
  ctx.clockOffsetMs = await getSystemDateAndTime(deviceServiceUrl, username, password, ctx);

  // 媒体服务地址：优先 GetCapabilities 返回，其次按常见路径回退
  const caps = await getCapabilities(deviceServiceUrl, username, password, ctx);
  result.hasPTZ = caps.hasPTZ;
  const mediaCandidates: string[] = [];
  if (caps.mediaXAddr) {
    mediaCandidates.push(caps.mediaXAddr);
    // 部分设备 XAddr 主机名不可达时，用探测 IP 替换
    const host = extractHostFromUrl(caps.mediaXAddr);
    if (host && host !== ip) {
      mediaCandidates.push(caps.mediaXAddr.replace(host, ip));
    }
  }
  mediaCandidates.push(buildHostUrl(ip, port, '/onvif/media_service'));
  mediaCandidates.push(buildHostUrl(ip, port, '/onvif/Media'));
  mediaCandidates.push(deviceServiceUrl);

  let mediaServiceUrl = mediaCandidates[0];
  let profileList: OnvifProfile[] = [];
  let hasAudio = false;
  for (const url of mediaCandidates) {
    const profileResult = await getProfiles(url, username, password, ctx);
    if (profileResult.profiles.length > 0) {
      mediaServiceUrl = url;
      profileList = profileResult.profiles;
      hasAudio = profileResult.hasAudio;
      break;
    }
  }
  result.mediaXAddr = median(caps.mediaXAddr, mediaServiceUrl);

  if (profileList.length === 0) {
    result.errorMessage = 'ONVIF 已连上设备，但读取媒体档位（Profiles）失败，可能是设备仅开放部分 ONVIF 能力';
    return result;
  }

  for (const profile of profileList) {
    profile.rtspUrl = await getStreamUri(mediaServiceUrl, profile.token, username, password, ctx);
  }
  // 快照地址只取最靠前的可用档位
  for (const profile of profileList) {
    if (!profile.rtspUrl) continue;
    profile.snapshotUrl = await getSnapshotUri(mediaServiceUrl, profile.token, username, password, ctx);
    if (profile.snapshotUrl) break;
  }

  const withRtsp = profileList.filter((p) => !!p.rtspUrl);
  // 主码流：H264 且分辨率最高的；子码流：其余最低分辨率的
  const sorted = [...withRtsp].sort((a, b) => {
    const score = (p: OnvifProfile) =>
      (p.encoding && /h264/i.test(p.encoding) ? 1000000 : 0) + (p.width ?? 0) * (p.height ?? 0);
    return score(b) - score(a);
  });
  result.profiles = profileList;
  result.mainRtspUrl = sorted[0]?.rtspUrl ?? null;
  result.subRtspUrl = sorted.length > 1 ? sorted[sorted.length - 1]?.rtspUrl ?? null : null;
  result.snapshotUrl = profileList.find((p) => !!p.snapshotUrl)?.snapshotUrl ?? null;

  // 智能侦测能力识别：优先从 Events 服务 GetEventProperties 读取事件主题，
  // 失败时退回设备 Kestrel/常见路径，最后按"事件服务不可用"处理（不会影响直播/录像）。
  const eventCandidates: string[] = [];
  if (caps.eventsXAddr) eventCandidates.push(caps.eventsXAddr);
  eventCandidates.push(buildHostUrl(ip, port, '/onvif/events_service'));
  eventCandidates.push(buildHostUrl(ip, port, '/onvif/Events'));
  let eventsOk = false;
  let eventsRaw = '';
  for (const url of eventCandidates) {
    const evt = await getEventProperties(url, username, password, ctx);
    if (evt.ok) {
      eventsOk = true;
      eventsRaw = evt.raw;
      break;
    }
  }
  result.capabilities = deriveCapabilities({
    hasPTZ: caps.hasPTZ,
    hasAudio,
    eventsOk,
    analytics: !!caps.analyticsXAddr,
    raw: eventsRaw,
  });

  result.ok = !!result.mainRtspUrl;
  if (!result.ok) {
    result.errorMessage = 'ONVIF 已连上设备，但没取到 RTSP 直播地址（部分设备需要先在 App 内开启 RTSP/ONVIF）';
  }
  return result;
}

function median(a: string | null | undefined, b: string | null | undefined): string | null {
  return a || b || null;
}

// ───────────────────────────── RTSP 品牌模板 ─────────────────────────────

export interface RtspCandidate {
  url: string;
  label: string;
}

function encodeRtspAuth(username: string, password: string): string {
  if (!username) return '';
  return `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
}

/**
 * 按品牌/通用规则生成 RTSP 候选地址（ONVIF 探测失败时的兜底）。
 * 只负责生成候选，是否可用由 testRtspSource 验证。
 */
export function guessRtspUrls(input: {
  ip: string;
  brand?: string | null;
  username?: string | null;
  password?: string | null;
}): RtspCandidate[] {
  const ip = normalizeIp(input.ip);
  const auth = encodeRtspAuth(String(input.username ?? '').trim(), String(input.password ?? ''));
  const brand = String(input.brand ?? '').toLowerCase();
  const list: RtspCandidate[] = [];
  const push = (label: string, path: string) => {
    list.push({ label, url: `rtsp://${auth}${ip}:554${path}` });
  };
  if (/hikvision|海康|ezviz|萤石/.test(brand)) {
    push('海康 主码流', '/Streaming/Channels/101');
    push('海康 子码流', '/Streaming/Channels/102');
  }
  if (/dahua|大华|lechange/.test(brand)) {
    push('大华 主码流', '/cam/realmonitor?channel=1&subtype=0');
    push('大华 子码流', '/cam/realmonitor?channel=1&subtype=1');
  }
  if (/tplink|tp-link|tapo|水星|mercury/.test(brand)) {
    push('TP-Link 主码流', '/stream1');
    push('TP-Link 子码流', '/stream2');
  }
  if (/uniview|宇视/.test(brand)) {
    push('宇视 主码流', '/media/video1');
  }
  if (/reolink/.test(brand)) {
    push('Reolink 主码流', '/h264Preview_01_main');
    push('Reolink 子码流', '/h264Preview_01_sub');
  }
  if (typeof brand === 'string') {
    push('通用 /live/ch0', '/live/ch0');
  }
  push('通用 /stream1', '/stream1');
  push('通用 /h264/ch1/main/av_stream', '/h264/ch1/main/av_stream');
  push('通用 /11', '/11');
  // 去重
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

// ───────────────────────────── RTSP 可用性测试 ─────────────────────────────

function buildRtspProbeInputArgs(url: string): string[] {
  if (/^rtsp:/i.test(url)) {
    return ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-timeout', '5000000', '-i', url];
  }
  return ['-fflags', 'nobuffer', '-i', url];
}

/**
 * 用 ffmpeg 实际拉流 1 秒验证 RTSP 是否可用（不依赖 ffprobe）。
 * 返回 exitCode=0 视为成功；同时从 stderr 里提取编码/分辨率摘要。
 */
export async function testRtspSource(
  url: string,
  timeoutMs = 12000,
): Promise<RtspTestResult> {
  if (!url) return { ok: false, url, errorMessage: 'RTSP 地址为空' };
  return new Promise((resolve) => {
    let settled = false;
    const chunks: string[] = [];
    let proc: ReturnType<typeof spawn> | null = null;
    const finish = (result: RtspTestResult) => {
      if (settled) return;
      settled = true;
      try {
        proc?.kill('SIGKILL');
      } catch {
        /* noop */
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        url,
        errorMessage: `RTSP 测试超时（${Math.round(timeoutMs / 1000)} 秒未取到画面）`,
      });
    }, timeoutMs);
    try {
      proc = spawn(
        'ffmpeg',
        [...buildRtspProbeInputArgs(url), '-t', '1', '-f', 'null', '-'],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );
    } catch (error: any) {
      clearTimeout(timer);
      finish({ ok: false, url, errorMessage: `ffmpeg 启动失败：${error?.message || String(error)}` });
      return;
    }
    proc.stderr?.on('data', (chunk: unknown) => {
      chunks.push(String(chunk));
    });
    proc.on('error', (error: any) => {
      clearTimeout(timer);
      finish({ ok: false, url, errorMessage: `ffmpeg 执行失败：${error?.message || String(error)}` });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const stderr = chunks.join('');
      const videoLine = stderr
        .split(/\r?\n/)
        .find((line) => /Stream #0.*Video:/i.test(line));
      const videoInfo = videoLine
        ? videoLine.replace(/^.*Stream #0(?:\.\d+)?[^:]*:\s*Video:\s*/i, '').trim().slice(0, 80)
        : null;
      if (code === 0) {
        finish({ ok: true, url, videoInfo });
        return;
      }
      const errLine =
        stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /error|failed|refused|timed out|401|403|404|invalid|Unauthorized/i.test(line))
          .pop() ?? stderr.trim().split(/\r?\n/).pop() ?? '';
      finish({
        ok: false,
        url,
        errorMessage: errLine ? errLine.slice(0, 300) : `ffmpeg 拉流失败（exit=${code}）`,
      });
    });
  });
}

/** 给 RTSP URL 注入账号密码（品牌模板/用户手填地址时使用） */
export function injectRtspCredentials(
  url: string,
  username?: string | null,
  password?: string | null,
): string {
  if (!url || !/^rtsp:/i.test(url)) return url;
  if (!username) return url;
  if (/^rtsp:\/\/[^@/]*@/i.test(url)) return url;
  return url.replace(/^rtsp:\/\//i, `rtsp://${encodeRtspAuth(String(username), String(password ?? ''))}`);
}

// ───────────────────────────── PTZ 云台控制（ONVIF） ─────────────────────────────

export type OnvifPtzAction =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'zoomIn'
  | 'zoomOut'
  | 'stop'
  | 'home'
  | 'gotoPreset';

export interface OnvifPtzInput {
  ip: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export interface OnvifPtzPreset {
  token: string;
  name: string;
}

const PTZ_NS = 'xmlns:trt="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"';

interface PtzServiceRef {
  ptzUrl: string;
  profileToken: string;
  username: string;
  password: string;
  ctx: OnvifCallContext;
}

/** 解析摄像头的 ONVIF PTZ 服务地址与第一个 profile token */
async function resolvePtzService(input: OnvifPtzInput): Promise<PtzServiceRef | null> {
  const ip = normalizeIp(input.ip);
  if (!ip) return null;
  const port = Number(input.port) || 80;
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const timeoutMs = Math.max(3000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const ctx: OnvifCallContext = { timeoutMs, clockOffsetMs: 0 };

  const deviceCandidates = [
    buildHostUrl(ip, port, '/onvif/device_service'),
    buildHostUrl(ip, port, '/onvif/device'),
    buildHostUrl(ip, port, '/onvif/device_service/'),
  ];
  let ptzXAddr: string | null = null;
  let mediaXAddr: string | null = null;
  let hasPTZ = false;
  for (const deviceUrl of deviceCandidates) {
    const resp = await onvifRequest(
      deviceUrl,
      '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
      username,
      password,
      ctx,
    );
    if (!resp.ok) continue;
    const ptzBlock = allTagBlocks(resp.xml, 'PTZ')[0] ?? '';
    const mediaBlock = allTagBlocks(resp.xml, 'Media')[0] ?? '';
    ptzXAddr = firstTagText(ptzBlock, 'XAddr');
    mediaXAddr = firstTagText(mediaBlock, 'XAddr');
    hasPTZ = !!ptzBlock;
    break;
  }
  if (!hasPTZ) return null;
  const ptzUrl = ptzXAddr || buildHostUrl(ip, port, '/onvif/ptz_service');

  let profileToken = '';
  if (mediaXAddr) {
    const profResp = await onvifRequest(mediaXAddr, '<trt:GetProfiles/>', username, password, ctx);
    if (profResp.ok) {
      const blocks = allTagBlocks(profResp.xml, 'Profiles');
      profileToken = blocks.length > 0 ? (attrValue(blocks[0], 'token') ?? '') : '';
    }
  }
  if (!profileToken) return null;
  return { ptzUrl, profileToken, username, password, ctx };
}

function ptzContinuousMoveBody(action: OnvifPtzAction, speed: number): string | null {
  const v = Math.min(1, Math.max(0.05, Number(speed) / 100));
  let panTilt: string | null = null;
  switch (action) {
    case 'left':
      panTilt = `<tt:PanTilt x="${-v}" y="0"/>`;
      break;
    case 'right':
      panTilt = `<tt:PanTilt x="${v}" y="0"/>`;
      break;
    case 'up':
      panTilt = `<tt:PanTilt x="0" y="${v}"/>`;
      break;
    case 'down':
      panTilt = `<tt:PanTilt x="0" y="${-v}"/>`;
      break;
    case 'zoomIn':
      panTilt = `<tt:Zoom x="${v}"/>`;
      break;
    case 'zoomOut':
      panTilt = `<tt:Zoom x="${-v}"/>`;
      break;
    default:
      return null;
  }
  return (
    `<trt:ContinuousMove ${PTZ_NS}>` +
    `<trt:ProfileToken>${xmlEscape(profileTokenPlaceholder())}</trt:ProfileToken>` +
    `<trt:Velocity>${panTilt}</trt:Velocity>` +
    `</trt:ContinuousMove>`
  );
}

// 占位函数：真正调用前用字符串替换，避免把 profileToken 传入纯函数时反复拼参数
function profileTokenPlaceholder(): string {
  return '__PROFILE_TOKEN__';
}

/** 执行 ONVIF PTZ 指令（方向移动 / 停止 / 回中 / 跳转预置位） */
export async function controlOnvifPtz(
  input: OnvifPtzInput & { action: OnvifPtzAction; speed?: number; presetToken?: string },
): Promise<{ ok: boolean; supported: boolean; message?: string }> {
  const svc = await resolvePtzService(input);
  if (!svc) {
    return { ok: false, supported: false, message: '摄像头不支持 ONVIF PTZ 或无法连接' };
  }
  const action = input.action;
  const speed = Number(input.speed) || 50;
  let body: string;

  if (action === 'stop') {
    body =
      `<trt:Stop ${PTZ_NS}>` +
      `<trt:ProfileToken>${xmlEscape(svc.profileToken)}</trt:ProfileToken>` +
      `<trt:PanTilt>true</trt:PanTilt><trt:Zoom>true</trt:Zoom>` +
      `</trt:Stop>`;
  } else if (action === 'home') {
    body =
      `<trt:GotoHomePosition ${PTZ_NS}>` +
      `<trt:ProfileToken>${xmlEscape(svc.profileToken)}</trt:ProfileToken>` +
      `</trt:GotoHomePosition>`;
  } else if (action === 'gotoPreset') {
    const presetToken = String(input.presetToken ?? '').trim();
    if (!presetToken) return { ok: false, supported: true, message: '缺少预置位 token' };
    body =
      `<trt:GotoPreset ${PTZ_NS}>` +
      `<trt:ProfileToken>${xmlEscape(svc.profileToken)}</trt:ProfileToken>` +
      `<trt:PresetToken>${xmlEscape(presetToken)}</trt:PresetToken>` +
      `</trt:GotoPreset>`;
  } else {
    const built = ptzContinuousMoveBody(action, speed);
    if (!built) return { ok: false, supported: true, message: `不支持的云台方向：${action}` };
    body = built.split(profileTokenPlaceholder()).join(xmlEscape(svc.profileToken));
  }

  const resp = await onvifRequest(svc.ptzUrl, body, svc.username, svc.password, svc.ctx);
  return {
    ok: resp.ok,
    supported: true,
    message: resp.ok ? undefined : resp.errorMessage || '云台指令执行失败',
  };
}

/** 读取摄像头的 ONVIF 预置位列表 */
export async function getOnvifPtzPresets(
  input: OnvifPtzInput,
): Promise<{ ok: boolean; supported: boolean; presets: OnvifPtzPreset[]; message?: string }> {
  const svc = await resolvePtzService(input);
  if (!svc) return { ok: false, supported: false, presets: [], message: '摄像头不支持 ONVIF PTZ 或无法连接' };
  const body =
    `<trt:GetPresets ${PTZ_NS}>` +
    `<trt:ProfileToken>${xmlEscape(svc.profileToken)}</trt:ProfileToken>` +
    `</trt:GetPresets>`;
  const resp = await onvifRequest(svc.ptzUrl, body, svc.username, svc.password, svc.ctx);
  if (!resp.ok) {
    return { ok: false, supported: true, presets: [], message: resp.errorMessage || '读取预置位失败' };
  }
  const presets: OnvifPtzPreset[] = [];
  const blocks = allTagBlocks(resp.xml, 'Preset');
  for (const block of blocks) {
    const token = attrValue(block, 'token') ?? attrValue(block, 'Token') ?? '';
    if (!token) continue;
    const name = firstTagText(block, 'Name') ?? token;
    presets.push({ token, name });
  }
  return { ok: true, supported: true, presets };
}
