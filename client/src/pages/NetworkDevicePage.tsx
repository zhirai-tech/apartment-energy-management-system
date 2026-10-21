import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  RadioTower,
  RefreshCw,
  Server,
  SignalHigh,
  Upload,
  Users,
  Wifi,
} from 'lucide-react';
import * as api from '@/lib/api';
import { useSiteStore } from '@/store/site';
import {
  DEVICE_CATEGORY_LABEL,
  inferShortDeviceName,
  publicNetworkPrimaryScore,
  type DeviceItem,
} from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatBytes as formatBytesShared, hasMeaningfulValue as hasMeaningfulValueShared, normalizeMac } from '@/lib/format';

function normalizeMacKey(value?: string | null): string {
  return normalizeMac(value);
}

function formatBytes(bytes: number | null | undefined): string {
  return formatBytesShared(bytes);
}

function hasMeaningfulValue(value: unknown): boolean {
  return hasMeaningfulValueShared(value);
}

function formatMbps(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value) && Number(value) > 0 ? `${Number(value).toFixed(1)} Mbps` : null;
}

function inferClientEndpointType(input: {
  name?: string | null;
  hostname?: string | null;
  vendor?: string | null;
  systemCategory?: string | null;
  interfaceType?: string | null;
}): string {
  const category = String(input.systemCategory ?? '').trim();
  if (category === 'camera') return '摄像头';
  if (category === 'smart_appliance') return '智能设备';
  if (category === 'circuit_breaker') return '智能空开';
  if (category === 'wifi_ap') return '网关';
  if (category === 'five_g_cpe') return '主路由';

  const text = [
    input.name ?? '',
    input.hostname ?? '',
    input.vendor ?? '',
    input.interfaceType ?? '',
  ].join(' ').toLowerCase();
  if (/(iphone|android|poco|redmi|xiaomi|mi phone|huawei|honor|oppo|vivo|oneplus|realme|galaxy|samsung)/.test(text)) return '手机';
  if (/(ipad|tablet|tab\b|mi pad|matepad|xiaoxin pad)/.test(text)) return '平板';
  if (/(macbook|notebook|laptop|desktop|thinkpad|surface|windows|pc\b|lenovo|dell|hp\b|asus|acer|msi)/.test(text)) return '电脑';
  if (/(amazon|echo|alexa|homepod|google home|nest)/.test(text)) return '音箱';
  if (/(tv|bravia|hisense|tcl|xiaomi tv|appletv|apple tv|webos)/.test(text)) return '电视';
  if (/(printer|epson|canon|brother|hp laser|打印机)/.test(text)) return '打印机';
  if (/(switch|breaker|relay|lxzn|miot|tuya|iot|sensor|plug|air purifier|vacuum)/.test(text)) return 'IoT 设备';
  if (/(beacon|router|mesh|h122|gateway|网关|路由)/.test(text)) return '网络设备';
  return '未知终端';
}

function isGenericClientName(value?: string | null): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return !text || /^unknown[_-]/.test(text) || /^lan device\b/.test(text) || /^\*no company\*/.test(text);
}

function enrichNetworkClients(clients: any[], allDevices: DeviceItem[]): any[] {
  if (!Array.isArray(clients) || clients.length === 0) return [];

  const devicesByMac = new Map<string, DeviceItem>();
  const devicesByIp = new Map<string, DeviceItem>();
  for (const device of allDevices) {
    const anyDev = device as any;
    const macKey = normalizeMacKey(anyDev.mac ?? anyDev.macAddress ?? null);
    const ipKey = String(anyDev.ipAddress ?? anyDev.ip ?? '').trim();
    if (macKey && !devicesByMac.has(macKey)) devicesByMac.set(macKey, device);
    if (ipKey && !devicesByIp.has(ipKey)) devicesByIp.set(ipKey, device);
  }

  return clients.map((client) => {
    const macKey = normalizeMacKey(client?.mac ?? client?.macAddress ?? null);
    const ipKey = String(client?.ip ?? client?.ipAddress ?? '').trim();
    const matched = (macKey && devicesByMac.get(macKey)) || (ipKey && devicesByIp.get(ipKey)) || null;
    const matchedAny = matched as any;
    const matchedCategory = matchedAny?.category ? String(matchedAny.category) : null;
    const matchedVendor = matchedAny?.vendorName ?? matchedAny?.vendor ?? null;
    const matchedModel = matchedAny?.fiveGCpe?.model ?? matchedAny?.wifiAp?.model ?? matchedAny?.model ?? null;
    const matchedRole =
      matchedAny?.adapterKind === 'huawei_cpe'
        ? 'cpe'
        : matchedCategory === 'wifi_ap'
          ? 'master'
          : undefined;
    const matchedTitle = matched
      ? inferShortDeviceName(
          matchedCategory as any,
          matchedVendor,
          matchedModel,
          matchedAny?.name ?? null,
          matchedAny?.ipAddress ?? matchedAny?.ip ?? null,
          matchedRole,
        ).shortName
      : null;
    const vendorResolved = client?.vendor ?? matchedVendor ?? null;
    const rawName = [client?.name, client?.hostname, client?.deviceName].find((item) => !isGenericClientName(item)) ?? null;
    const endpointType = inferClientEndpointType({
      name: matchedTitle ?? rawName,
      hostname: client?.hostname ?? client?.deviceName ?? null,
      vendor: vendorResolved,
      systemCategory: matchedCategory,
      interfaceType: client?.interfaceType ?? client?.interface ?? client?.iface ?? null,
    });
    let baseName = matchedTitle ?? rawName ?? vendorResolved ?? endpointType;
    if (/amazon/i.test(String(rawName ?? vendorResolved ?? ''))) baseName = 'Amazon 设备';
    if (!baseName || isGenericClientName(baseName)) baseName = endpointType;

    return {
      ...client,
      displayName: baseName,
      vendorResolved,
      systemDid: matchedAny?.did ?? null,
      systemCategory: matchedCategory,
      systemCategoryLabel: matchedCategory ? (DEVICE_CATEGORY_LABEL as Record<string, string>)[matchedCategory] ?? matchedCategory : null,
      systemTitle: matchedTitle,
      managed: Boolean(matched),
      endpointType,
    };
  });
}

function buildDisplayNetworkDevice(device: DeviceItem, allDevices: DeviceItem[]): DeviceItem {
  const primaryAny = device as any;
  const primaryIp = String(primaryAny.ipAddress ?? primaryAny.ip ?? '').trim();
  const primarySubnet = primaryIp.split('.').slice(0, 3).join('.');
  const existingCpeClients: any[] = Array.isArray(primaryAny.fiveGCpe?.clients) ? primaryAny.fiveGCpe.clients : [];
  const connectedDevices = Number(primaryAny.fiveGCpe?.connectedDevices ?? NaN);
  const inferredCpeClients =
    primaryAny.adapterKind === 'huawei_cpe' &&
    existingCpeClients.length === 0 &&
    Number.isFinite(connectedDevices) &&
    connectedDevices > 0
      ? allDevices
          .filter((candidate) => candidate.did !== device.did)
          .filter((candidate) => {
            const candidateAny = candidate as any;
            const candidateIp = String(candidateAny.ipAddress ?? candidateAny.ip ?? '').trim();
            return !!candidateIp && !!primarySubnet && candidateIp.startsWith(`${primarySubnet}.`);
          })
          .sort((a, b) => {
            const as = a as any;
            const bs = b as any;
            return publicNetworkPrimaryScore({
              category: String(bs.category ?? 'other') as any,
              ip: bs.ipAddress ?? null,
              mac: bs.mac ?? null,
              vendor: bs.vendorName ?? bs.vendor ?? null,
              name: bs.name ?? null,
              model: bs.model ?? null,
              hostname: bs.hostname ?? null,
              ssid: bs.wifiAp?.ssid ?? null,
              clientCount: Number(bs.wifiAp?.clientCount ?? bs.fiveGCpe?.connectedDevices ?? 0),
              meshNodeCount: Array.isArray(bs.wifiAp?.meshTopology) ? bs.wifiAp.meshTopology.length : 0,
              status: bs.status ?? 'unknown',
              uptimeSeconds: Number(bs.uptimeSeconds ?? 0) || null,
            }) - publicNetworkPrimaryScore({
              category: String(as.category ?? 'other') as any,
              ip: as.ipAddress ?? null,
              mac: as.mac ?? null,
              vendor: as.vendorName ?? as.vendor ?? null,
              name: as.name ?? null,
              model: as.model ?? null,
              hostname: as.hostname ?? null,
              ssid: as.wifiAp?.ssid ?? null,
              clientCount: Number(as.wifiAp?.clientCount ?? as.fiveGCpe?.connectedDevices ?? 0),
              meshNodeCount: Array.isArray(as.wifiAp?.meshTopology) ? as.wifiAp.meshTopology.length : 0,
              status: as.status ?? 'unknown',
              uptimeSeconds: Number(as.uptimeSeconds ?? 0) || null,
            });
          })
          .slice(0, connectedDevices)
          .map((candidate) => {
            const candidateAny = candidate as any;
            const inferred = inferShortDeviceName(
              String(candidateAny.category ?? 'other') as any,
              candidateAny.vendorName ?? candidateAny.vendor ?? null,
              candidateAny.wifiAp?.model ?? candidateAny.fiveGCpe?.model ?? candidateAny.model ?? null,
              candidateAny.name ?? null,
              candidateAny.ipAddress ?? candidateAny.ip ?? null,
              candidateAny.adapterKind === 'nokia_beacon' ? 'master' : undefined,
            );
            return {
              name: inferred.shortName,
              hostname: candidateAny.name ?? null,
              ip: candidateAny.ipAddress ?? candidateAny.ip ?? null,
              mac: candidateAny.mac ?? null,
              interface: 'ethernet',
              band: '有线',
              inferred: true,
              sourceDid: candidateAny.did,
            };
          })
      : [];

  return {
    ...(device as DeviceItem),
    fiveGCpe: primaryAny.fiveGCpe
      ? {
          ...primaryAny.fiveGCpe,
          clients: enrichNetworkClients(
            inferredCpeClients.length > 0 ? inferredCpeClients : (Array.isArray(primaryAny.fiveGCpe?.clients) ? primaryAny.fiveGCpe.clients : []),
            allDevices,
          ),
        }
      : primaryAny.fiveGCpe,
    wifiAp: primaryAny.wifiAp
      ? {
          ...primaryAny.wifiAp,
          clients: enrichNetworkClients(
            Array.isArray(primaryAny.wifiAp?.clients) ? primaryAny.wifiAp.clients : [],
            allDevices,
          ),
        }
      : primaryAny.wifiAp,
  };
}

function formatClientTraffic(client: any): string | null {
  const totalRx = client?.rxBytes ?? client?.rx ?? null;
  const totalTx = client?.txBytes ?? client?.tx ?? null;
  const downRate = client?.rxRateMbps ?? null;
  const upRate = client?.txRateMbps ?? null;
  const totalText =
    totalRx != null || totalTx != null
      ? `↓${formatBytes(totalRx)} / ↑${formatBytes(totalTx)}`
      : null;
  const rateText =
    downRate != null || upRate != null
      ? `${downRate ?? '--'} / ${upRate ?? '--'} Mbps`
      : null;
  return [totalText, rateText].filter(Boolean).join(' · ') || null;
}

export function NetworkDevicePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { did } = useParams();
  const [searchParams] = useSearchParams();
  const selectedSiteId = useSiteStore((state) => state.selectedSiteId);
  const [refreshing, setRefreshing] = useState(false);
  const panel = searchParams.get('panel') === 'nodes' ? 'nodes' : 'clients';

  const { data: summary, isLoading, refetch } = useQuery({
    queryKey: ['dashboard', selectedSiteId ?? 'all'],
    queryFn: () => api.dashboard.get(selectedSiteId ?? undefined),
    enabled: !!did,
    refetchOnWindowFocus: false,
  });

  const { data: adapterConfig } = useQuery({
    queryKey: ['device-adapter-config', did],
    queryFn: () => api.system.getDeviceAdapterConfig(did!),
    enabled: !!did,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const allDevices = useMemo(() => (summary?.devices ?? []) as DeviceItem[], [summary]);
  const device = useMemo(() => {
    if (!did) return null;
    const found = allDevices.find((item) => item.did === did);
    return found ? buildDisplayNetworkDevice(found, allDevices) : null;
  }, [allDevices, did]);

  const firstAny = device as any;
  const isCpe = Boolean(firstAny?.fiveGCpe) || firstAny?.adapterKind === 'huawei_cpe';
  const title = inferShortDeviceName(
    String(firstAny?.category ?? 'other') as any,
    firstAny?.vendorName ?? null,
    firstAny?.fiveGCpe?.model ?? firstAny?.wifiAp?.model ?? firstAny?.model ?? null,
    firstAny?.name ?? null,
    firstAny?.ipAddress ?? firstAny?.ip ?? null,
    isCpe ? 'cpe' : firstAny?.adapterKind === 'nokia_beacon' ? 'master' : undefined,
  ).shortName || String(firstAny?.name ?? '网络设备').trim() || '网络设备';
  const networkAdminUrl = useMemo(() => {
    const fromConfig = String(adapterConfig?.baseUrl ?? '').trim();
    if (fromConfig) return fromConfig;
    const ip = String(firstAny?.ipAddress ?? firstAny?.ip ?? '').trim();
    return ip ? (/^https?:\/\//i.test(ip) ? ip : `http://${ip}`) : '';
  }, [adapterConfig?.baseUrl, firstAny]);

  const cpeClients: any[] = Array.isArray(firstAny?.fiveGCpe?.clients) ? firstAny.fiveGCpe.clients : [];
  const wifiClients: any[] = Array.isArray(firstAny?.wifiAp?.clients) ? firstAny.wifiAp.clients : [];
  const allClients = useMemo(() => [...cpeClients, ...wifiClients], [cpeClients, wifiClients]);
  const meshNodes = useMemo(() => (Array.isArray(firstAny?.wifiAp?.meshTopology) ? firstAny.wifiAp.meshTopology : []) as any[], [firstAny]);
  const displayNameCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const client of allClients) {
      const base = String(client.displayName ?? client.systemTitle ?? client.name ?? client.hostname ?? client.deviceName ?? '未命名设备').trim();
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    return counts;
  }, [allClients]);

  const sectionOrder = panel === 'nodes'
    ? ['nodes', 'clients', 'runtime'] as const
    : ['clients', 'nodes', 'runtime'] as const;

  const handleRefreshRuntime = async () => {
    if (!did) return;
    try {
      setRefreshing(true);
      const result = await api.system.refreshDeviceRuntime(did);
      if (!result.ok) {
        toast.error(result.errorMessage || '刷新运行时失败');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      await refetch();
      toast.success('运行时已刷新');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '刷新运行时失败');
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => navigate('/')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回仪表盘
          </Button>
        </div>
        <Card><CardContent className="p-6"><div className="h-32 animate-pulse rounded bg-muted" /></CardContent></Card>
      </div>
    );
  }

  if (!device) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate('/')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回仪表盘
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>未找到网络设备</CardTitle>
            <CardDescription>这个页面只从仪表盘卡片进入。当前设备可能已被移除或站点已切换。</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const runtimeRows = isCpe
    ? [
        ['状态', firstAny?.fiveGCpe?.online ? '在线' : firstAny?.status === 'online' ? '在线' : '离线'],
        ['运营商', firstAny?.fiveGCpe?.operatorFullname ?? firstAny?.fiveGCpe?.operatorShort ?? null],
        ['网络类型', firstAny?.fiveGCpe?.currentRat ?? null],
        ['信号', firstAny?.fiveGCpe?.signalBars != null ? `${firstAny.fiveGCpe.signalBars} 格` : null],
        ['实时上行', formatMbps(firstAny?.fiveGCpe?.uploadMbps)],
        ['实时下行', formatMbps(firstAny?.fiveGCpe?.downloadMbps)],
        ['最高上行', formatMbps(firstAny?.fiveGCpe?.peakUploadMbps ?? firstAny?.fiveGCpe?.uploadMbps)],
        ['最高下行', formatMbps(firstAny?.fiveGCpe?.peakDownloadMbps ?? firstAny?.fiveGCpe?.downloadMbps)],
        ['本月使用流量', hasMeaningfulValue(Number(firstAny?.fiveGCpe?.monthRxBytes ?? 0) + Number(firstAny?.fiveGCpe?.monthTxBytes ?? 0))
          ? `↓${formatBytes(firstAny?.fiveGCpe?.monthRxBytes)} / ↑${formatBytes(firstAny?.fiveGCpe?.monthTxBytes)}`
          : null],
        ['管理地址', networkAdminUrl || null],
      ]
    : [
        ['状态', firstAny?.status === 'online' ? '在线' : '离线'],
        ['双频', (() => {
          const bands = (Array.isArray(firstAny?.wifiAp?.bands) ? firstAny.wifiAp.bands : []) as any[];
          const has24 = bands.some((item) => /^2\.?4/i.test(String(item?.band ?? '')) && item?.enabled !== false);
          const has5 = bands.some((item) => /^5/i.test(String(item?.band ?? '')) && item?.enabled !== false);
          if (has24 && has5) return '2.4G / 5G';
          if (has24) return '2.4G';
          if (has5) return '5G';
          return firstAny?.wifiAp?.band ?? null;
        })()],
        ['SSID', firstAny?.wifiAp?.ssid ?? null],
        ['挂载设备', Number(firstAny?.wifiAp?.clientCount ?? allClients.length) > 0 ? `${Number(firstAny?.wifiAp?.clientCount ?? allClients.length)} 台` : null],
        ['Mesh 节点', meshNodes.length > 0 ? `${meshNodes.length} 个` : null],
        ['回程状态', String(firstAny?.wifiAp?.meshBackhaulState ?? '').toLowerCase() === 'up' ? '正常' : null],
        ['管理地址', networkAdminUrl || null],
      ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Button variant="ghost" className="-ml-3 mb-1" onClick={() => navigate('/')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回仪表盘
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <Badge variant={firstAny?.status === 'online' ? 'success' : 'destructive'}>
              {firstAny?.status === 'online' ? '设备在线' : '设备离线'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            这里只从仪表盘卡片进入，不在侧边栏单独展示。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleRefreshRuntime} disabled={refreshing}>
            <RefreshCw className={cn('mr-2 h-4 w-4', refreshing && 'animate-spin')} />
            刷新运行时
          </Button>
          <Button variant="default" onClick={() => {
            if (!networkAdminUrl) {
              toast.warning('还没有可打开的管理地址');
              return;
            }
            window.open(networkAdminUrl, '_blank', 'noopener,noreferrer');
          }}>
            <ExternalLink className="mr-2 h-4 w-4" />
            打开后台
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isCpe ? <SignalHigh className="h-5 w-5 text-amber-600" /> : <Wifi className="h-5 w-5 text-sky-600" />}
            设备摘要
          </CardTitle>
          <CardDescription>卡片里只留摘要；明细放在这个完整页面里看。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isCpe ? (
            <div className="rounded-lg border border-amber-200/60 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {[
                  ['信号', firstAny?.fiveGCpe?.signalBars != null ? `${firstAny.fiveGCpe.signalBars} 格` : null],
                  ['运营商', firstAny?.fiveGCpe?.operatorFullname ?? firstAny?.fiveGCpe?.operatorShort ?? null],
                  ['网络类型', firstAny?.fiveGCpe?.currentRat ?? null],
                ].filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                  <div key={String(label)} className="rounded-md bg-white/70 px-3 py-2 dark:bg-slate-900/25">
                    <div className="text-xs text-amber-700/80 dark:text-amber-300/80">{label}</div>
                    <div className="mt-1 text-base font-semibold text-amber-900 dark:text-amber-100">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              !isCpe ? ['双频', (() => {
                const bands = (Array.isArray(firstAny?.wifiAp?.bands) ? firstAny.wifiAp.bands : []) as any[];
                const parts: string[] = [];
                if (bands.some((item) => /^2\.?4/i.test(String(item?.band ?? '')) && item?.enabled !== false)) parts.push('2.4G');
                if (bands.some((item) => /^5/i.test(String(item?.band ?? '')) && item?.enabled !== false)) parts.push('5G');
                return parts.join(' / ') || firstAny?.wifiAp?.band || null;
              })(), Wifi] : null,
              ['挂载设备', allClients.length > 0 ? `${allClients.length} 台` : (Number(firstAny?.fiveGCpe?.connectedDevices ?? firstAny?.wifiAp?.clientCount ?? 0) > 0 ? `${Number(firstAny?.fiveGCpe?.connectedDevices ?? firstAny?.wifiAp?.clientCount)} 台` : null), Users],
              isCpe ? ['下行', formatMbps(firstAny?.fiveGCpe?.downloadMbps), Download] : ['Mesh 节点', meshNodes.length > 0 ? `${meshNodes.length} 个` : null, Server],
              isCpe ? ['上行', formatMbps(firstAny?.fiveGCpe?.uploadMbps), Upload] : ['SSID', firstAny?.wifiAp?.ssid ?? null, RadioTower],
              isCpe ? ['本月流量', hasMeaningfulValue(Number(firstAny?.fiveGCpe?.monthRxBytes ?? 0) + Number(firstAny?.fiveGCpe?.monthTxBytes ?? 0))
                ? `↓${formatBytes(firstAny?.fiveGCpe?.monthRxBytes)} / ↑${formatBytes(firstAny?.fiveGCpe?.monthTxBytes)}`
                : null, RadioTower] : ['回程状态', String(firstAny?.wifiAp?.meshBackhaulState ?? '').toLowerCase() === 'up' ? '正常' : null, SignalHigh],
            ].filter(Boolean).map((item) => {
              const [label, value, Icon] = item as [string, string | null, any];
              if (!hasMeaningfulValue(value)) return null;
              return (
                <div key={label} className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="h-4 w-4" />
                    {label}
                  </div>
                  <div className="mt-2 text-lg font-semibold break-all">{value}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {sectionOrder.map((section) => {
        if (section === 'clients') {
          return (
            <Card key="clients">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-sky-600" />
                  挂载设备
                  <Badge variant="outline">{allClients.length || Number(firstAny?.fiveGCpe?.connectedDevices ?? firstAny?.wifiAp?.clientCount ?? 0)} 台</Badge>
                </CardTitle>
                <CardDescription>这里显示客户端明细，不再挤在仪表盘卡片里。</CardDescription>
              </CardHeader>
              <CardContent>
                {allClients.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                    当前设备没有返回客户端明细。若主路由只返回数量，这里会优先展示可推断出的系统内设备。
                  </div>
                ) : (
                  <div className="overflow-auto rounded-lg border">
                    <table className="w-full min-w-[980px] text-sm">
                      <thead className="bg-slate-100 text-slate-700 dark:bg-slate-800/50 dark:text-slate-200">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">#</th>
                          <th className="px-3 py-2 text-left font-medium">客户端</th>
                          <th className="px-3 py-2 text-left font-medium">分类</th>
                          <th className="px-3 py-2 text-left font-medium">IP</th>
                          <th className="px-3 py-2 text-left font-medium">MAC</th>
                          <th className="px-3 py-2 text-left font-medium">连接</th>
                          <th className="px-3 py-2 text-right font-medium">流量 / 速率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allClients.map((client, index) => {
                          const baseName = String(client.displayName ?? client.systemTitle ?? client.name ?? client.hostname ?? client.deviceName ?? '未命名设备').trim();
                          const duplicate = (displayNameCount.get(baseName) ?? 0) > 1;
                          const displayName = duplicate
                            ? `${baseName} · ${String(client.ip ?? client.ipAddress ?? client.mac ?? client.macAddress ?? '').split('.').pop() || String(client.mac ?? client.macAddress ?? '').slice(-5)}`
                            : baseName;
                          const connectionText = [
                            client.band ?? client.interfaceType ?? client.interface ?? client.iface ?? client.radio ?? null,
                            (typeof client.rssiDbm === 'number' || typeof client.rssi === 'number')
                              ? `${client.rssiDbm ?? client.rssi} dBm`
                              : null,
                          ].filter(Boolean).join(' · ');
                          const trafficText = formatClientTraffic(client);
                          return (
                            <tr key={`${client.mac ?? client.ip ?? index}`} className="border-t border-slate-200/70 hover:bg-slate-50 dark:border-slate-700/40 dark:hover:bg-slate-800/30">
                              <td className="px-3 py-2 text-slate-400">{index + 1}</td>
                              <td className="px-3 py-2">
                                <div className="font-medium break-all">{displayName}</div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {client.managed ? <Badge variant="outline" className="text-[10px] border-emerald-400/50 text-emerald-700 dark:text-emerald-300">已接入系统</Badge> : null}
                                  {client.inferred ? <Badge variant="outline" className="text-[10px] border-sky-300/60 text-sky-700 dark:text-sky-300">推断</Badge> : null}
                                </div>
                                {client.vendorResolved ? (
                                  <div className="mt-1 text-xs text-muted-foreground break-all">{client.vendorResolved}</div>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex flex-wrap gap-1">
                                  <Badge variant="outline" className="text-[10px]">{client.systemCategoryLabel ?? client.endpointType ?? '未知终端'}</Badge>
                                  {client.systemCategoryLabel && client.endpointType && client.systemCategoryLabel !== client.endpointType ? (
                                    <Badge variant="outline" className="text-[10px] text-muted-foreground">{client.endpointType}</Badge>
                                  ) : null}
                                </div>
                              </td>
                              <td className="px-3 py-2 font-mono">{client.ip ?? client.ipAddress ?? '--'}</td>
                              <td className="px-3 py-2 font-mono">{client.mac ?? client.macAddress ?? '--'}</td>
                              <td className="px-3 py-2">{connectionText || <span className="text-muted-foreground">--</span>}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">{trafficText || <span className="text-muted-foreground">--</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        }

        if (section === 'nodes' && meshNodes.length > 0) {
          return (
            <Card key="nodes">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-sky-600" />
                  Mesh 节点
                  <Badge variant="outline">{meshNodes.length} 个</Badge>
                </CardTitle>
                <CardDescription>主控与子节点拆开显示，信息比卡片摘要更完整。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {meshNodes.map((node, index) => (
                    <div
                      key={node.nodeId ?? index}
                      className={cn(
                        'rounded-lg border p-4 space-y-2',
                        node.online
                          ? 'bg-sky-50 border-sky-200/60 dark:bg-sky-950/20 dark:border-sky-700/50'
                          : 'bg-slate-50 border-slate-200/60 dark:bg-slate-900/30 dark:border-slate-700/50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold">
                          {node.role === 'master' ? '主控 Beacon 1' : node.model ?? `节点 ${index + 1}`}
                        </div>
                        <Badge variant="outline">{node.role === 'master' ? '主控' : '子节点'}</Badge>
                      </div>
                      {[
                        ['IP', node.ip ?? null],
                        ['客户端', node.totalClientCount != null && node.totalClientCount > 0 ? `${node.totalClientCount} 台` : null],
                        ['回程', node.backhaulType ? `${node.backhaulType}${node.backhaulRateMbps ? ` ${node.backhaulRateMbps} Mbps` : ''}` : null],
                        ['上游节点', node.parentNodeId ?? '（根）'],
                      ].filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                        <div key={String(label)} className="flex items-start justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-medium break-all text-right">{value}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        }

        if (section === 'runtime') {
          return (
            <Card key="runtime">
              <CardHeader>
                <CardTitle>运行时概览</CardTitle>
                <CardDescription>保留原来的运行时查看入口，但放大到单独页面里看。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {runtimeRows.filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                    <div key={label} className="rounded-lg border bg-muted/20 p-4">
                      <div className="text-sm text-muted-foreground">{label}</div>
                      <div className="mt-2 text-base font-semibold break-all">{value}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        }

        return null;
      })}
    </div>
  );
}

export default NetworkDevicePage;
