import axios from 'axios';
import crypto from 'crypto';

/**
 * ONVIF 事件订阅（PullPoint）——用于"人形事件触发录像"。
 *
 * 工作方式：
 * 1. CreatePullPointSubscription 拿到订阅地址；
 * 2. 循环 PullMessages（长轮询 8 秒）；
 * 3. 解析 NotificationMessage 的 Topic / SimpleItem：
 *    - Topic 含 PeopleDetector / IsPeople / Human → 人形事件
 *    - Topic 含 CellMotionDetector / IsMotion → 移动事件（人形不可用时的兜底）
 * 4. 定时 Renew，失败自动重连。
 *
 * 已在水星 MIPC852W 实测：CreatePullPointSubscription 成功，可长轮询。
 */

export interface OnvifEventTarget {
  ip: string;
  port: number;
  username: string;
  password: string;
}

export interface OnvifEventWatcherOptions extends OnvifEventTarget {
  /** 收到人形事件 */
  onPerson?: () => void;
  /** 收到移动事件（当摄像头没有人形事件时作为兜底） */
  onMotion?: () => void;
  /** 订阅/拉取出错（仅用于日志，不中断自动重连） */
  onError?: (message: string) => void;
}

type EventKind = 'person' | 'motion';

function buildSecurityHeader(username: string, password: string): string {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
    .digest('base64');
  return (
    '<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
    'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" s:mustUnderstand="1">' +
    `<wsse:UsernameToken><wsse:Username>${username}</wsse:Username>` +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' +
    digest +
    '</wsse:Password>' +
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' +
    nonce.toString('base64') +
    '</wsse:Nonce>' +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`
  );
}

function buildEnvelope(body: string, username: string, password: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
    'xmlns:tev="http://www.onvif.org/ver10/events/wsdl" ' +
    'xmlns:tt="http://www.onvif.org/ver10/schema" ' +
    'xmlns:wsa5="http://www.w3.org/2005/08/addressing">' +
    buildSecurityHeader(username, password) +
    `<s:Body>${body}</s:Body>` +
    '</s:Envelope>'
  );
}

const SOAP_HEADERS = {
  'Content-Type': 'application/soap+xml; charset=utf-8',
  Accept: 'application/soap+xml, application/xml, text/xml',
};

async function soapPost(
  url: string,
  body: string,
  options: OnvifEventWatcherOptions,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; xml: string }> {
  const envelope = buildEnvelope(body, options.username, options.password);
  const headers: Record<string, string> = { ...SOAP_HEADERS };
  if (options.username) {
    headers.Authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')}`;
  }
  try {
    const response = await axios.post(url, envelope, {
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
      responseType: 'text',
      transitional: { silentJSONParsing: true },
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      xml: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      xml: error?.code === 'ECONNABORTED' ? 'timeout' : error?.message || String(error),
    };
  }
}

function extractSubscriptionAddress(xml: string): string | null {
  const match = /<(?:[\w]+:)?Address[^>]*>\s*([^<]+?)\s*<\/(?:[\w]+:)?Address>/i.exec(xml);
  if (!match) return null;
  const value = match[1].trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

function classifyTopic(topic: string): EventKind | null {
  const value = topic.toLowerCase();
  if (value.includes('peopledetector') || value.includes('ispeople') || value.includes('human')) return 'person';
  if (value.includes('cellmotiondetector') || value.includes('ismotion') || value.includes('/motion/')) return 'motion';
  return null;
}

function classifyDataItem(name: string, itemValue: string): EventKind | null {
  const n = name.toLowerCase();
  const v = itemValue.toLowerCase();
  const truthy = v === 'true' || v === '1' || v === 'on';
  if (!truthy) return null;
  if (n.includes('ispeople') || n.includes('people') || n.includes('human')) return 'person';
  if (n.includes('ismotion') || n.includes('motion')) return 'motion';
  return null;
}

export interface OnvifEventWatcherHandle {
  stop: () => void;
  isSupported: () => boolean;
}

/**
 * 启动 ONVIF 事件监听器。返回 handle（stop 可停止）。
 * 订阅地址建立失败时返回 null。
 */
export async function startOnvifEventWatcher(
  options: OnvifEventWatcherOptions,
): Promise<OnvifEventWatcherHandle | null> {
  const serviceUrls = [
    `http://${options.ip}:${options.port}/onvif/service`,
    `http://${options.ip}:${options.port}/onvif/Events`,
  ];

  const createBody =
    '<tev:CreatePullPointSubscription>' +
    '<tev:InitialTerminationTime>PT120S</tev:InitialTerminationTime>' +
    '</tev:CreatePullPointSubscription>';

  let subscriptionAddress: string | null = null;
  for (const serviceUrl of serviceUrls) {
    const created = await soapPost(serviceUrl, createBody, options, 10_000);
    if (created.ok) {
      subscriptionAddress = extractSubscriptionAddress(created.xml);
      if (subscriptionAddress) break;
    }
  }
  if (!subscriptionAddress) {
    options.onError?.('ONVIF 事件订阅失败（摄像头可能不支持 PullPoint）');
    return null;
  }

  let stopped = false;
  let supported = true;
  let pullTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let failureCount = 0;
  let lastPersonAt = 0;
  let lastMotionAt = 0;

  const emit = (kind: EventKind) => {
    const now = Date.now();
    // 同一类事件 2 秒内去重，避免一个事件多条通知重复触发
    if (kind === 'person') {
      if (now - lastPersonAt < 2000) return;
      lastPersonAt = now;
      options.onPerson?.();
    } else {
      if (now - lastMotionAt < 2000) return;
      lastMotionAt = now;
      options.onMotion?.();
    }
  };

  const parseNotifications = (xml: string): void => {
    const topics = Array.from(xml.matchAll(/<(?:[\w]+:)?Topic[^>]*>\s*([^<]+?)\s*</gi)).map((m) => m[1]);
    for (const topic of topics) {
      const kind = classifyTopic(topic);
      if (kind) emit(kind);
    }
    const items = Array.from(
      xml.matchAll(/<(?:[\w]+:)?SimpleItem[^>]*\bName="([^"]+)"[^>]*\bValue="([^"]*)"/gi),
    );
    for (const item of items) {
      const kind = classifyDataItem(item[1], item[2]);
      if (kind) emit(kind);
    }
    // 有些设备只给 PropertyOperation/Topic 不给 SimpleItem，多处理一层 Data/ElementItem 布尔值
    if (topics.length === 0) {
      const hasPeople = /PeopleDetector|IsPeople/i.test(xml);
      const hasMotion = /CellMotionDetector|IsMotion/i.test(xml);
      if (hasPeople) emit('person');
      else if (hasMotion) emit('motion');
    }
  };

  const schedulePull = (delayMs = 0) => {
    if (stopped) return;
    pullTimer = setTimeout(runPull, delayMs);
  };

  const runPull = async () => {
    if (stopped) return;
    const pullBody =
      '<tev:PullMessages>' +
      '<tev:Timeout>PT8S</tev:Timeout>' +
      '<tev:MessageLimit>20</tev:MessageLimit>' +
      '</tev:PullMessages>';
    const response = await soapPost(subscriptionAddress as string, pullBody, options, 20_000);
    if (stopped) return;
    if (response.ok) {
      failureCount = 0;
      parseNotifications(response.xml);
      schedulePull(150);
      return;
    }
    failureCount += 1;
    options.onError?.(`ONVIF 事件拉取失败(status=${response.status}) ${response.xml.slice(0, 160)}`);
    if (failureCount >= 3) {
      // 连续失败：重建订阅（摄像头重启/会话过期常见）
      supported = false;
      const recreated = await recreateSubscription();
      supported = recreated;
      failureCount = 0;
      schedulePull(recreated ? 500 : 5000);
      return;
    }
    schedulePull(2000);
  };

  const recreateSubscription = async (): Promise<boolean> => {
    const created = await soapPost(serviceUrls[0], createBody, options, 10_000);
    const address = created.ok ? extractSubscriptionAddress(created.xml) : null;
    if (!address) return false;
    subscriptionAddress = address;
    return true;
  };

  // 定时续订（PT120S，60 秒续一次，防止订阅过期）
  renewTimer = setInterval(async () => {
    if (stopped) return;
    const renewBody = '<tev:Renew><tev:TerminationTime>PT120S</tev:TerminationTime></tev:Renew>';
    const renewed = await soapPost(subscriptionAddress as string, renewBody, options, 8000);
    if (!renewed.ok) {
      await recreateSubscription();
    }
  }, 60_000);

  schedulePull(200);

  return {
    stop: () => {
      stopped = true;
      if (pullTimer) clearTimeout(pullTimer);
      if (renewTimer) clearInterval(renewTimer);
    },
    isSupported: () => supported,
  };
}
