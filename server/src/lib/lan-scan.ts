import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as net from 'node:net';
import * as dgram from 'node:dgram';

const exec = promisify(execCb);

const TCP_TRIGGER_PORTS: number[] = [
  80, 443, 8000, 8080, 8081, 8888, 9000, 9090, 8443, 443, 3000, 82,
  21, 22, 23, 25, 53, 110, 135, 139, 445, 3389, 22,
  1883, 8883, 5683, 5684,
  502, 503, 102, 10000, 60000,
  554, 8554, 37777, 37778, 34567, 8000,
  6668, 6666, 6669, 6667,
  54321, 54322,
  1900, 2869, 5000,
];

const UDP_TRIGGER_PORTS: number[] = [
  53, 67, 68, 69, 123,
  137, 138, 161, 162, 1900, 3702, 5353,
  5355, 6666, 6667, 9090,
];

function tcpProbeOne(ip: string, port: number, timeoutMs: number, localAddress?: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroySoon?.(); } catch { /* noop */ }
      try { sock.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    const connOpts: net.TcpSocketConnectOpts = { host: ip, port, family: 4 };
    if (localAddress) (connOpts as any).localAddress = localAddress;
    const sock = net.createConnection(connOpts, () => finish(true));
    sock.on('connect', () => finish(true));
    sock.on('ready', () => finish(true));
    sock.on('error', () => finish(false));
    sock.on('timeout', () => finish(false));
    sock.on('close', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
    setTimeout(() => finish(false), timeoutMs + 220);
  });
}

function udpProbeOne(ip: string, port: number, timeoutMs: number, localAddress?: string | null): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { sock.close(); } catch { /* noop */ }
      resolve();
    };
    const sockOpts: dgram.SocketOptions = { type: 'udp4' };
    if (localAddress) (sockOpts as any).reuseAddr = true;
    const sock = dgram.createSocket(sockOpts);
    sock.once('error', finish);
    sock.once('close', finish);
    const t = setTimeout(finish, timeoutMs + 100);
    try {
      const payload = Buffer.from([
        0x00, 0x00, 0x00, 0x00,
        0x01, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]);
      const doSend = () => {
        sock.send(payload, 0, payload.length, port, ip, () => {
          setTimeout(finish, Math.max(70, Math.floor(timeoutMs / 2)));
        });
      };
      if (localAddress) {
        try { sock.bind(0, localAddress); setTimeout(doSend, 30); } catch { doSend(); }
      } else {
        doSend();
      }
    } catch {
      clearTimeout(t);
      finish();
    }
  });
}

async function tcpTriggerArp(list: string[], concurrency: number, timeoutMs: number, localAbort: AbortSignal, portSlice = 10, localAddress?: string | null): Promise<Set<string>> {
  const touched = new Set<string>();
  let index = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, list.length));
  const perIpHardMax = timeoutMs * 10 + 300;
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (localAbort.aborted) return;
      const idx = index++;
      if (idx >= list.length) return;
      const ip = list[idx];
      const ports = TCP_TRIGGER_PORTS.slice(0, portSlice);
      const oneIp = Promise.allSettled(ports.map(async (port) => {
        if (localAbort.aborted) return;
        try {
          await Promise.race([
            tcpProbeOne(ip, port, timeoutMs, localAddress),
            new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs + 80)),
          ]);
        } catch { /* noop */ }
      }));
      await Promise.race([oneIp, new Promise<void>((r) => setTimeout(r, perIpHardMax))]);
      touched.add(ip);
    }
  });
  await Promise.allSettled(workers);
  return touched;
}

async function udpTriggerArp(list: string[], concurrency: number, timeoutMs: number, localAbort: AbortSignal, localAddress?: string | null): Promise<Set<string>> {
  const touched = new Set<string>();
  let index = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, list.length));
  const perIpHardMax = timeoutMs * 16 + 400;
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (localAbort.aborted) return;
      const idx = index++;
      if (idx >= list.length) return;
      const ip = list[idx];
      const oneIp = Promise.allSettled(UDP_TRIGGER_PORTS.map(async (port) => {
        if (localAbort.aborted) return;
        try {
          await Promise.race([
            udpProbeOne(ip, port, timeoutMs, localAddress),
            new Promise<void>((r) => setTimeout(r, timeoutMs + 60)),
          ]);
        } catch { /* noop */ }
      }));
      await Promise.race([oneIp, new Promise<void>((r) => setTimeout(r, perIpHardMax))]);
      touched.add(ip);
    }
  });
  await Promise.allSettled(workers);
  return touched;
}

const OUI_MAP: Record<string, string> = {
  'F45C89': 'Xiaomi / 小米通信',
  '9801A7': 'Apple Inc.',
  'D8492F': 'Apple Inc.',
  '444BED': 'HUAWEI / 华为终端',
  'E0E0FC': 'HUAWEI / 华为终端',
  '94B97E': 'TP-Link / 普联',
  '8C53C3': 'TP-Link / 普联',
  '001EC0': 'TP-LINK Router',
  '842096': 'HIKVISION / 海康威视',
  '3CEF8C': 'HIKVISION / 海康威视',
  '44D884': 'DAHUA / 浙江大华',
  'D46E0E': 'OPPO 广东移动',
  'A488F9': 'GuangDong OPPO',
  '502F9B': 'vivo 通信科技',
  '909C4A': 'SonyMobile / Lenovo',
  'E86F38': 'Intel Wireless',
  'ACDE48': 'Intel Corporate',
  '1868CB': 'Hewlett Packard / 惠普',
  '308D99': 'Dell Inc.',
  '2C4D54': 'HP Printer / 惠普打印机',
  '001132': 'Synology Inc.',
  '74C63B': 'Realtek / 瑞昱网卡',
  '54AF97': 'Realtek / 瑞昱网卡',
  'D03745': 'FiberHome / 烽火通信',
  '00E04C': 'CMCC / 中国移动',
  '7085C2': 'ZTE / 中兴',
  '206B87': 'China Mobile / 中国移动 IoT',
  '001A8A': 'B-link / 必联',
  'B0F28B': 'FiberHome / 烽火光猫',
  '00259E': 'TP-Link / 普联旧 OUI',
  '58EF68': 'TP-Link / 普联',
  '286CED': 'TP-Link / 普联',
  '54A703': 'Xiaomi / 小米 IoT',
  '102A05': 'Xiaomi / 小米路由',
  'B0416F': 'Xiaomi / 小米生态链',
  '640980': 'Mijia / 米家 IoT',
  '3C7D0A': 'Mijia / 绿米 Lumi',
  '04CF8C': 'Mijia / 绿米 Lumi',
  'D8BF40': 'Tuya / 涂鸦智能',
  '708976': 'Tuya / 涂鸦模组',
  'A09BB6': 'Sonoff / 易微联',
  '807D3A': 'ESPRESSIF / 乐鑫 ESP32/ESP8266',
  '84F703': 'ESPRESSIF / 乐鑫',
  '840D8E': 'ESPRESSIF / 乐鑫',
  '5CCF7F': 'ESPRESSIF / 乐鑫',
  '6055F9': 'ESPRESSIF / 乐鑫',
  '349454': 'Netcore / 磊科',
  '0022AA': 'D-Link',
  '000945': 'NETGEAR / 网件',
  '188090': 'MERCURY / 水星网络',
  'A85E45': 'MIKROTIK /  RouterOS',
  '28C8DB': 'ASUS / 华硕',
  '049226': 'ASUS / 华硕',
  '50465D': 'Nintendo Switch / 任天堂',
  '647A69': 'Sony Interactive',
  '001A79': 'Sony Bravia',
  '689E19': 'Google / Nest',
  '98039B': 'Amazon Kindle / Fire',
  '380B40': 'LG Innotek',
  '00D097': 'Haier / 海尔',
  '1C1B0D': 'Midea / 美的 IoT',
  '1869D8': 'Gree / 格力电器',
  '68572D': 'Hisense / 海信',
  '94B89D': 'Skyworth / 创维',
  'E0CBBC': 'TCL',
  '306B9A': 'Changhong / 长虹',
  '0019DB': 'Canon / 佳能打印机',
  '384B46': 'Epson / 爱普生',
  '000066': 'EPSON',
  '001438': 'HPE / 惠普服务器',
  '00110A': 'Cisco / 思科',
  '00155D': 'Microsoft / Hyper-V',
  '000569': 'VMware',
  '000C29': 'VMware Inc.',
  '080027': 'VirtualBox / 虚拟机',
  '525400': 'QEMU Virtual NIC',
  'FE5400': 'KVM Virtual',
  '2016D9': 'Hyper-V / Azure',
};

export interface LanScanDevice {
  ip: string;
  mac: string | null;
  vendor: string | null;
  name: string | null;
  hostname: string | null;
  pingAlive?: boolean;
  fromArp?: boolean;
}

function normalizeMac(macRaw: string): string | null {
  const hex = macRaw.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

async function lookupVendorRemote(macNorm: string): Promise<string | null> {
  const urls = [
    `https://api.macvendors.com/${encodeURIComponent(macNorm)}`,
    `https://api.maclookup.app/v2/macs/${encodeURIComponent(macNorm)}/company/name`,
  ];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1800);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json, text/plain;q=0.9,*/*;q=0.8' },
      });
      clearTimeout(t);
      if (res.ok) {
        const txt = ((await res.text()) || '').trim();
        if (txt && txt.toLowerCase() !== 'not found' && txt.toLowerCase() !== 'no result') {
          return txt.length > 80 ? txt.slice(0, 80) : txt;
        }
      }
    } catch {
      // ignore, try next
    }
  }
  return null;
}

function lookupVendorLocal(macNorm: string | null): string | null {
  if (!macNorm) return null;
  const ouiKey = macNorm.replace(/:/g, '').slice(0, 6);
  return OUI_MAP[ouiKey] ?? null;
}

function ipWithinCidr(ip: string, subnetBase3: string): boolean {
  return ip.startsWith(subnetBase3 + '.');
}

async function findDefaultGatewayBase3(): Promise<string | null> {
  try {
    const { stdout } = await exec('ipconfig', { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const m = stdout.match(/Default Gateway[^\d]*(\d{1,3}(?:\.\d{1,3}){3})/i);
    if (!m?.[1]) return null;
    return m[1].split('.').slice(0, 3).join('.');
  } catch {
    return null;
  }
}

async function findSourceIpForSubnet(base3: string): Promise<string | null> {
  try {
    const nics = os.networkInterfaces();
    let fallback: string | null = null;
    const defaultGatewayBase3 = os.platform() === 'win32'
      ? await findDefaultGatewayBase3()
      : null;
    for (const name of Object.keys(nics)) {
      const list = nics[name];
      if (!list) continue;
      for (const info of list) {
        if (info.family !== 'IPv4' || info.internal) continue;
        const parts = info.address.split('.');
        if (parts.length !== 4) continue;
        const thisNicBase3 = `${parts[0]}.${parts[1]}.${parts[2]}`;
        if (thisNicBase3 === base3) return info.address;
        if (!fallback && defaultGatewayBase3 && thisNicBase3 === defaultGatewayBase3) {
          fallback = info.address;
          continue;
        }
        if (!fallback) fallback = info.address;
      }
    }
    return fallback;
  } catch {
    return null;
  }
}

async function pingWindows(ip: string, timeoutMs = 800, sourceIp?: string | null): Promise<boolean> {
  try {
    const sourceArg = sourceIp ? `-S ${sourceIp}` : '';
    const cmd = `ping ${sourceArg} -n 1 -w ${timeoutMs} ${ip}`;
    const { stdout, stderr } = await exec(cmd, {
      windowsHide: true,
      timeout: timeoutMs * 2 + 1500,
      encoding: 'utf8',
    });
    const s = `${stdout || ''}${stderr || ''}`;
    if (/TTL=|字节=|bytes?=|<1ms|时间=\d|<1 毫秒/i.test(s)) return true;
    return false;
  } catch (err) {
    try {
      const stdout = String((err as any).stdout || '');
      const stderr = String((err as any).stderr || '');
      const s = `${stdout}${stderr}`;
      if (/TTL=|字节=|bytes?=|<1ms|时间=\d|<1 毫秒/i.test(s)) return true;
    } catch { /* noop */ }
    return false;
  }
}

async function pingUnix(ip: string, timeoutMs = 800): Promise<boolean> {
  try {
    const t = Math.max(1, Math.ceil(timeoutMs / 1000));
    await exec(`ping -c 2 -W ${t} "${ip}"`, { timeout: timeoutMs * 2 + 800 });
    return true;
  } catch {
    return false;
  }
}

const pickPing = () => (os.platform() === 'win32' ? pingWindows : pingUnix);

function parseSubnetInput(subnet: string): string[] {
  return Array.from(
    new Set(
      subnet
        .split(/[\s,;，；]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

function parseCidr(subnet: string): { base3: string; start: number; end: number } {
  const cleaned = subnet.trim();
  const cidrMatch = cleaned.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!cidrMatch) {
    throw new Error('网段格式不正确，请填写类似 192.168.41.0/24 的格式');
  }
  const [, a, b, c, d, maskStr] = cidrMatch;
  const mask = maskStr ? Number.parseInt(maskStr, 10) : 24;
  if (mask < 16 || mask > 32) {
    throw new Error('网段掩码 /' + mask + ' 超出范围，目前只支持 /16 ~ /32');
  }
  const base3 = [a, b, c].join('.');
  if (mask >= 24) {
    let start = Number(d);
    if (start <= 0) start = 1;
    if (mask === 32) {
      return { base3, start, end: start };
    }
    return { base3, start, end: 254 };
  }
  if (mask >= 16) {
    const third = Number(c);
    return { base3: [a, b, third].join('.'), start: 1, end: 254 };
  }
  return { base3, start: 1, end: 254 };
}

async function collectArpWindows(base3: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { stdout } = await exec('arp -a', { windowsHide: true, timeout: 4000 });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9A-Fa-f-]{17})\s+(\S+)\s*$/);
      if (!m) continue;
      const ip = m[1];
      if (!ipWithinCidr(ip, base3)) continue;
      const mac = normalizeMac(m[2]);
      if (mac && mac !== '00:00:00:00:00:00') map.set(ip, mac);
    }
  } catch {
    // ignore
  }
  try {
    const { stdout } = await exec('netsh interface ipv4 show neighbors', {
      windowsHide: true,
      timeout: 5000,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(
        /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9A-Fa-f-]{17}|Unreachable)\s+(\S+)\s*$/,
      );
      if (!m) continue;
      const ip = m[1];
      if (!ipWithinCidr(ip, base3)) continue;
      const mac = normalizeMac(m[2]);
      if (mac && mac !== '00:00:00:00:00:00') map.set(ip, mac);
    }
  } catch {
    // ignore
  }
  return map;
}

async function collectArpUnix(base3: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const candidates = [
    'arp -an',
    'cat /proc/net/arp 2>/dev/null || true',
    'ip neigh show 2>/dev/null || true',
  ];
  for (const cmd of candidates) {
    try {
      const { stdout } = await exec(cmd, { timeout: 4000 });
      for (const line of stdout.split(/\r?\n/)) {
        const patterns = [
          /^\s*\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{17})/i,
          /^\s*(\d+\.\d+\.\d+\.\d+)\s+(0x[0-9a-f]+\s+){0,2}([0-9a-f:]{17})\s+/i,
          /^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})\s+(REACHABLE|STALE|DELAY|PERMANENT|NOARP|NONE|INCOMPLETE|FAILED)/i,
        ];
        for (const p of patterns) {
          const m = line.match(p);
          if (!m) continue;
          const ip = m[1];
          const macRaw = m[2];
          if (!ipWithinCidr(ip, base3)) continue;
          const mac = normalizeMac(macRaw);
          if (mac && mac !== '00:00:00:00:00:00') map.set(ip, mac);
          break;
        }
      }
      if (map.size > 0) break;
    } catch {
      // ignore
    }
  }
  return map;
}

async function reverseDnsWindows(ip: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`ping -a -n 1 -w 400 "${ip}"`, { windowsHide: true, timeout: 1200 });
    const m = stdout.match(/Pinging\s+([^\s[]+)\s+\[/i);
    if (m && m[1] && m[1] !== ip) return m[1];
  } catch {
    // ignore
  }
  return null;
}

async function reverseDnsUnix(ip: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`host "${ip}" 2>/dev/null || nslookup "${ip}" 2>/dev/null || true`, {
      timeout: 1200,
    });
    const m = stdout.match(/domain name pointer\s+([^\s.][^\n]*?)\.?\s*$/im) ||
      stdout.match(/name\s*=\s*([^\s.][^\n]*?)\.?\s*$/im);
    if (m && m[1]) return m[1].trim();
  } catch {
    // ignore
  }
  return null;
}

export interface LanScanOptions {
  subnet: string;
  concurrency?: number;
  pingTimeoutMs?: number;
  withHostname?: boolean;
  withVendorRemoteApi?: boolean;
  onProgress?: (alive: number, total: number) => void;
  abortSignal?: AbortSignal;
}

async function scanSingleLanDevices(options: LanScanOptions): Promise<{
  base: string;
  totalTried: number;
  aliveCount: number;
  arpCount: number;
  devices: LanScanDevice[];
  tcpTriggered?: number;
  udpTriggered?: number;
  arpPasses?: number;
  sourceIp?: string | null;
}> {
  const {
    subnet,
    concurrency = 12,
    pingTimeoutMs = 600,
    withHostname = false,
    withVendorRemoteApi = false,
    onProgress,
    abortSignal,
  } = options;
  const { base3, start, end } = parseCidr(subnet);
  const base = `${base3}.0/24`;
  const list: string[] = [];
  for (let i = start; i <= end; i++) list.push(`${base3}.${i}`);

  const localAbort = new AbortController();
  const overallTimer = setTimeout(() => localAbort.abort(), 150_000);
  const propagate = () => localAbort.abort();
  abortSignal?.addEventListener?.('abort', propagate);

  const sourceIp = await findSourceIpForSubnet(base3);

  const pingFn = pickPing();
  const ping: (ip: string, timeoutMs: number) => Promise<boolean> =
    os.platform() === 'win32'
      ? (ip, t) => pingWindows(ip, t, sourceIp)
      : pingFn;
  let tcpTriggered = 0;
  let udpTriggered = 0;

  function collectArpNow(): Promise<Map<string, string>> {
    return os.platform() === 'win32'
      ? collectArpWindows(base3)
      : collectArpUnix(base3);
  }

  function mergeArp(target: Map<string, string>, src: Map<string, string>): Map<string, string> {
    for (const [ip, mac] of src) target.set(ip, mac);
    return target;
  }

  async function pingSweep(timeout: number, extraDelay: number, collectAlive: Set<string>): Promise<void> {
    let alive = 0;
    let index = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, list.length)) }, async () => {
      while (true) {
        if (localAbort.signal.aborted) return;
        const idx = index++;
        if (idx >= list.length) return;
        const ip = list[idx];
        let ok = false;
        try {
          ok = await Promise.race([
            ping(ip, timeout),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), timeout + extraDelay),
            ),
          ]);
        } catch {
          ok = false;
        }
        if (ok) {
          alive++;
          collectAlive.add(ip);
        }
        if (onProgress) {
          try { onProgress(alive, list.length); } catch { /* noop */ }
        }
      }
    });
    await Promise.allSettled(workers);
  }

  const mergedArp = new Map<string, string>();
  const allAlive = new Set<string>();
  let arpPasses = 0;

  try {
    if (!localAbort.signal.aborted) {
      try {
        const arp0 = await collectArpNow();
        mergeArp(mergedArp, arp0);
        arpPasses++;
      } catch { /* noop */ }
    }

    if (!localAbort.signal.aborted) {
      try {
        const tcpTouched = await Promise.race([
          tcpTriggerArp(list, Math.min(concurrency, 20), 220, localAbort.signal, 30, sourceIp),
          new Promise<Set<string>>((r) => setTimeout(() => r(new Set<string>()), 30_000)),
        ]);
        tcpTriggered = tcpTouched.size;
      } catch {
        // Ignore any TCP-stage errors and continue
      }
    }

    if (!localAbort.signal.aborted) {
      try {
        const arp1 = await collectArpNow();
        mergeArp(mergedArp, arp1);
        arpPasses++;
      } catch { /* noop */ }
    }

    if (!localAbort.signal.aborted) {
      await Promise.race([
        pingSweep(Math.max(320, Math.min(pingTimeoutMs, 500)), 180, allAlive),
        new Promise<void>((r) => setTimeout(r, 32_000)),
      ]);
      try {
        const arp2 = await collectArpNow();
        mergeArp(mergedArp, arp2);
        arpPasses++;
      } catch { /* noop */ }
    }

    if (!localAbort.signal.aborted) {
      await new Promise<void>((r) => setTimeout(r, 500));
      await Promise.race([
        pingSweep(Math.max(500, pingTimeoutMs), 260, allAlive),
        new Promise<void>((r) => setTimeout(r, 38_000)),
      ]);
      try {
        const arp3 = await collectArpNow();
        mergeArp(mergedArp, arp3);
        arpPasses++;
      } catch { /* noop */ }
    }

    if (!localAbort.signal.aborted) {
      try {
        const missed: string[] = [];
        for (const ip of list) {
          if (mergedArp.has(ip)) continue;
          if (allAlive.has(ip)) continue;
          missed.push(ip);
        }
        if (missed.length > 0) {
          const udpTouched = await Promise.race([
            udpTriggerArp(missed, Math.min(concurrency, 22), 160, localAbort.signal, sourceIp),
            new Promise<Set<string>>((r) => setTimeout(() => r(new Set<string>()), 18_000)),
          ]);
          udpTriggered = udpTouched.size;
          await new Promise<void>((r) => setTimeout(r, 600));
          try {
            const arp4 = await collectArpNow();
            mergeArp(mergedArp, arp4);
            arpPasses++;
          } catch { /* noop */ }
        }
      } catch {
        // Continue even if the UDP stage fails
      }
    }

    const allIps = new Set<string>();
    for (const ip of allAlive) allIps.add(ip);
    for (const ip of mergedArp.keys()) allIps.add(ip);

    const devices: LanScanDevice[] = [];
    const allIpList = Array.from(allIps).sort((a, b) => {
      const pa = a.split('.').map((x) => Number(x));
      const pb = b.split('.').map((x) => Number(x));
      for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });

    for (const ip of allIpList) {
      const mac = mergedArp.get(ip) ?? null;
      const vendor = lookupVendorLocal(mac);
      let hostname: string | null = null;
      if (withHostname && !localAbort.signal.aborted) {
        try {
          hostname =
            os.platform() === 'win32'
              ? await Promise.race([reverseDnsWindows(ip), Promise.resolve(null).then(() => new Promise<string | null>((r) => setTimeout(() => r(null), 900)))])
              : await Promise.race([reverseDnsUnix(ip), Promise.resolve(null).then(() => new Promise<string | null>((r) => setTimeout(() => r(null), 900)))])
            ;
        } catch {
          hostname = null;
        }
      }
      const pingAlive = allAlive.has(ip);
      const fromArp = mergedArp.has(ip);
      devices.push({
        ip,
        mac,
        vendor,
        name: hostname ?? vendor ?? null,
        hostname,
        pingAlive,
        fromArp,
      });
    }

    if (withVendorRemoteApi && !localAbort.signal.aborted) {
      let vi = 0;
      const remoteWorkers = Array.from({ length: Math.min(6, Math.max(1, devices.length)) }, async () => {
        while (true) {
          if (localAbort.signal.aborted) return;
          const idx = vi++;
          if (idx >= devices.length) return;
          const d = devices[idx];
          if (!d.mac || d.vendor) continue;
          try {
            const r = await lookupVendorRemote(d.mac);
            if (r) {
              d.vendor = r;
              if (!d.name) d.name = r;
            }
          } catch {
            // ignore
          }
        }
      });
      await Promise.allSettled(remoteWorkers);
    }

    return {
      base,
      totalTried: list.length,
      aliveCount: allAlive.size,
      arpCount: mergedArp.size,
      devices,
      tcpTriggered,
      udpTriggered,
      arpPasses,
      sourceIp,
    };
  } finally {
    clearTimeout(overallTimer);
    abortSignal?.removeEventListener?.('abort', propagate);
  }
}

export async function scanLanDevices(options: LanScanOptions): Promise<{
  base: string;
  totalTried: number;
  aliveCount: number;
  arpCount: number;
  devices: LanScanDevice[];
  tcpTriggered?: number;
  udpTriggered?: number;
  arpPasses?: number;
  sourceIp?: string | null;
}> {
  const subnets = parseSubnetInput(options.subnet);
  if (subnets.length === 0) {
    throw new Error('请填写扫描网段，例如 192.168.41.0/24');
  }
  if (subnets.length === 1) {
    return scanSingleLanDevices({ ...options, subnet: subnets[0] });
  }

  const results: Array<Awaited<ReturnType<typeof scanSingleLanDevices>>> = [];
  for (const subnet of subnets) {
    results.push(await scanSingleLanDevices({ ...options, subnet }));
  }

  const mergedByIp = new Map<string, LanScanDevice>();
  for (const result of results) {
    for (const device of result.devices) {
      const prev = mergedByIp.get(device.ip);
      if (!prev) {
        mergedByIp.set(device.ip, { ...device });
        continue;
      }
      mergedByIp.set(device.ip, {
        ip: device.ip,
        mac: prev.mac || device.mac,
        vendor: prev.vendor || device.vendor,
        name: prev.name || device.name,
        hostname: prev.hostname || device.hostname,
        pingAlive: !!(prev.pingAlive || device.pingAlive),
        fromArp: !!(prev.fromArp || device.fromArp),
      });
    }
  }

  const devices = Array.from(mergedByIp.values()).sort((a, b) => {
    const pa = a.ip.split('.').map((x) => Number(x));
    const pb = b.ip.split('.').map((x) => Number(x));
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });

  return {
    base: subnets.join(', '),
    totalTried: results.reduce((sum, item) => sum + item.totalTried, 0),
    aliveCount: devices.filter((item) => item.pingAlive).length,
    arpCount: devices.filter((item) => item.fromArp).length,
    devices,
    tcpTriggered: results.reduce((sum, item) => sum + (item.tcpTriggered || 0), 0),
    udpTriggered: results.reduce((sum, item) => sum + (item.udpTriggered || 0), 0),
    arpPasses: results.reduce((sum, item) => sum + (item.arpPasses || 0), 0),
    sourceIp: results.map((item) => item.sourceIp).filter(Boolean).join(', ') || null,
  };
}

export async function probeLanDeviceReachability(options: {
  ip: string;
  pingTimeoutMs?: number;
  tcpTimeoutMs?: number;
  tcpPorts?: number[];
}): Promise<{
  pingAlive: boolean;
  openTcpPorts: number[];
}> {
  const ip = String(options.ip ?? '').trim();
  if (!ip) {
    return {
      pingAlive: false,
      openTcpPorts: [],
    };
  }

  const pingTimeoutMs = Math.max(200, Math.min(options.pingTimeoutMs ?? 900, 5000));
  const tcpTimeoutMs = Math.max(200, Math.min(options.tcpTimeoutMs ?? 900, 5000));
  const tcpPorts = Array.from(
    new Set(
      (Array.isArray(options.tcpPorts) && options.tcpPorts.length > 0
        ? options.tcpPorts
        : [80, 554, 8000, 8554]
      ).filter((port): port is number => Number.isFinite(port) && port > 0),
    ),
  );

  const sourceIp = await findSourceIpForSubnet(ip.split('.').slice(0, 3).join('.')).catch(() => null);
  const pingFn = pickPing();
  const pingAlive = await Promise.race<boolean>([
    os.platform() === 'win32'
      ? pingWindows(ip, pingTimeoutMs, sourceIp)
      : pingFn(ip, pingTimeoutMs),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), pingTimeoutMs + 200)),
  ]).catch(() => false);

  const openResults = await Promise.allSettled(
    tcpPorts.map(async (port) => {
      const ok = await Promise.race<boolean>([
        tcpProbeOne(ip, port, tcpTimeoutMs, sourceIp),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), tcpTimeoutMs + 150)),
      ]).catch(() => false);
      return ok ? port : null;
    }),
  );

  return {
    pingAlive,
    openTcpPorts: openResults
      .map((result) => (result.status === 'fulfilled' ? result.value : null))
      .filter((port): port is number => typeof port === 'number'),
  };
}
