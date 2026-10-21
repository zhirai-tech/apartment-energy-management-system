export enum UserRole {
  ADMIN = 'admin',
  BOSS = 'boss',
  USER = 'user',
}

export enum RoomStatus {
  NORMAL = 'normal',
  WARNING_80 = 'warning_80',
  WARNING_90 = 'warning_90',
  WARNING_95 = 'warning_95',
  CUTOFF = 'cutoff',
  OFFLINE = 'offline',
}

export enum AlarmType {
  LIMIT_80 = 'limit_80',
  LIMIT_90 = 'limit_90',
  LIMIT_95 = 'limit_95',
  LIMIT_REACHED = 'limit_reached',
  DEVICE_OFFLINE = 'device_offline',
  CONTROL_FAILED = 'control_failed',
  SYNC_FAILED = 'sync_failed',
}

export enum AlarmLevel {
  INFO = 'info',
  WARNING = 'warning',
  DANGER = 'danger',
  CRITICAL = 'critical',
}

export enum OperationType {
  LOGIN = 'login',
  LOGOUT = 'logout',
  UPDATE_LIMIT = 'update_limit',
  CUTOFF_POWER = 'cutoff_power',
  RESTORE_POWER = 'restore_power',
  UPDATE_ALARM = 'update_alarm',
  UPDATE_SETTINGS = 'update_settings',
  SYNC_DEVICES = 'sync_devices',
  CONTROL_DEVICE = 'control_device',
}

export enum DeviceStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  UNKNOWN = 'unknown',
}

export enum DeviceCategory {
  CIRCUIT_BREAKER = 'circuit_breaker',
  CAMERA = 'camera',
  WIFI_AP = 'wifi_ap',
  SMART_APPLIANCE = 'smart_appliance',
  FIVE_G_CPE = 'five_g_cpe',
  OTHER = 'other',
}

export const DEVICE_CATEGORY_LABEL: Record<DeviceCategory, string> = {
  [DeviceCategory.CIRCUIT_BREAKER]: '智能空开',
  [DeviceCategory.CAMERA]: '视频监控',
  [DeviceCategory.WIFI_AP]: 'Wi-Fi 网络',
  [DeviceCategory.SMART_APPLIANCE]: '智能家电',
  [DeviceCategory.FIVE_G_CPE]: '5G 路由器',
  [DeviceCategory.OTHER]: '其他智能设备',
} as const;

export function inferDeviceCategory(input: {
  name?: string | null;
  model?: string | null;
  vendor?: string | null;
  mac?: string | null;
  ip?: string | null;
  ownership?: string | null;
  source?: string | null;
}): DeviceCategory {
  const name = String(input?.name ?? '');
  const model = String(input?.model ?? '');
  const vendor = String(input?.vendor ?? '');
  const ip = String(input?.ip ?? '').trim();
  const ownership = String(input?.ownership ?? '');
  const macRaw = String(input?.mac ?? '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
  const oui = macRaw.length >= 6 ? macRaw.slice(0, 6) : '';
  const haystack = `${name} ${model} ${vendor} ${ownership}`.toLowerCase();
  const isLikelyGatewayIp =
    /^192\.168\.\d+\.1$/.test(ip) ||
    /^10\.\d+\.\d+\.1$/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.1$/.test(ip);

  const CIRCUIT_BREAKER_OUI = new Set<string>([]);
  const CAMERA_OUI = new Set<string>([
    '4419B6',
    '44DFB6',
    'C056E3',
    '4CA1BF',
    '803F5D',
    'A41437',
    'B0C554',
    'BCA44F',
    'D05099',
    'F4EFDB',
    '507B9D',
    '6C5263',
    '9C8E14',
    'F4DF6E',
    '285730',
    '38AF29',
    '488BA8',
    '54EF44',
    '7419B6',
    '883FDA',
    'A01203',
    'AC176A',
    'C41F38',
    'C8478C',
    'CC9F7A',
    '2CAA8E',
    '34D62C',
    'E06066',
    'E0C39D',
    'F81A67',
    '706FCD',
    '74BE72',
    '84F3EB',
    '8C1747',
    '8C2460',
    '98DB37',
    'A2897B',
    'A8D16C',
    'B87B93',
    'C4460E',
    '24C6A8',
    '408D5C',
    '5C5F67',
    'AC59FF',
  ]);
  const WIFI_OUI = new Set<string>([
    '14E136',
    '10FEED',
    '349672',
    '3C3300',
    '3C4977',
    '3CE5A6',
    '3CF011',
    '40B89A',
    '448A5B',
    '482254',
    '487DA6',
    '48A98A',
    '4C8BF0',
    '502B73',
    '503EAA',
    '50642B',
    '5091E3',
    '54AF97',
    '580239',
    '581122',
    '58D349',
    '5C415A',
    '5C628B',
    '605718',
    '60A4B7',
    '60D0B6',
    '60E96E',
    '640980',
    '645F78',
    '64700F',
    '64964A',
    '64C028',
    '665D45',
    '687251',
    '68C63A',
    '6CE577',
    '70480F',
    '704F57',
    '7054B5',
    '705A0E',
    '7062B8',
    '7085C2',
    '741B15',
    '744EA8',
    '747980',
    '74A944',
    '7811DC',
    '788CB2',
    '789B48',
    '78A724',
    '78C881',
    '7C08FA',
    '7C4E57',
    '7CA612',
    '801934',
    '803AF7',
    '803F5D',
    '806564',
    '806D97',
    '807D3A',
    '8086F2',
    '809133',
    '80AA5C',
    '80B655',
    '80BE05',
    '80D5F2',
    '80EA23',
    '840B7C',
    '841D27',
    '84204C',
    '8427A4',
    '84347B',
    '8439C7',
    '845964',
    '847A3D',
    '847C9B',
    '847D36',
    '847F7A',
    '84932B',
    '849473',
    '84AB1A',
    '84AD8D',
    '84C893',
    '84CA84',
    '84D6D0',
    '84D81B',
    '84DF12',
    '84E627',
    '84EE72',
    '880F10',
    '881D25',
    '882593',
    '88385C',
    '883FDA',
    '8843A1',
    '885BD1',
    '886440',
    '8866A5',
    '88756D',
    '8877E5',
    '887B7A',
    '88904A',
    '88A115',
    '88AE60',
    '88BD45',
    '88C929',
    '88CB87',
    '88D1A3',
    '88D7F6',
    '88E0AB',
    '88E8FE',
    '88F7C7',
    '88FDB8',
    '88FDFF',
    '8C1F97',
    '8C431E',
    '8C4500',
    '8C462A',
    '8C53C3',
    '8C6813',
    '8C7967',
    '8C7A3D',
    '8C8590',
    '8C8CAA',
    '8CA6C3',
    '8CAE4C',
    '8CB39E',
    '8CBDF2',
    '8CCE16',
    '8CEB8B',
    '8CF3F3',
    '8CF890',
    '8CFABF',
    '8CFDF4',
    '8D9A8C',
    '901407',
    '902130',
    '902E1C',
    '903929',
    '904D4A',
    '905B68',
    '906A9C',
    '907B10',
    '907EEF',
    '909079',
    '909783',
    '90A9E5',
    '90AC37',
    '90B931',
    '90C73C',
    '90C9E2',
    '90D35B',
    '90D41D',
    '90D75B',
    '90DF84',
    '90E6BA',
    '90ED3C',
    '90F42E',
    '90F693',
    '90FA68',
    '90FBB3',
    '90FCB5',
    '940549',
    '940C6D',
    '94112E',
    '94247B',
    '943A09',
    '944444',
    '945051',
    '945229',
    '9455AD',
    '945624',
    '9458CB',
    '945D12',
    '94640E',
    '946825',
    '946D4F',
    '94704D',
    '94742E',
    '947B47',
    '948B44',
    '94928F',
    '949805',
    '949933',
    '949934',
    '949D0F',
    '94A328',
    '94A67E',
    '94A7A3',
    '94AA67',
    '94AB38',
    '94AE40',
    '94B27F',
    '94B562',
    '94B952',
    '94BA3E',
    '94BD5E',
    '94C01F',
    '94C150',
    '94C40C',
    '94C760',
    '94CA1E',
    '94CC7E',
    '94CF62',
    '94D244',
    '94D33A',
    '94D4B1',
    '94D69A',
    '94D91E',
    '94DC78',
    '94DF3F',
    '94E15B',
    '94E36D',
    '94E6F7',
    '94E703',
    '94E832',
    '94E919',
    '94EA0C',
    '94EC2A',
    '94EDB7',
    '94EE06',
    '94EF49',
    '94F074',
    '94F29C',
    '94F441',
    '94F6A8',
    '94F7A3',
    '94F8B5',
    '94F95D',
    '94FA46',
    '94FB60',
    '94FBD3',
    '94FC0B',
    '94FD5D',
    '94FE22',
    '94FF71',
    '983B8F',
    '98541B',
    '987B2D',
    '989486',
    '9897C1',
    '98A53C',
    '98A83C',
    '98B864',
    '98BA66',
    '98C726',
    '98C92E',
    '98CDE8',
    '98D04A',
    '98D4E3',
    '98D88A',
    '98DA34',
    '98DC0C',
    '98DF10',
    '98E075',
    '98E12C',
    '98E29A',
    '98E391',
    '98E457',
    '98E7C1',
    '98E96F',
    '98EAD9',
    '98F0F8',
    '98F129',
    '98F38A',
    '98F42D',
    '98F489',
    '98F509',
    '98F70D',
    '98F73C',
    '98F82F',
    '98F9C7',
    '98FB60',
    '98FC31',
    '98FD0E',
    '98FD58',
    '98FDA5',
    '98FF3E',
    '98FF88',
    '089BB9',
    '0C7C28',
  ]);
  const APPLIANCE_OUI = new Set<string>([
    '34EA34',
    '448A7A',
    '4A230F',
    '584498',
    '5CB3FC',
    '5CB901',
    '60A37D',
    '68DFDD',
    '70C94E',
    '74C522',
    '77145F',
    '7A3F8A',
    '7CB56B',
    '80691A',
    '84811A',
    '87AA39',
    '88352B',
    '90B765',
    '9C9A8A',
    'A0210E',
    'A05A9F',
    'A07817',
    'A0C9A0',
    'A1E769',
    'A47733',
    'A4E57C',
    'A85C2C',
    'A8655F',
    'AAC11D',
    'AC136D',
    'AC233F',
    'AC367A',
    'AC5322',
    'ACA93F',
    'B08A0D',
    'B4A98A',
    'B83861',
    'B89359',
    'BC3323',
    'BC68B5',
    'BE6407',
    'C04E30',
    'C17C2D',
    'C41528',
    'C42211',
    'C44302',
    'C44F33',
    'C46700',
    'C47789',
    'C493D2',
    'C49873',
    'C49DF9',
    'C4AE8C',
    'C4BC6F',
    'C4DA58',
    'C4E68A',
    'C80F10',
    'C81DE5',
    'C82B96',
    'C830FA',
    'C83243',
    'C83B4C',
    'C8478C',
    'C84D11',
    'C85830',
    'C85C86',
    'C85D64',
    'C869CD',
    'C86E3C',
    'C87532',
    'C8815D',
    'C88647',
    'C8901D',
    'C89138',
    'C89346',
    'C8943C',
    'C89766',
    'C8A33B',
    'C8A64E',
    'C8AC2E',
    'C8B29B',
    'C8B44E',
    'C8C4D1',
    'C8C611',
    'C8CA51',
    'C8D093',
    'C8D3A3',
    'C8D7B2',
    'C8DB61',
    'C8DF48',
    'C8E07A',
    'C8E4A4',
    'C8E8EB',
    'C8ED22',
    'C8F15E',
    'C8F319',
    'C8F758',
    'C8F95A',
    'C8FA45',
    'C8FC06',
    'C8FD29',
    'C8FF2C',
  ]);

  if (/lxzn\.[a-z]*switch/i.test(model) || /lxzn\./i.test(model)) {
    return DeviceCategory.CIRCUIT_BREAKER;
  }

  if (/h122-373|5g cpe|5g-cpe|cpe pro|h122|cpe_win|balong|巴龙|5g 路由|5g路由器|5g cpe pro/.test(haystack)) {
    return DeviceCategory.FIVE_G_CPE;
  }

  if (/beacon ?1|beacon1|ha-020w-b|ha020wb|nokia beacon|nokia wifi beacon|beacon\s*node|nokia mesh/.test(haystack)) {
    return DeviceCategory.WIFI_AP;
  }

  if (
    /c301|mbcmc23|mxiang|mi.*camera|xiaomi.*camera|xiaoyi|xiaomi.*ipc|mi.*ipc|p01|p03|p05|mjsxj|xjtx|xjlc/.test(haystack)
  ) {
    return DeviceCategory.CAMERA;
  }

  if (oui && CAMERA_OUI.has(oui)) {
    return DeviceCategory.CAMERA;
  }
  if (oui && CIRCUIT_BREAKER_OUI.has(oui)) {
    return DeviceCategory.CIRCUIT_BREAKER;
  }
  if (oui && WIFI_OUI.has(oui)) {
    if (/camera|cctv|监控|摄像头|ipc|cam|videocam|doorbell|door.*bell|hikvision|海康|dahua|大华|uniview|宇视|ezviz|萤石/.test(haystack)) {
      return DeviceCategory.CAMERA;
    }
    return DeviceCategory.WIFI_AP;
  }
  if (oui && APPLIANCE_OUI.has(oui)) {
    if (/camera|cctv|监控|摄像头|ipc|cam|videocam/.test(haystack)) {
      return DeviceCategory.CAMERA;
    }
    if (/wifi|wi-fi|wireless|router|ssid|ap|无线|路由器|网关|mesh.*wifi|wifi.*mesh|repeater|extender|放大器|增强器|扩展器|中继/.test(haystack)) {
      return DeviceCategory.WIFI_AP;
    }
    return DeviceCategory.SMART_APPLIANCE;
  }

  if (/camera|cctv|监控|摄像头|ipc|cam|videocam|doorbell|door.*bell|hikvision|海康|dahua|大华|uniview|宇视|d-link.*cam|tp-link.*cam|tapo.*cam|ezviz|萤石/.test(haystack)) {
    return DeviceCategory.CAMERA;
  }

  if (/wifi|wi-fi|wireless|router|ssid|ap|无线|路由器|网关|mesh.*wifi|wifi.*mesh|repeater|extender|放大器|增强器|扩展器|中继|tp-link|tplink|ubiquiti|unifi|mikrotik|asus.*router|netgear|linksys|huawei.*router|xiaomi.*router|redmi.*router|mi.*router|荣耀路由|h3c.*router|中兴.*router|zte.*router|mercusys|motorola.*wifi|broadcom.*wifi/.test(haystack)) {
    if (/switch|breaker|relay|通断|空开|断电/.test(haystack)) {
      return DeviceCategory.CIRCUIT_BREAKER;
    }
    return DeviceCategory.WIFI_AP;
  }

  if (/switch|breaker|relay|通断|空开|断电|lxzn\.|chint|delixi|siemens.*breaker/.test(haystack)) {
    return DeviceCategory.CIRCUIT_BREAKER;
  }

  if (/washer|dryer|fridge|refrigerator|washing|空调|air.*condition|ac-|洗衣机|冰箱|洗碗机|热水器|扫地|purifier|加湿器|烤箱|微波炉|tv|television|电视|soundbar/.test(haystack)) {
    return DeviceCategory.SMART_APPLIANCE;
  }

  if (isLikelyGatewayIp && !/camera|cctv|监控|摄像头|ipc|cam|videocam|switch|breaker|relay|通断|空开|断电/.test(haystack)) {
    return DeviceCategory.WIFI_AP;
  }

  return DeviceCategory.OTHER;
}

export const MANAGED_DEVICE_CATEGORIES: ReadonlySet<DeviceCategory> = new Set<DeviceCategory>([
  DeviceCategory.CIRCUIT_BREAKER,
  DeviceCategory.CAMERA,
  DeviceCategory.WIFI_AP,
  DeviceCategory.SMART_APPLIANCE,
  DeviceCategory.FIVE_G_CPE,
]);

export function isManagedDeviceCategory(category: DeviceCategory | null | undefined): boolean {
  if (category == null) return false;
  return MANAGED_DEVICE_CATEGORIES.has(category);
}

export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const cleaned = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (cleaned.length !== 12) return null;
  return cleaned;
}

export function getMacOui(mac: string | null | undefined): string | null {
  const n = normalizeMac(mac);
  return n ? n.slice(0, 6) : null;
}

export interface NetworkGroupingContext {
  ip?: string | null;
  mac?: string | null;
  vendor?: string | null;
  name?: string | null;
  model?: string | null;
  hostname?: string | null;
  category?: DeviceCategory | null;
  status?: 'online' | 'offline' | 'unknown';
  uptimeSeconds?: number | null;
  ssid?: string | null;
  clientCount?: number | null;
  meshNodeCount?: number | null;
  roll?: 'master' | 'satellite' | null;
}

function normalizeBrand(s: string | null | undefined): string | null {
  const t = (s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!t) return null;
  if (/nokia|beacon|ha-020w|ha020w/.test(t)) return 'NOKIA';
  if (/huawei|h122|h112|balong/.test(t)) return 'HUAWEI';
  if (/xiaomi|mi\b|redmi/.test(t)) return 'XIAOMI';
  if (/tplink|tp-link|tplinkdeco|deco/.test(t)) return 'TP-LINK';
  if (/asus|zenwifi|lyra/.test(t)) return 'ASUS';
  if (/ubiquiti|unifi|uap|udm/.test(t)) return 'UBIQUITI';
  return t.length <= 16 ? t.toUpperCase() : t.slice(0, 16).toUpperCase();
}

export function networkGroupKey(
  item: Pick<NetworkGroupingContext, 'category' | 'ip' | 'mac' | 'vendor' | 'name' | 'model' | 'hostname' | 'ssid'>
): string | null {
  const category = item.category ?? null;
  if (category !== DeviceCategory.WIFI_AP && category !== DeviceCategory.FIVE_G_CPE) return null;
  const prefix = category === DeviceCategory.FIVE_G_CPE ? 'CPE' : 'AP';
  const text = [item.vendor ?? '', item.name ?? '', item.model ?? '', item.hostname ?? ''].join(' ').toLowerCase();
  const ssid = (item.ssid ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (category === DeviceCategory.WIFI_AP && ssid && /nokia|beacon|ha-020w|mesh/.test(text)) {
    return `${prefix}|MESH|${ssid}`;
  }
  const oui = getMacOui(item.mac);
  if (oui) return `${prefix}|OUI|${oui}`;
  const brand = normalizeBrand([item.vendor ?? '', item.name ?? '', item.model ?? '', item.hostname ?? ''].join(' '));
  if (brand) return `${prefix}|BRAND|${brand}`;
  if (ssid && category === DeviceCategory.WIFI_AP) return `${prefix}|SSID|${ssid}`;
  if (item.ip) {
    const parts = item.ip.split('.');
    if (parts.length === 4) return `${prefix}|SUB|${parts[0]}.${parts[1]}.${parts[2]}`;
  }
  const mac = normalizeMac(item.mac);
  if (mac) return `${prefix}|MAC|${mac}`;
  return null;
}

export function publicNetworkPrimaryScore(item: NetworkGroupingContext): number {
  const haystack = [
    item.name ?? '',
    item.model ?? '',
    item.hostname ?? '',
    item.vendor ?? '',
  ].join(' ').toLowerCase();
  let score = 0;

  const roll = item.roll ?? null;
  if (roll === 'master') score += 2000;
  if (roll === 'satellite') score += -500;

  const meshNodes = Number(item.meshNodeCount ?? 0);
  if (Number.isFinite(meshNodes) && meshNodes > 0) {
    score += Math.min(6, meshNodes - 1) * 300;
  }
  const clients = Number(item.clientCount ?? 0);
  if (Number.isFinite(clients) && clients > 0) {
    score += Math.min(64, clients) * 15;
  }

  const category = item.category ?? null;
  if (category === DeviceCategory.WIFI_AP) {
    if (/beacon ?1\b|beacon1|ha-020w-b|ha020wb/.test(haystack)) score += 1000;
    if (/master|gateway|controller|main|主|主控|primary/.test(haystack)) score += 800;
    if (/beacon(?!\s*\d)|nokia\s*mesh|nokia\s*wifi|root.*ap/.test(haystack)) score += 400;
    if (/beacon ?[2-9]|beacon\s*node|satellite|repeater|extender|子节点|卫星|中继|扩展/.test(haystack)) score += -200;
  } else if (category === DeviceCategory.FIVE_G_CPE) {
    if (/h122-373|cpe\s*pro\s*2/.test(haystack)) score += 1000;
    if (/h122|h112|cpe\s*pro|5g\s*cpe/.test(haystack)) score += 600;
  }
  if (item.status === 'online') score += 80;
  else if (item.status === 'unknown') score += 20;
  const uptime = Number(item.uptimeSeconds ?? 0);
  if (Number.isFinite(uptime) && uptime > 0) score += Math.min(100, uptime / 3600);
  if (/192\.168\.(1|188|8|0)\.1\b/.test(item.ip ?? '')) score += 150;
  return score;
}

export function pickPrimaryPublicNetworkDevice<T extends NetworkGroupingContext>(items: T[]): T | null {
  if (!items || items.length === 0) return null;
  const scored = items.map((it) => ({ item: it, s: publicNetworkPrimaryScore(it) }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0].item;
}

export function inferPublicNetworkRole(item: NetworkGroupingContext): 'master' | 'satellite' {
  const haystack = [
    item.name ?? '',
    item.model ?? '',
    item.hostname ?? '',
    item.vendor ?? '',
  ].join(' ').toLowerCase();
  const category = item.category ?? null;
  if (category === DeviceCategory.FIVE_G_CPE) return 'master';
  if (/beacon ?1\b|beacon1|ha-020w-b|ha020wb|master|gateway|controller|main|主|主控|primary/.test(haystack)) return 'master';
  if (/beacon ?[2-9]|satellite|repeater|子节点|卫星|中继|扩展/.test(haystack)) return 'satellite';
  return 'master';
}

export function mapPublicRoleToMeshRole(
  role: 'master' | 'satellite' | null,
): MeshNodeRuntime['role'] {
  if (role === 'satellite') return 'satellite';
  return 'master';
}

export function inferShortDeviceName(
  category: DeviceCategory | string | null,
  vendor: string | null | undefined,
  model: string | null | undefined,
  name: string | null | undefined,
  ip?: string | null | undefined,
  role?: 'master' | 'satellite' | 'cpe' | 'ap' | 'camera' | null,
): { shortName: string; detailHint: string | null } {
  const normalize = (s: string | null | undefined) =>
    (s ?? '').replace(/\s+/g, ' ').trim();
  const isUnknownVendor = (s: string) =>
    /^(?:\*?\s*no company\s*\*?|unknown|n\/a|null|undefined|--?)$/i.test(s);
  const vnRaw = normalize(vendor);
  const vn = isUnknownVendor(vnRaw) ? '' : vnRaw;
  const mn = normalize(model);
  const nn = normalize(name);
  const ipText = normalize(ip);
  const haystack = [vn, mn, nn].join(' ').toLowerCase();
  const isLikelyPrimaryRouterIp =
    /^192\.168\.\d+\.1$/.test(ipText) ||
    /^10\.\d+\.\d+\.1$/.test(ipText) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.1$/.test(ipText);

  const cat = String(category ?? '').toLowerCase();
  const isCamera = cat.includes('camera') || /摄像头|摄像|监控|cam|ipc|camera/i.test(haystack);
  const isCpe = cat.includes('cpe') || /\b5g\b.*cpe|\bcpe\b|h122-373|h122|cpe pro/i.test(haystack);
  const isWifiAp =
    cat.includes('wifi_ap') ||
    cat.includes('wifi') ||
    /wifi|wi-fi|beacon|ha-020|mesh|路由|网关|access point|ap\b/i.test(haystack);

  let brand = '';
  if (/nokia|诺基亚/.test(vn)) brand = 'Nokia';
  else if (/huawei|华为/.test(vn)) brand = '华为';
  else if (/xiaomi|小米|mi\b/.test(vn)) brand = '小米';
  else if (/tp-?link|普联/.test(vn)) brand = 'TP-Link';
  else if (/asus|华硕/.test(vn)) brand = '华硕';
  else if (/tplink|huawei|nokia|xiaomi/i.test(haystack)) {
    const m = haystack.match(/(nokia|huawei|xiaomi|tplink|tp-link|tp link)/i);
    if (m) brand = m[1].replace(/tp[-\s]?link/i, 'TP-Link').replace(/^[a-z]/, (c) => c.toUpperCase());
  }
  if (!brand && vn) brand = vn.split(/[_\s,-]/)[0].slice(0, 12);

  const resolvedRole = role ?? (isCamera ? 'camera' : isCpe ? 'cpe' : isWifiAp ? (inferPublicNetworkRole({ category, name, model, vendor } as NetworkGroupingContext) === 'satellite' ? 'satellite' : 'ap') : null);

  let canonicalKind = '';
  if (resolvedRole === 'camera') canonicalKind = '摄像头';
  else if (resolvedRole === 'cpe') canonicalKind = '5G 网关';
  else if (resolvedRole === 'master') canonicalKind = 'Mesh 主控';
  else if (resolvedRole === 'satellite') canonicalKind = 'Mesh 放大器';
  else if (resolvedRole === 'ap') canonicalKind = 'WiFi 网关';

  if (isWifiAp && /beacon/i.test(haystack)) canonicalKind = canonicalKind || 'Mesh 网关';
  if (isWifiAp && /repeater|extender|扩展|中继/.test(haystack)) canonicalKind = 'WiFi 放大器';
  if (isWifiAp && isLikelyPrimaryRouterIp && !/nokia|beacon|mesh/.test(haystack)) canonicalKind = '主路由';

  const shortName = brand && canonicalKind
    ? `${brand} ${canonicalKind}`
    : (brand || canonicalKind || (isLikelyPrimaryRouterIp ? '主路由' : (nn ? nn.slice(0, 16) : (mn ? mn.slice(0, 16) : '公共设备'))));

  const cleanName =
    nn &&
    !isUnknownVendor(nn) &&
    nn.toLowerCase() !== shortName.toLowerCase() &&
    nn.toLowerCase() !== vn.toLowerCase()
      ? nn
      : null;
  const cleanModel =
    mn &&
    !isUnknownVendor(mn) &&
    mn.toLowerCase() !== shortName.toLowerCase() &&
    mn.toLowerCase() !== vn.toLowerCase() &&
    mn.toLowerCase() !== (cleanName ?? '').toLowerCase()
      ? mn
      : null;
  const rawDetail = [cleanName, cleanModel].filter(Boolean).join(' · ');
  const detailHint = rawDetail ? rawDetail.slice(0, 80) : null;

  return { shortName, detailHint };
}

export enum SiteAdapterType {
  XIAOMI_CLOUD = 'xiaomi_cloud',
  TUYA_CLOUD = 'tuya_cloud',
  LOCAL_BRIDGE = 'local_bridge',
  CUSTOM_API = 'custom_api',
}

export enum NodeType {
  MASTER = 'master',
  EDGE = 'edge',
}

export enum NodeStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  UNKNOWN = 'unknown',
  SYNCING = 'syncing',
}

export interface HourlyDataPoint {
  hour: number;
  usage: number;
  createdAt?: string;
}

export interface DailyDataPoint {
  date: string;
  usage: number;
  createdAt?: string;
}

export interface MonthlyDataPoint {
  year: number;
  month: number;
  usage: number;
  createdAt?: string;
}

export interface NetworkUsagePoint {
  label: string;
  usage: number;
  startDate?: string;
  endDate?: string;
  year?: number;
  month?: number;
}

export interface NetworkHistoryResponse {
  day: NetworkUsagePoint[];
  week: NetworkUsagePoint[];
  month: NetworkUsagePoint[];
  year: NetworkUsagePoint[];
}

export interface UserPayload {
  id: string;
  username: string;
  role: UserRole;
  name: string;
  mustChangePassword?: boolean;
}

export interface UserManagementItem {
  id: string;
  username: string;
  role: UserRole;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserCreateRequest {
  username: string;
  password: string;
  name: string;
  role: UserRole;
}

export interface UserUpdateRequest {
  name?: string;
  password?: string;
  role?: UserRole;
}

export interface ForcePasswordChangeRequest {
  username: string;
  currentPassword: string;
  newUsername: string;
  newPassword: string;
  newName?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: UserPayload;
}

export interface RoomBasicInfo {
  id: string;
  siteId: string;
  roomNumber: string;
  name: string;
  floor: number;
}

export interface RealtimeEnergyData {
  roomId: string;
  siteId: string;
  siteName: string;
  roomNumber: string;
  displayName: string;
  floor: number;
  roomAnnotation?: string | null;
  power: number;
  current: number;
  voltage: number;
  todayUsage: number;
  yesterdayUsage: number;
  monthUsage: number;
  monthCost: number;
  yearUsage: number;
  status: RoomStatus;
  usagePercent: number;
  dailyLimit: number;
  limitEnabled: boolean;
  monthlyCostLimit: number;
  costLimitEnabled: boolean;
  deviceOnline: boolean;
  cutoff: boolean;
  powerActionCooldownUntil: string | null;
  powerActionRetryAfterSeconds: number;
  powerActionLastType: 'cutoff_power' | 'restore_power' | null;
  devices: DeviceItem[];
}

export interface DeviceItem {
  id: string;
  did: string;
  siteId: string;
  siteName: string;
  name: string;
  model: string;
  category: DeviceCategory;
  status: DeviceStatus;
  roomId: string | null;
  roomNumber: string | null;
  power: boolean | null;
  powerW: number | null;
  currentA: number | null;
  voltageV: number | null;
  totalKwh: number | null;
  lastSyncAt: string | null;
  ownership?: 'xiaomi' | 'tuya' | 'huawei' | 'baidu' | 'tencent' | 'aliyun' | 'custom' | 'other' | null;
  source?: 'account_sync' | 'cloud_api' | 'custom_api' | 'lan_discovery' | 'manual' | null;
  macAddress?: string | null;
  ipAddress?: string | null;
  vendorName?: string | null;
  adapterKind?: 'huawei_cpe' | 'nokia_beacon' | null;
  camera?: CameraRuntime | null;
  wifiAp?: WifiApRuntime | null;
  appliance?: ApplianceRuntime | null;
  fiveGCpe?: FiveGCpeRuntime | null;
  runtime?: DeviceRuntimeDetail | null;
}

export interface DashboardSummary {
  siteId?: string | null;
  siteName?: string | null;
  todayTotalUsage: number;
  estimatedCost: number;
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  alarmCount: number;
  roomData: RealtimeEnergyData[];
  devices: DeviceItem[];
}

export interface RoomEnergyDetail {
  realtime: RealtimeEnergyData;
  today24h: HourlyDataPoint[];
  last7Days: DailyDataPoint[];
  last30Days: DailyDataPoint[];
  last12Months: MonthlyDataPoint[];
  devices: DeviceItem[];
}

export interface EnergyLimitUpdate {
  roomId: string;
  dailyLimit: number;
  enabled?: boolean;
  monthlyCostLimit?: number;
  costEnabled?: boolean;
}

export interface RankingItem {
  roomId: string;
  roomNumber: string;
  displayName: string;
  roomAnnotation?: string | null;
  usage: number;
  rank: number;
}

export interface AlarmLogResponse {
  id: string;
  type: AlarmType;
  level: AlarmLevel;
  roomId: string | null;
  roomNumber: string | null;
  displayName?: string | null;
  message: string;
  createdAt: string;
  resolved: boolean;
}

export interface OperationLogResponse {
  id: string;
  type: OperationType;
  category?: 'auth' | 'room_power' | 'network' | 'camera' | 'room' | 'alarm' | 'device_sync' | 'system' | 'other' | null;
  categoryLabel?: string | null;
  userId: string | null;
  username: string | null;
  actorLabel?: string | null;
  sourceLabel?: string | null;
  roomId: string | null;
  roomNumber: string | null;
  displayName?: string | null;
  details: string;
  detailsText?: string;
  success: boolean;
  resultLabel?: string;
  resultTone?: 'success' | 'failure' | 'warning';
  createdAt: string;
}

export interface SystemSettingsData {
  alarmRatio80: number;
  alarmRatio90: number;
  alarmRatio95: number;
  autoCutoff: boolean;
  autoRestorePower: boolean;
  businessTimezone: string;
  refreshInterval: number;
  dailyResetHour: number;
  pricePerKwh: number;
  priceAutoRegion: string;
  priceAutoEnabled: boolean;
  priceAutoSource: string;
  priceAutoLastUpdatedAt: string;
  defaultDailyLimitKwh: number;
  defaultMonthlyCostLimitEur: number;
  defaultDailyLimitUseWeeklyRules: boolean;
  defaultDailyLimitWeekdayKwh: number;
  defaultDailyLimitSaturdayKwh: number;
  defaultDailyLimitSundayKwh: number;
  defaultDailyLimitUseHolidayRules: boolean;
  defaultDailyLimitHolidayKwh: number;
  defaultDailyLimitHolidayDates: string;
}

export interface XiaomiDeviceInfo {
  did: string;
  name: string;
  model: string;
  siteId?: string | null;
  online: boolean;
  roomId: string | null;
  power?: boolean;
  powerW?: number;
  currentA?: number;
  voltageV?: number;
  totalKwh?: number;
  localIp?: string | null;
  sourceRegion?: string;
  sourceScope?: 'main' | 'camera';
}

export interface WifiStationClient {
  mac: string;
  hostname?: string | null;
  ip?: string | null;
  vendor?: string | null;
  band?: '2.4G' | '5G' | '6G' | string | null;
  interfaceType?: string | null;
  active?: boolean | null;
  connectedAt?: string | null;
  rxBytes?: number | null;
  txBytes?: number | null;
}

export interface WifiBandRuntime {
  band: '2.4G' | '5G' | '6G' | string;
  enabled: boolean;
  ssid?: string | null;
  channel?: number | null;
  bandwidthMHz?: number | null;
  security?: 'WPA2' | 'WPA3' | 'WPA2/WPA3' | 'WPA' | 'WEP' | 'OPEN' | string | null;
  txRateMbps?: number | null;
  rxRateMbps?: number | null;
  txPowerDbm?: number | null;
  clientCount?: number | null;
  clients?: WifiStationClient[];
}

export interface MeshNodeRuntime {
  nodeId: string;
  nodeName?: string | null;
  role: 'master' | 'slave' | 'repeater' | 'satellite';
  online: boolean;
  ip?: string | null;
  mac?: string | null;
  model?: string | null;
  vendor?: string | null;
  parentNodeId?: string | null;
  backhaulType?: 'ethernet' | 'wifi_5G' | 'wifi_2.4G' | 'plc' | string | null;
  backhaulRateMbps?: number | null;
  backhaulRssiDbm?: number | null;
  uptimeSeconds?: number | null;
  lastSeenAt?: string | null;
  firmware?: string | null;
  bands?: WifiBandRuntime[];
  totalClientCount?: number | null;
  roomHint?: string | null;
}

export interface WifiApRuntime {
  ssid: string;
  band?: '2.4G' | '5G' | '2.4G+5G' | string | null;
  channel?: number | null;
  txRateMbps?: number | null;
  rxRateMbps?: number | null;
  uploadMbps?: number | null;
  downloadMbps?: number | null;
  signalDbm?: number | null;
  clients: WifiStationClient[];
  clientCount: number;
  uptimeSeconds?: number | null;
  lastSeenAt?: string | null;
  bands?: WifiBandRuntime[] | null;
  wanIp?: string | null;
  dns?: string[] | null;
  meshTopology?: MeshNodeRuntime[] | null;
  meshBackhaulState?: 'up' | 'down' | 'degraded' | string | null;
  totalRxBytes?: number | null;
  totalTxBytes?: number | null;
}

export interface CameraRuntime {
  online: boolean;
  snapshotUrl?: string | null;
  streamUrl?: string | null;
  hdStreamUrl?: string | null;
  brand?: string | null;
  model?: string | null;
  hasAudio?: boolean;
  hasNightVision?: boolean;
  lastMotionAt?: string | null;
}

export interface ApplianceRuntime {
  online: boolean;
  powerState?: 'on' | 'off' | 'standby' | 'running' | string | null;
  mode?: string | null;
  remainingMinutes?: number | null;
  temperatureCelsius?: number | null;
  targetTemperatureCelsius?: number | null;
  lastSyncAt?: string | null;
  extras?: Record<string, unknown> | null;
}

export interface FiveGServingCell {
  rat?: '4G' | '5G' | 'LTE' | 'NR' | string | null;
  mcc?: string | null;
  mnc?: string | null;
  tac?: string | null;
  cellId?: string | null;
  physicalCellId?: number | null;
  earfcn?: number | null;
  nrarfcn?: number | null;
  band?: string | null;
  bandwidthMHz?: number | null;
  rsrpDbm?: number | null;
  rsrqDb?: number | null;
  sinrDb?: number | null;
  rssiDbm?: number | null;
  rank?: number | null;
  mimoLayers?: number | null;
}

export interface FiveGCpeRuntime {
  online: boolean;
  routerName?: string | null;
  model?: string | null;
  firmwareVersion?: string | null;
  imei?: string | null;
  imsi?: string | null;
  iccid?: string | null;
  simReady?: boolean | null;
  simSlot?: number | null;
  pinLocked?: boolean | null;
  networkMode?: 'auto' | '5G_only' | '4G_only' | '5G_preferred' | '4G_preferred' | string | null;
  currentRat?: '4G' | '5G' | 'LTE' | 'NR' | 'NSA' | 'SA' | string | null;
  operatorFullname?: string | null;
  operatorShort?: string | null;
  country?: string | null;
  roaming?: boolean | null;
  apn?: string | null;
  ipType?: 'IPV4' | 'IPV6' | 'IPV4V6' | string | null;
  publicIpv4?: string | null;
  publicIpv6?: string | null;
  servingCells?: FiveGServingCell[] | null;
  rsrpDbm?: number | null;
  rsrqDb?: number | null;
  sinrDb?: number | null;
  rssiDbm?: number | null;
  signalBars?: 0 | 1 | 2 | 3 | 4 | 5 | number | null;
  downloadMbps?: number | null;
  uploadMbps?: number | null;
  peakDownloadMbps?: number | null;
  peakUploadMbps?: number | null;
  sessionTimeSeconds?: number | null;
  totalRxBytes?: number | null;
  totalTxBytes?: number | null;
  monthRxBytes?: number | null;
  monthTxBytes?: number | null;
  dayRxBytes?: number | null;
  dayTxBytes?: number | null;
  connectedDevices?: number | null;
  bands?: WifiBandRuntime[] | null;
  clients?: WifiStationClient[] | null;
  lastSyncAt?: string | null;
  extras?: Record<string, unknown> | null;
}

export interface DeviceRuntimeDetail {
  category: DeviceCategory;
  circuitBreaker?: {
    power: boolean | null;
    powerW: number | null;
    currentA: number | null;
    voltageV: number | null;
    totalKwh: number | null;
  } | null;
  wifiAp?: WifiApRuntime | null;
  camera?: CameraRuntime | null;
  appliance?: ApplianceRuntime | null;
  fiveGCpe?: FiveGCpeRuntime | null;
  other?: Record<string, unknown> | null;
}

export interface EdgeNodeSummary {
  id: string;
  siteId: string;
  code: string;
  name: string;
  nodeType: NodeType;
  status: NodeStatus;
  localApiBaseUrl: string | null;
  storageRetentionDays: number;
  isLocalControlEnabled: boolean;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
}

export interface SiteSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  adapterType: SiteAdapterType;
  isPrimary: boolean;
  storageRetentionDays: number;
  roomCount: number;
  deviceCount: number;
  onlineDeviceCount: number;
  cutoffRoomCount: number;
  unresolvedAlarmCount: number;
  nodes: EdgeNodeSummary[];
}

export interface SiteCreateRequest {
  name: string;
  description?: string;
}

export interface SiteUpdateRequest {
  name?: string;
  description?: string | null;
}

export const ROOM_COUNT = 14;
export const ROOM_NUMBERS = [
  '101', '102', '103', '104', '105', '106', '107',
  '108', '109', '110', '111', '112', '113', '114',
];

export const ROOM_STATUS_COLORS: Record<RoomStatus, string> = {
  [RoomStatus.NORMAL]: '#22c55e',
  [RoomStatus.WARNING_80]: '#eab308',
  [RoomStatus.WARNING_90]: '#f97316',
  [RoomStatus.WARNING_95]: '#ef4444',
  [RoomStatus.CUTOFF]: '#991b1b',
  [RoomStatus.OFFLINE]: '#6b7280',
};

export const ROOM_STATUS_TEXT: Record<RoomStatus, string> = {
  [RoomStatus.NORMAL]: '正常',
  [RoomStatus.WARNING_80]: '80%预警',
  [RoomStatus.WARNING_90]: '90%预警',
  [RoomStatus.WARNING_95]: '95%预警',
  [RoomStatus.CUTOFF]: '已断电',
  [RoomStatus.OFFLINE]: '离线',
};
