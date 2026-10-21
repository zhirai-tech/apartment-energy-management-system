import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, BarChart3, Power, RefreshCw, ShieldAlert, BellRing, ZapOff, X, Plus, PencilLine, Search } from 'lucide-react';
import { toast } from 'sonner';
import * as api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import {
  RoomStatus,
  UserRole,
  AlarmLevel,
  DEVICE_CATEGORY_LABEL,
  networkGroupKey,
  pickPrimaryPublicNetworkDevice,
  publicNetworkPrimaryScore,
  inferPublicNetworkRole,
  inferShortDeviceName,
  type DeviceItem,
} from '@/types';
import type { DashboardSummary, AlarmLogResponse, SiteSummary } from '@/types';
import { StatsCards } from '@/components/dashboard/StatsCards';
import { RoomsGrid, type DashboardSpaceCard, floorToDualLabel } from '@/components/dashboard/RoomsGrid';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuthStore } from '@/store/auth';
import { useSiteStore } from '@/store/site';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function getRoomSortValue(roomNumber?: string | null): number {
  const parsed = Number.parseInt(roomNumber ?? '', 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function getSiteLabel(site: Pick<SiteSummary, 'isPrimary' | 'name'>): string {
  if (site.isPrimary && (!site.name || site.name === '区域1' || site.name === '默认区')) {
    return '默认区';
  }
  return site.name;
}

function normalizeMacKey(value?: string | null): string {
  return String(value ?? '').toUpperCase().replace(/[^A-F0-9]/g, '');
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
  if (/(ipad|tablet|tab\b|mi pad|huawei matepad|xiaoxin pad)/.test(text)) return '平板';
  if (/(macbook|notebook|laptop|desktop|thinkpad|surface|windows|pc\b|lenovo|dell|hp\b|asus|acer|msi)/.test(text)) return '电脑';
  if (/(amazon|echo|alexa|homepod|google home|nest)/.test(text)) return '音箱';
  if (/(tv|bravia|hisense|tcl|xiaomi tv|appletv|apple tv|webos)/.test(text)) return '电视';
  if (/(printer|epson|canon|brother|hp laser|hp ink|打印机)/.test(text)) return '打印机';
  if (/(switch|breaker|relay|lxzn|miot|tuya|iot|sensor|plug|air purifier|vacuum)/.test(text)) return 'IoT 设备';
  if (/(beacon|router|mesh|h122|gateway|网关|路由)/.test(text)) return '网络设备';
  return '未知终端';
}

function isGenericClientName(value?: string | null): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return true;
  return /^unknown[_-]/.test(text) || /^lan device\b/.test(text) || /^\*no company\*/.test(text);
}

function enrichNetworkClients(
  clients: any[],
  allDevices: DeviceItem[],
): any[] {
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
    const vendorResolved =
      client?.vendor ??
      matchedVendor ??
      null;
    const rawName = [
      client?.name,
      client?.hostname,
      client?.deviceName,
    ].find((item) => !isGenericClientName(item)) ?? null;
    const endpointType = inferClientEndpointType({
      name: matchedTitle ?? rawName,
      hostname: client?.hostname ?? client?.deviceName ?? null,
      vendor: vendorResolved,
      systemCategory: matchedCategory,
      interfaceType: client?.interfaceType ?? client?.interface ?? client?.iface ?? null,
    });
    let baseName =
      matchedTitle ??
      rawName ??
      vendorResolved ??
      endpointType;
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

export function DashboardPage() {
  const DASHBOARD_ALARM_DISPLAY_MS = 12000;
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.role);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const selectedSiteId = useSiteStore((state) => state.selectedSiteId);
  const setSelectedSiteId = useSiteStore((state) => state.setSelectedSiteId);
  const canControl = role === UserRole.ADMIN || role === UserRole.BOSS;
  const [refreshing, setRefreshing] = useState(false);
  const [powerPending, setPowerPending] = useState(false);
  const [limitPending, setLimitPending] = useState(false);
  const [confirmPowerOffOpen, setConfirmPowerOffOpen] = useState(false);
  const [confirmLimitOffOpen, setConfirmLimitOffOpen] = useState(false);
  const [showLatestAlarm, setShowLatestAlarm] = useState(false);
  const [dismissedLatestAlarmId, setDismissedLatestAlarmId] = useState<string | null>(null);
  const [createSiteOpen, setCreateSiteOpen] = useState(false);
  const [renameSiteOpen, setRenameSiteOpen] = useState(false);
  const [siteNameInput, setSiteNameInput] = useState('');
  const [siteDescriptionInput, setSiteDescriptionInput] = useState('');

  const { data: sites = [] } = useQuery({
    queryKey: ['system-sites'],
    queryFn: api.system.getSites,
    enabled: isAuthenticated,
    staleTime: 1000 * 60,
  });

  const fallbackSiteId = sites[0]?.id;
  const resolvedSiteId = selectedSiteId ?? fallbackSiteId;
  const selectedSite = useMemo(
    () => sites.find((item) => item.id === resolvedSiteId) ?? null,
    [resolvedSiteId, sites],
  );
  const selectedSiteLabel = selectedSite ? getSiteLabel(selectedSite) : '默认区';

  const createSiteMutation = useMutation({
    mutationFn: api.system.createSite,
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['system-sites'] });
      setSelectedSiteId(created.id);
      setCreateSiteOpen(false);
      setSiteNameInput('');
      setSiteDescriptionInput('');
      toast.success('区域已添加');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '添加区域失败');
    },
  });

  const renameSiteMutation = useMutation({
    mutationFn: ({ siteId, name, description }: { siteId: string; name: string; description?: string }) =>
      api.system.updateSite(siteId, { name, description }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['system-sites'] });
      setRenameSiteOpen(false);
      toast.success('区域名称已更新');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '修改区域失败');
    },
  });

  useEffect(() => {
    if (!sites.length) return;
    if (!selectedSiteId) {
      setSelectedSiteId(sites[0].id);
      return;
    }
    const exists = sites.some((item) => item.id === selectedSiteId);
    if (!exists) {
      setSelectedSiteId(sites[0].id);
    }
  }, [selectedSiteId, setSelectedSiteId, sites]);

  useEffect(() => {
    if (!renameSiteOpen || !selectedSite) return;
    setSiteNameInput(getSiteLabel(selectedSite));
    setSiteDescriptionInput(selectedSite.description ?? '');
  }, [renameSiteOpen, selectedSite]);

  const { data: settings } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.system.getSettings(),
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60,
  });
  const dashboardRefreshInterval = Math.max(5000, Number(settings?.refreshInterval ?? 5000) || 5000);

  const { data: summary, isLoading: summaryLoading } = useQuery<DashboardSummary>({
    queryKey: ['dashboard', resolvedSiteId ?? 'all'],
    queryFn: () => api.dashboard.get(resolvedSiteId),
    refetchOnWindowFocus: false,
    refetchInterval: dashboardRefreshInterval,
    refetchIntervalInBackground: true,
    staleTime: dashboardRefreshInterval,
  });
  const { data: unresolvedAlarms } = useQuery<{
    items: AlarmLogResponse[];
    total: number;
    page: number;
    pageSize: number;
  }>({
    queryKey: ['dashboard-unresolved-alarms', resolvedSiteId ?? 'all'],
    queryFn: () => api.logs.alarms({ page: 1, pageSize: 1, resolved: false, siteId: resolvedSiteId }),
    refetchOnWindowFocus: false,
    refetchInterval: dashboardRefreshInterval,
    refetchIntervalInBackground: true,
    staleTime: dashboardRefreshInterval,
  });

  useEffect(() => {
    const socket = getSocket();
    const handler = () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-unresolved-alarms'] });
    };
    socket.on('dashboard', handler);
    return () => {
      socket.off('dashboard', handler);
    };
  }, [queryClient]);

  const isLoading = summaryLoading || !summary;

  const displayCards = useMemo<DashboardSpaceCard[]>(() => {
    if (!summary) return [];
    const roomData = Array.isArray(summary.roomData) ? summary.roomData : [];
    const devices = Array.isArray(summary.devices) ? summary.devices : [];
    const roomCards = roomData
      .filter((room) => room.devices.length > 0)
      .map((room) => {
        const mainDevice = room.devices[0];
        const cumulativeTotalKwh = (room.devices ?? []).reduce(
          (sum, device) => sum + Number(device.totalKwh ?? 0),
          0,
        );
        const title = room.roomAnnotation?.trim() ? room.roomAnnotation : '未命名房间';

        const first = mainDevice as any;
        const deviceNameBits = [
          first?.name ?? null,
          first?.modelName ?? first?.model ?? null,
          first?.vendorName ?? first?.vendor ?? first?.manufacturer ?? null,
          first?.hostname ?? null,
          first?.productName ?? null,
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        const idHint = deviceNameBits.length > 0 ? deviceNameBits.join(' · ') : (mainDevice?.did ? `DID ${String(mainDevice.did).slice(-6)}` : '');

        return {
          key: room.roomId,
          title,
          subtitle: '',
          idHint,
          roomId: room.roomId,
          roomNumber: room.roomNumber,
          roomAnnotation: room.roomAnnotation ?? null,
          floor: room.floor ?? 1,
          status: room.status,
          power: room.power ?? mainDevice?.powerW ?? 0,
          todayUsage: room.todayUsage,
          monthUsage: room.monthUsage ?? 0,
          monthCost: room.monthCost ?? 0,
          cumulativeUsage: cumulativeTotalKwh > 0 ? cumulativeTotalKwh : (mainDevice?.totalKwh ?? 0),
          usagePercent: room.usagePercent,
          dailyLimit: room.dailyLimit,
          limitEnabled: room.limitEnabled,
          monthlyCostLimit: room.monthlyCostLimit ?? 0,
          costLimitEnabled: room.costLimitEnabled ?? false,
          cutoff: room.cutoff,
          deviceOnline: room.deviceOnline,
            powerActionCooldownUntil: room.powerActionCooldownUntil,
            powerActionRetryAfterSeconds: room.powerActionRetryAfterSeconds,
            powerActionLastType: room.powerActionLastType,
          devices: room.devices,
          mapped: true,
        } satisfies DashboardSpaceCard;
      })
      .sort((a, b) => {
        const roomDiff = getRoomSortValue(a.roomNumber) - getRoomSortValue(b.roomNumber);
        if (roomDiff !== 0) {
          return roomDiff;
        }
        return (a.roomNumber || a.key).localeCompare(b.roomNumber || b.key, 'en');
      });

    const roomDidSet = new Set(
      roomCards.flatMap((room) => room.devices.map((device) => device.did)),
    );

    const PUBLIC_FACILITY_CATEGORIES = new Set<string>([
      'wifi_ap',
      'five_g_cpe',
      'camera',
    ]);

    const unassigned = devices.filter((device) => !roomDidSet.has(device.did));
    const publicFacilityDevices = unassigned.filter((device) =>
      PUBLIC_FACILITY_CATEGORIES.has(String((device as any).category ?? 'other')),
    );
    const fallbackManagedDevices = unassigned.filter((device) => {
      const cat = String((device as any).category ?? 'other');
      if (PUBLIC_FACILITY_CATEGORIES.has(cat)) return false;
      if (cat === 'other') return false;
      return true;
    });

    const networkCategorySet = new Set<string>(['wifi_ap', 'five_g_cpe']);
    const networkDevices = publicFacilityDevices.filter((device) =>
      networkCategorySet.has(String((device as any).category ?? 'other')),
    );
    const cameraDevices = publicFacilityDevices.filter(
      (device) => String((device as any).category ?? 'other') === 'camera',
    );

    type NetworkDeviceWithContext = DeviceItem & {
      __groupKey: string | null;
      __score: number;
      __clientCount: number;
      __meshNodeCount: number;
      __ssid: string | null;
    };
    const networkWithContext: NetworkDeviceWithContext[] = networkDevices.map((device) => {
      const category = String((device as any).category ?? 'wifi_ap') as any;
      const anyDev = device as any;
      const runtime = anyDev.runtime ?? anyDev.modelRuntime ?? anyDev.adapterRuntime ?? null;
      const wifiAp = runtime?.wifiAp ?? anyDev.wifiAp ?? anyDev.wifi_ap ?? null;
      const cpe = runtime?.fiveGCpe ?? anyDev.fiveGCpe ?? anyDev.cpe ?? runtime?.cpe ?? null;
      const meshTop = (Array.isArray(wifiAp?.meshTopology) ? wifiAp.meshTopology : Array.isArray(cpe?.meshTopology) ? cpe.meshTopology : []) as any[];
      const clientCount = Number(
        wifiAp?.clientCount ?? cpe?.clientCount ?? (Array.isArray(wifiAp?.clients) ? wifiAp.clients.length : 0) ?? (Array.isArray(cpe?.clients) ? cpe.clients.length : 0) ?? 0
      );
      const ssid = String(wifiAp?.ssid ?? cpe?.ssid ?? anyDev.ssid ?? '').trim() || null;
      const ctx = {
        category,
        ip: anyDev.ipAddress ?? anyDev.ip ?? anyDev.ipaddress ?? null,
        mac: anyDev.mac ?? anyDev.macAddress ?? anyDev.macaddress ?? null,
        vendor: anyDev.vendor ?? anyDev.manufacturer ?? anyDev.brand ?? null,
        name: anyDev.name ?? null,
        model: anyDev.model ?? null,
        hostname: anyDev.hostname ?? anyDev.hostName ?? null,
        ssid,
        clientCount,
        meshNodeCount: meshTop.length,
        roll: meshTop.some((n: any) => String(n.role ?? '') === 'master' && n.nodeId)
          ? 'master'
          : inferPublicNetworkRole({
              category,
              name: anyDev.name ?? null,
              model: anyDev.model ?? null,
              hostname: anyDev.hostname ?? anyDev.hostName ?? null,
              vendor: anyDev.vendor ?? anyDev.manufacturer ?? anyDev.brand ?? null,
            }),
      };
      const gk = networkGroupKey(ctx);
      const sc = publicNetworkPrimaryScore({
        ...ctx,
        status: (anyDev.status as any) ?? 'unknown',
        uptimeSeconds: Number(anyDev.uptimeSeconds ?? anyDev.uptime ?? 0) || null,
      });
      return {
        ...device,
        __groupKey: gk,
        __score: sc,
        __clientCount: clientCount,
        __meshNodeCount: meshTop.length,
        __ssid: ssid,
      } as NetworkDeviceWithContext;
    });
    const networkGroups = new Map<string, NetworkDeviceWithContext[]>();
    for (const device of networkWithContext) {
      const key = device.__groupKey ?? `single_${device.did}`;
      const list = networkGroups.get(key) ?? [];
      list.push(device);
      networkGroups.set(key, list);
    }
    const pickedNetworkPrimary = new Set<string>();
    const foldedIntoPrimary = new Map<string, NetworkDeviceWithContext[]>();
    for (const [, list] of networkGroups) {
      if (list.length <= 1) continue;
      const primary = pickPrimaryPublicNetworkDevice(list);
      if (!primary) continue;
      pickedNetworkPrimary.add(primary.did);
      const others = list.filter((x) => x.did !== primary.did);
      if (others.length > 0) foldedIntoPrimary.set(primary.did, others);
    }

    const visibleNetworkDevices = networkWithContext.filter((device) => {
      if (foldedIntoPrimary.size === 0) return true;
      if (pickedNetworkPrimary.has(device.did)) return true;
      const inSomeFold = Array.from(foldedIntoPrimary.values()).some((arr) =>
        arr.some((x) => x.did === device.did),
      );
      if (inSomeFold) return false;
      return true;
    });
    const allKnownDevices = Array.isArray(summary?.devices) ? summary.devices : [];

    const networkGroupedPublicFacility: DashboardSpaceCard[] = [
      ...visibleNetworkDevices.map((device): DashboardSpaceCard => {
        const cat = String((device as any).category ?? 'other');
        const folded = foldedIntoPrimary.get(device.did) ?? [];
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
            ? visibleNetworkDevices
                .filter((candidate) => candidate.did !== device.did)
                .filter((candidate) => {
                  const candidateAny = candidate as any;
                  const candidateIp = String(candidateAny.ipAddress ?? candidateAny.ip ?? '').trim();
                  if (!candidateIp || !primarySubnet) return false;
                  return candidateIp.startsWith(`${primarySubnet}.`);
                })
                .sort((a, b) => {
                  const aCat = String((a as any).category ?? '');
                  const bCat = String((b as any).category ?? '');
                  if (aCat !== bCat) {
                    if (aCat === 'wifi_ap') return -1;
                    if (bCat === 'wifi_ap') return 1;
                  }
                  return publicNetworkPrimaryScore({
                    category: String((b as any).category ?? 'other') as any,
                    ip: (b as any).ipAddress ?? null,
                    mac: (b as any).mac ?? null,
                    vendor: (b as any).vendorName ?? (b as any).vendor ?? null,
                    name: (b as any).name ?? null,
                    model: (b as any).model ?? null,
                    hostname: (b as any).hostname ?? null,
                    ssid: (b as any).wifiAp?.ssid ?? null,
                    clientCount: Number((b as any).wifiAp?.clientCount ?? (b as any).fiveGCpe?.connectedDevices ?? 0),
                    meshNodeCount: Array.isArray((b as any).wifiAp?.meshTopology) ? (b as any).wifiAp.meshTopology.length : 0,
                    status: (b as any).status ?? 'unknown',
                    uptimeSeconds: Number((b as any).uptimeSeconds ?? 0) || null,
                  }) - publicNetworkPrimaryScore({
                    category: String((a as any).category ?? 'other') as any,
                    ip: (a as any).ipAddress ?? null,
                    mac: (a as any).mac ?? null,
                    vendor: (a as any).vendorName ?? (a as any).vendor ?? null,
                    name: (a as any).name ?? null,
                    model: (a as any).model ?? null,
                    hostname: (a as any).hostname ?? null,
                    ssid: (a as any).wifiAp?.ssid ?? null,
                    clientCount: Number((a as any).wifiAp?.clientCount ?? (a as any).fiveGCpe?.connectedDevices ?? 0),
                    meshNodeCount: Array.isArray((a as any).wifiAp?.meshTopology) ? (a as any).wifiAp.meshTopology.length : 0,
                    status: (a as any).status ?? 'unknown',
                    uptimeSeconds: Number((a as any).uptimeSeconds ?? 0) || null,
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
        const displayDevice: DeviceItem = inferredCpeClients.length > 0
          ? {
              ...(device as DeviceItem),
              fiveGCpe: {
                ...(primaryAny.fiveGCpe ?? {}),
                clients: enrichNetworkClients(inferredCpeClients, allKnownDevices),
              },
              wifiAp: primaryAny.wifiAp
                ? {
                    ...primaryAny.wifiAp,
                    clients: enrichNetworkClients(
                      Array.isArray(primaryAny.wifiAp?.clients) ? primaryAny.wifiAp.clients : [],
                      allKnownDevices,
                    ),
                  }
                : primaryAny.wifiAp,
            }
          : {
              ...(device as DeviceItem),
              fiveGCpe: primaryAny.fiveGCpe
                ? {
                    ...primaryAny.fiveGCpe,
                    clients: enrichNetworkClients(
                      Array.isArray(primaryAny.fiveGCpe?.clients) ? primaryAny.fiveGCpe.clients : [],
                      allKnownDevices,
                    ),
                  }
                : primaryAny.fiveGCpe,
              wifiAp: primaryAny.wifiAp
                ? {
                    ...primaryAny.wifiAp,
                    clients: enrichNetworkClients(
                      Array.isArray(primaryAny.wifiAp?.clients) ? primaryAny.wifiAp.clients : [],
                      allKnownDevices,
                    ),
                  }
                : primaryAny.wifiAp,
            };
        const mergedDevices: DeviceItem[] = [displayDevice, ...folded.map((f) => f as DeviceItem)];
        const onlineCount = mergedDevices.filter((d) => d.status === 'online').length;

        const primaryVendor =
          primaryAny.vendorName ??
          primaryAny.vendor ??
          primaryAny.manufacturer ??
          primaryAny.brand ??
          (primaryAny.adapterKind === 'huawei_cpe' ? 'Huawei' : primaryAny.adapterKind === 'nokia_beacon' ? 'Nokia' : null);
        const primaryModel =
          primaryAny.fiveGCpe?.model ??
          primaryAny.wifiAp?.model ??
          primaryAny.model ??
          null;
        const primaryKind =
          primaryAny.adapterKind === 'huawei_cpe'
            ? 'cpe'
            : cat === 'wifi_ap'
              ? (folded.length > 0 ? 'master' : 'ap')
              : 'cpe';
        const { shortName, detailHint } = inferShortDeviceName(
          cat,
          primaryVendor,
          primaryModel,
          primaryAny.name ?? null,
          primaryAny.ipAddress ?? primaryAny.ip ?? null,
          primaryKind,
        );
        const networkClientCount =
          Number(primaryAny.wifiAp?.clientCount ?? primaryAny.fiveGCpe?.connectedDevices ?? NaN);
        const networkBand =
          typeof primaryAny.wifiAp?.band === 'string' && primaryAny.wifiAp.band.trim()
            ? primaryAny.wifiAp.band.trim()
            : null;
        const idHintParts = [
          primaryAny.ipAddress ? `IP ${primaryAny.ipAddress}` : null,
          primaryAny.adapterKind === 'huawei_cpe'
            ? (primaryAny.fiveGCpe?.model ?? primaryModel ?? null)
            : networkBand,
          Number.isFinite(networkClientCount) && networkClientCount > 0 ? `${networkClientCount} 台设备` : null,
          detailHint,
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        const idHint = idHintParts.length > 0
          ? Array.from(new Set(idHintParts.map((s) => s.trim()))).join(' · ')
          : `IP ${primaryAny.ipAddress ?? String(device.did).slice(-6)}`;

        const subtitleBits: string[] = [];
        if (folded.length > 0) subtitleBits.push(`含 ${folded.length + 1} 节点`);
        const subtitle = subtitleBits.join(' · ');

        return {
          key: `PF_${device.did}`,
          title: shortName,
          subtitle,
          idHint,
          roomId: null,
          roomNumber: device.roomNumber ?? null,
          roomAnnotation: (device as any).roomAnnotation ?? null,
          floor: 0,
          status: mergedDevices.some((d) => d.status === 'online')
            ? RoomStatus.NORMAL
            : RoomStatus.OFFLINE,
          power: mergedDevices.reduce((acc, d) => acc + (d.powerW ?? 0), 0),
          todayUsage: mergedDevices.reduce(
            (acc, d) => acc + Number((d as any).todayUsageKwh ?? 0) || 0,
            0,
          ),
          monthUsage: mergedDevices.reduce(
            (acc, d) => acc + Number(d.totalKwh ?? 0) || 0,
            0,
          ),
          monthCost: 0,
          cumulativeUsage: mergedDevices.reduce(
            (acc, d) => acc + Number(d.totalKwh ?? 0) || 0,
            0,
          ),
          usagePercent: 0,
          dailyLimit: null,
          limitEnabled: false,
          monthlyCostLimit: null,
          costLimitEnabled: false,
          cutoff: false,
          deviceOnline:
            folded.length > 0
              ? Math.max(1, onlineCount)
              : device.status === 'online',
          powerActionCooldownUntil: null,
          powerActionRetryAfterSeconds: 0,
          powerActionLastType: null,
          devices: mergedDevices,
          mapped: true,
          publicFacility: true,
        };
      }),
      ...cameraDevices.map((device): DashboardSpaceCard => {
        const camAny = device as any;
        const { shortName, detailHint } = inferShortDeviceName(
          String(camAny.category ?? 'camera'),
          camAny.vendorName ?? camAny.vendor ?? camAny.manufacturer ?? camAny.brand ?? null,
          camAny.camera?.model ?? camAny.model ?? null,
          camAny.name ?? null,
          camAny.ipAddress ?? camAny.ip ?? null,
          'camera',
        );
        const camRawBits = [
          camAny.name ?? camAny.hostname ?? camAny.hostName ?? null,
          camAny.model ?? camAny.modelName ?? null,
          camAny.vendor ?? camAny.manufacturer ?? camAny.brand ?? camAny.vendorName ?? null,
          detailHint,
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        const idHint = camRawBits.length > 0
          ? Array.from(new Set(camRawBits.map((s) => s.trim()))).join(' · ')
          : `DID ${String(device.did).slice(-6)}`;
        const subtitle = '';
        return {
          key: `PF_${device.did}`,
          title: shortName,
          subtitle,
          idHint,
          roomId: null,
          roomNumber: device.roomNumber ?? null,
          roomAnnotation: (device as any).roomAnnotation ?? null,
          floor: 0,
          status: device.status === 'offline' ? RoomStatus.OFFLINE : RoomStatus.NORMAL,
          power: device.powerW ?? 0,
          todayUsage: (device as any).todayUsageKwh ?? 0,
          monthUsage: 0,
          monthCost: 0,
          cumulativeUsage: device.totalKwh ?? 0,
          usagePercent: 0,
          dailyLimit: null,
          limitEnabled: false,
          monthlyCostLimit: null,
          costLimitEnabled: false,
          cutoff: false,
          deviceOnline: device.status === 'online',
          powerActionCooldownUntil: null,
          powerActionRetryAfterSeconds: 0,
          powerActionLastType: null,
          devices: [device as any],
          mapped: true,
          publicFacility: true,
        };
      }),
    ].sort((a, b) => {
      const at =
        ((a.devices?.[0] as any)?.status === 'online' ? 0 : 1) * 10 +
        (a.publicFacility ? 0 : 1);
      const bt =
        ((b.devices?.[0] as any)?.status === 'online' ? 0 : 1) * 10 +
        (b.publicFacility ? 0 : 1);
      if (at !== bt) return at - bt;
      return a.title.localeCompare(b.title);
    });

    const deviceFallbackCards = fallbackManagedDevices
      .map((device) => {
        const any = device as any;
        const fallbackBits = [
          any.name ?? any.hostname ?? any.hostName ?? null,
          any.model ?? any.modelName ?? null,
          any.vendor ?? any.manufacturer ?? any.brand ?? any.vendorName ?? null,
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        const idHint = fallbackBits.length > 0
          ? fallbackBits.join(' · ')
          : `DID ${String(device.did).slice(-6)}`;
        const title = (any.name ?? device.name ?? '').toString().trim() || idHint.slice(0, 16) || '未命名设备';
        return {
          key: device.did,
          title,
          subtitle: (device.model || '').toString() || '',
          idHint,
          roomId: device.roomId,
          roomNumber: device.roomNumber,
          roomAnnotation: null,
          floor: 1,
          status: device.status === 'offline' ? RoomStatus.OFFLINE : RoomStatus.NORMAL,
          power: device.powerW ?? 0,
          todayUsage: 0,
          monthUsage: 0,
          monthCost: 0,
          cumulativeUsage: device.totalKwh ?? 0,
          usagePercent: 0,
          dailyLimit: null,
          limitEnabled: false,
          monthlyCostLimit: null,
          costLimitEnabled: false,
          cutoff: false,
          deviceOnline: device.status === 'online',
          powerActionCooldownUntil: null,
          powerActionRetryAfterSeconds: 0,
          powerActionLastType: null,
          devices: [device],
          mapped: true,
        };
      })
      .sort((a, b) => {
        const roomDiff = getRoomSortValue(a.roomNumber) - getRoomSortValue(b.roomNumber);
        if (roomDiff !== 0) {
          return roomDiff;
        }
        return (a.roomNumber || a.title || a.key).localeCompare(
          b.roomNumber || b.title || b.key,
          'en',
        );
      });

    const base = [...roomCards, ...deviceFallbackCards];
    return [...networkGroupedPublicFacility, ...base];
  }, [summary]);

  const allCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: 0,
      circuit_breaker: 0,
      camera: 0,
      wifi_ap: 0,
      five_g_cpe: 0,
      smart_appliance: 0,
      other: 0,
    };
    const seen = new Set<string>();
    for (const card of displayCards) {
      const devices = card.devices ?? [];
      for (const d of devices) {
        const k = d.id ?? d.did;
        if (!k || seen.has(k)) continue;
        seen.add(k);
        const cat = String((d as any).category ?? 'other');
        counts[cat] = (counts[cat] ?? 0) + 1;
        counts.all = (counts.all ?? 0) + 1;
      }
    }
    return counts as Record<string, number>;
  }, [displayCards]);

  const presentGlobalCategories = useMemo<string[]>(() => {
    const keys = ['circuit_breaker', 'camera', 'wifi_ap', 'five_g_cpe', 'smart_appliance', 'other'];
    return keys.filter((k) => (allCategoryCounts[k] ?? 0) > 0);
  }, [allCategoryCounts]);
  const [activeGlobalCategory, setActiveGlobalCategory] = useState<string>('circuit_breaker');
  const [activeFloorFilter, setActiveFloorFilter] = useState<string>('all');
  useEffect(() => {
    if (!presentGlobalCategories.length) return;
    if (presentGlobalCategories.includes(activeGlobalCategory)) return;
    if (presentGlobalCategories.includes('circuit_breaker')) {
      setActiveGlobalCategory('circuit_breaker');
      return;
    }
    setActiveGlobalCategory(presentGlobalCategories[0]);
  }, [presentGlobalCategories, activeGlobalCategory]);
  const floorLabels = useMemo<Array<{ key: string; label: string; sortValue: number; isPublic?: boolean }>>(() => {
    if (!summary) return [];
    const seen = new Map<string, { key: string; label: string; sortValue: number; isPublic?: boolean }>();
    for (const card of displayCards) {
      if (card.publicFacility || !Number.isFinite(card.floor)) {
        if (!seen.has('public')) {
          seen.set('public', { key: 'public', label: '公共设施', sortValue: -9999, isPublic: true });
        }
        continue;
      }
      const label = floorToDualLabel(card.floor);
      const fkey = `floor_${card.floor}`;
      if (!seen.has(fkey)) {
        seen.set(fkey, { key: fkey, label, sortValue: card.floor });
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.sortValue - b.sortValue);
  }, [displayCards, summary]);

  const filteredCards = useMemo<DashboardSpaceCard[]>(() => {
    let arr = displayCards;
    if (activeGlobalCategory) {
      arr = arr.filter((card) =>
        (card.devices ?? []).some((d) => String((d as any).category ?? 'other') === activeGlobalCategory),
      );
    }
    if (activeFloorFilter !== 'all' && activeFloorFilter) {
      if (activeFloorFilter === 'public') {
        arr = arr.filter((card) => !!card.publicFacility || !Number.isFinite(card.floor));
      } else if (activeFloorFilter.startsWith('floor_')) {
        const target = Number(activeFloorFilter.slice(6));
        if (Number.isFinite(target)) {
          arr = arr.filter((card) => !card.publicFacility && Number.isFinite(card.floor) && card.floor === target);
        }
      }
    }
    return arr;
  }, [displayCards, activeGlobalCategory, activeFloorFilter]);
  const isEmptySelectedSite = !!selectedSite && (selectedSite.deviceCount === 0 || displayCards.length === 0);
  const pricePerKwh = settings?.pricePerKwh ?? 0.6;
  const activeCategoryLabel =
    (DEVICE_CATEGORY_LABEL as Record<string, string>)[activeGlobalCategory] ?? activeGlobalCategory ?? '设备';
  const allDevicesPoweredOn = useMemo(() => {
    const rooms = Array.isArray(summary?.roomData)
      ? summary.roomData.filter((room) => room.devices.length > 0)
      : [];
    if (!rooms.length) return false;
    return rooms.every((room) => !room.cutoff);
  }, [summary]);
  const allLimitsEnabled = useMemo(() => {
    const rooms = Array.isArray(summary?.roomData)
      ? summary.roomData.filter((room) => room.devices.length > 0)
      : [];
    if (!rooms.length) return false;
    return rooms.every((room) => room.limitEnabled);
  }, [summary]);
  const latestAlarm = unresolvedAlarms?.items?.[0];
  const unresolvedAlarmCount = Number(unresolvedAlarms?.total ?? 0);
  const cutoffRooms = useMemo(
    () =>
      (summary?.roomData ?? [])
        .filter((room) => room.cutoff)
        .sort((a, b) => getRoomSortValue(a.roomNumber) - getRoomSortValue(b.roomNumber))
        .map((room) => room.displayName || room.roomNumber)
        .filter(Boolean),
    [summary],
  );
  const latestAlarmBadgeVariant =
    latestAlarm?.level === AlarmLevel.CRITICAL || latestAlarm?.level === AlarmLevel.DANGER
      ? 'destructive'
      : 'default';
  const showLatestAlarmBanner =
    showLatestAlarm && !!latestAlarm && latestAlarm.id !== dismissedLatestAlarmId;

  useEffect(() => {
    if (!latestAlarm?.id) {
      setShowLatestAlarm(false);
      setDismissedLatestAlarmId(null);
      return;
    }

    setShowLatestAlarm(true);
    const timer = window.setTimeout(() => {
      setShowLatestAlarm(false);
    }, DASHBOARD_ALARM_DISPLAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [latestAlarm?.id]);

  const refreshDashboard = async () => {
    try {
      setRefreshing(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['system-settings'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-unresolved-alarms'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleAllPower = async (nextAction: 'on' | 'off') => {
    const rooms = Array.isArray(summary?.roomData)
      ? summary.roomData.filter((room) => room.devices.length > 0)
      : [];
    const targets = rooms.filter((room) => (nextAction === 'on' ? room.cutoff : !room.cutoff));
    if (!targets.length) {
      toast.success(nextAction === 'on' ? '全部空开已经开启' : '全部空开已经关闭');
      return;
    }
    try {
      setPowerPending(true);
      const results = await Promise.allSettled(
        targets.map((room) =>
          nextAction === 'on' ? api.energy.restore(room.roomId) : api.energy.cutoff(room.roomId),
        ),
      );
      const success = results.filter((item) => item.status === 'fulfilled').length;
      const failed = results.length - success;
      await refreshDashboard();
      if (failed > 0) {
        toast.warning(`${nextAction === 'on' ? '批量开启' : '批量关闭'}空开完成：成功 ${success} 个，失败 ${failed} 个`);
      } else {
        toast.success(nextAction === 'on' ? `已开启 ${success} 个空开` : `已关闭 ${success} 个空开`);
      }
    } catch {
      toast.error(nextAction === 'on' ? '批量开启空开失败' : '批量关闭空开失败');
    } finally {
      setPowerPending(false);
      setConfirmPowerOffOpen(false);
    }
  };

  const handleToggleAllLimits = async (enabled: boolean) => {
    try {
      setLimitPending(true);
      await api.energy.bulkToggleLimits(enabled, resolvedSiteId);
      await refreshDashboard();
      toast.success(enabled ? '已开启全部限额断电' : '已关闭全部限额断电');
    } catch {
      toast.error(enabled ? '开启全部限额断电失败' : '关闭全部限额断电失败');
    } finally {
      setLimitPending(false);
      setConfirmLimitOffOpen(false);
    }
  };

  return (
    <div className="app-page app-page-stack">
      <div className="app-page-header">
        <div className="app-page-header-title">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-600">
            <LayoutDashboard className="w-6 h-6" />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">仪表盘</h1>
            <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-xs">
              {selectedSiteLabel}
            </Badge>
          </div>
        </div>
        <div className="hidden min-w-0 flex-1 justify-center xl:flex">
          {showLatestAlarmBanner && latestAlarm ? (
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-red-200 bg-red-50/90 px-3 py-1.5 text-xs text-red-800 shadow-sm">
              <BellRing className="h-4 w-4 shrink-0 text-red-600" />
              <Badge variant={latestAlarmBadgeVariant} className="shrink-0 text-[10px]">
                {unresolvedAlarmCount > 1 ? `${unresolvedAlarmCount} 条` : '1 条'}
              </Badge>
              <span className="truncate">
                {(latestAlarm.displayName ?? latestAlarm.roomNumber ?? '未知房间') + '：' + latestAlarm.message}
              </span>
              <button
                type="button"
                className="shrink-0 text-red-700 transition hover:text-red-900"
                title="关闭报警提示"
                onClick={() => {
                  setDismissedLatestAlarmId(latestAlarm.id);
                  setShowLatestAlarm(false);
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
        <div className="app-page-toolbar ml-auto justify-end">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={resolvedSiteId ?? ''}
              onValueChange={(value) => setSelectedSiteId(value)}
            >
              <SelectTrigger className="h-10 w-[118px] rounded-full px-3">
                <SelectValue placeholder="选择区域" />
              </SelectTrigger>
              <SelectContent>
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id}>
                    {getSiteLabel(site)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {role === UserRole.ADMIN ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  onClick={() => {
                    setSiteNameInput('');
                    setSiteDescriptionInput('');
                    setCreateSiteOpen(true);
                  }}
                  title="添加区域"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                {selectedSite ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-full"
                    onClick={() => setRenameSiteOpen(true)}
                    title="修改区域"
                  >
                    <PencilLine className="h-4 w-4" />
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          {cutoffRooms.length > 0 ? (
            <div className="inline-flex max-w-[220px] items-center gap-2 rounded-full border border-amber-200 bg-amber-50/90 px-3 py-1.5 text-xs text-amber-800 shadow-sm">
              <ZapOff className="h-4 w-4 shrink-0 text-amber-700" />
              <span className="truncate">限额超出已停供 {cutoffRooms.length} 个</span>
            </div>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-10 w-10 rounded-full"
            onClick={refreshDashboard}
            disabled={refreshing || powerPending || limitPending}
            title="刷新数据"
          >
            <RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          {canControl && (
            <>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className={`h-10 w-10 rounded-full ${allDevicesPoweredOn ? 'border-green-500 text-green-600' : 'border-red-500 text-red-600'}`}
                onClick={() => {
                  if (allDevicesPoweredOn) {
                    setConfirmPowerOffOpen(true);
                    return;
                  }
                  handleToggleAllPower('on');
                }}
                disabled={refreshing || powerPending || limitPending || !(summary?.roomData?.some((room) => room.devices.length > 0))}
                title={allDevicesPoweredOn ? '关闭全部空开' : '开启全部空开'}
              >
                <Power className={`h-5 w-5 ${powerPending ? 'animate-pulse' : ''}`} />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className={`h-10 w-10 rounded-full ${allLimitsEnabled ? 'border-green-500 text-green-600' : 'border-red-500 text-red-600'}`}
                onClick={() => {
                  if (allLimitsEnabled) {
                    setConfirmLimitOffOpen(true);
                    return;
                  }
                  handleToggleAllLimits(true);
                }}
                disabled={refreshing || powerPending || limitPending || !(summary?.roomData?.length)}
                title={allLimitsEnabled ? '关闭全部限额断电' : '开启全部限额断电'}
              >
                <ShieldAlert className={`h-5 w-5 ${limitPending ? 'animate-pulse' : ''}`} />
              </Button>
            </>
          )}
        </div>
        {showLatestAlarmBanner && latestAlarm ? (
          <div className="flex justify-center xl:hidden">
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-red-200 bg-red-50/90 px-3 py-1.5 text-xs text-red-800 shadow-sm">
              <BellRing className="h-4 w-4 shrink-0 text-red-600" />
              <Badge variant={latestAlarmBadgeVariant} className="shrink-0 text-[10px]">
                {unresolvedAlarmCount > 1 ? `${unresolvedAlarmCount} 条` : '1 条'}
              </Badge>
              <span className="truncate">
                {(latestAlarm.displayName ?? latestAlarm.roomNumber ?? '未知房间') + '：' + latestAlarm.message}
              </span>
              <button
                type="button"
                className="shrink-0 text-red-700 transition hover:text-red-900"
                title="关闭报警提示"
                onClick={() => {
                  setDismissedLatestAlarmId(latestAlarm.id);
                  setShowLatestAlarm(false);
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : (
        <StatsCards summary={summary} pricePerKwh={pricePerKwh} />
      )}

      <Separator />

      <div>
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold sm:text-lg">
              <BarChart3 className="h-5 w-5 shrink-0 text-indigo-600" />
              {activeCategoryLabel}
            </h2>
            <span className="truncate text-xs text-muted-foreground">
              共 {filteredCards.length} / {displayCards.length}
            </span>
          </div>
          <div className="flex flex-wrap items-stretch gap-2">
            {presentGlobalCategories.length > 0 ? (
              <Tabs value={activeGlobalCategory} onValueChange={setActiveGlobalCategory} className="w-auto shrink-0">
                <TabsList className="inline-flex flex-wrap h-9 rounded-lg bg-muted/60 p-1 gap-1">
                  {presentGlobalCategories.map((cat) => {
                    const label = ((DEVICE_CATEGORY_LABEL as Record<string, string>)[cat] ?? cat);
                    const count = allCategoryCounts[cat] ?? 0;
                    return (
                      <TabsTrigger
                        key={cat}
                        value={cat}
                        className="data-[state=active]:bg-white data-[state=active]:text-indigo-700 data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-800 dark:data-[state=active]:text-indigo-300 rounded-md px-2.5 h-7 text-[11px] sm:text-xs inline-flex items-center gap-1"
                      >
                        {label}
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-slate-300/60 text-slate-500">
                          {count}
                        </Badge>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            ) : null}
            {floorLabels.length > 0 ? (
              <Select value={activeFloorFilter} onValueChange={setActiveFloorFilter}>
                <SelectTrigger className="h-9 w-[156px] rounded-lg px-2.5">
                  <SelectValue placeholder="按楼层筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部楼层</SelectItem>
                  {floorLabels.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </div>
        {isLoading ? (
          <div className="app-card-grid-tight" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 360px))', justifyContent: 'flex-start' }}>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-52 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {isEmptySelectedSite ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-8 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600">
                  <Search className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold">{selectedSiteLabel} 暂未接入设备</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  当前这个区域还是空的。后面你可以在这里接入新区域设备、识别本地区域设备，或者把它改成真实地址名称。
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {role === UserRole.ADMIN ? (
                    <>
                      <Button type="button" onClick={() => setRenameSiteOpen(true)}>
                        <PencilLine className="mr-2 h-4 w-4" />
                        修改区域名称
                      </Button>
                      <Button type="button" variant="outline" disabled title="下一阶段接入">
                        <Search className="mr-2 h-4 w-4" />
                        识别区域设备
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <RoomsGrid rooms={filteredCards} pricePerKwh={pricePerKwh} flatMode />
            )}
          </>
        )}
      </div>

      <Dialog open={confirmPowerOffOpen} onOpenChange={setConfirmPowerOffOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认关闭全部空开？</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            这只会对当前区域的智能空开执行统一断电，不会碰路由、网关和摄像头。
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPowerOffOpen(false)} disabled={powerPending}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => handleToggleAllPower('off')} disabled={powerPending}>
              {powerPending ? '执行中...' : '确认关闭'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmLimitOffOpen} onOpenChange={setConfirmLimitOffOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认关闭全部限额断电？</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            关闭后不会再按各自日限额自动断电，但每个空间的限额数值会保留。
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLimitOffOpen(false)} disabled={limitPending}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => handleToggleAllLimits(false)} disabled={limitPending}>
              {limitPending ? '执行中...' : '确认关闭'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createSiteOpen} onOpenChange={setCreateSiteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加新区域</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="site-name">区域名称</Label>
              <Input
                id="site-name"
                value={siteNameInput}
                onChange={(event) => setSiteNameInput(event.target.value)}
                placeholder="例如：柏林 1 号 / 维也纳公寓 A 栋"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-description">区域说明</Label>
              <Input
                id="site-description"
                value={siteDescriptionInput}
                onChange={(event) => setSiteDescriptionInput(event.target.value)}
                placeholder="可选：记录地址、用途或节点说明"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateSiteOpen(false)} disabled={createSiteMutation.isPending}>
              取消
            </Button>
            <Button
              onClick={() =>
                createSiteMutation.mutate({
                  name: siteNameInput,
                  description: siteDescriptionInput || undefined,
                })
              }
              disabled={createSiteMutation.isPending || !siteNameInput.trim()}
            >
              {createSiteMutation.isPending ? '创建中...' : '确认添加'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameSiteOpen} onOpenChange={setRenameSiteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改区域信息</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rename-site-name">区域名称</Label>
              <Input
                id="rename-site-name"
                value={siteNameInput}
                onChange={(event) => setSiteNameInput(event.target.value)}
                placeholder="请输入新的区域名称"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rename-site-description">区域说明</Label>
              <Input
                id="rename-site-description"
                value={siteDescriptionInput}
                onChange={(event) => setSiteDescriptionInput(event.target.value)}
                placeholder="可选：地址、备注、节点用途"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSiteOpen(false)} disabled={renameSiteMutation.isPending}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (!selectedSite) return;
                renameSiteMutation.mutate({
                  siteId: selectedSite.id,
                  name: siteNameInput,
                  description: siteDescriptionInput,
                });
              }}
              disabled={renameSiteMutation.isPending || !siteNameInput.trim() || !selectedSite}
            >
              {renameSiteMutation.isPending ? '保存中...' : '保存修改'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
