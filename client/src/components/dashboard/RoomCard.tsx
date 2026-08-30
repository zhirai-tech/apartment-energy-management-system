import { useState, type MouseEvent, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Pencil,
  Cpu,
  Power,
  Upload,
  Download,
  Server,
  Users,
  Mic,
  HardDrive,
  BellRing,
  Moon,
  Wifi as WifiIcon,
  SignalHigh,
  Clock,
  BarChart3,
  Thermometer,
  Maximize2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Image,
  Settings,
  ExternalLink,
  WifiOff,
} from 'lucide-react';
import {
  ROOM_STATUS_COLORS,
  ROOM_STATUS_TEXT,
  UserRole,
  DeviceCategory,
  DEVICE_CATEGORY_LABEL,
} from '../../types';
import type { DeviceItem } from '../../types';
import { cn } from '../../lib/utils';
import {
  formatCost,
  formatEnergy,
  formatPower,
  countDeviceCategories,
  pickPrimaryCategory,
  getCategoryToneClass,
  getCategoryIcon,
  formatBytes,
  hasMeaningfulValue,
  progressColorForPercent,
  inferEndpointTypeLabel,
} from '../../lib/format';
import { getRoomStatusCardToneClass } from '../../lib/status-maps';
import { energy, system } from '../../lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { useAuthStore } from '../../store/auth';
import { DashboardSpaceCard, floorToDualLabel } from './RoomsGrid';
import { RoomDetailDialog } from './RoomDetailDialog';
import { FeeHint } from '../ui/fee-hint';

interface RoomCardProps {
  room: DashboardSpaceCard;
  pricePerKwh: number;
}

function getToggleButtonClass(checked: boolean, disabled?: boolean) {
  return cn(
    'inline-flex h-8 w-full min-w-0 items-center justify-center rounded-full border px-3 text-[11px] font-medium backdrop-blur-sm transition-colors',
    checked
      ? 'border-emerald-500/55 bg-emerald-600/24 text-emerald-800 hover:bg-emerald-600/30 dark:border-emerald-500/45 dark:bg-emerald-500/18 dark:text-emerald-200 dark:hover:bg-emerald-500/24'
      : 'border-rose-500/55 bg-rose-600/24 text-rose-800 hover:bg-rose-600/30 dark:border-rose-500/45 dark:bg-rose-500/18 dark:text-rose-200 dark:hover:bg-rose-500/24',
    disabled && 'cursor-not-allowed opacity-60',
  );
}

export function RoomCard({ room, pricePerKwh }: RoomCardProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.role);
  const canControl = role === UserRole.ADMIN || role === UserRole.BOSS;
  const canRename = role === UserRole.ADMIN || role === UserRole.BOSS;
  const isPublicFacility = !!room.publicFacility;
  const deviceDid = room.devices[0]?.did;
  const devicePower = room.devices[0]?.power ?? false;
  const firstDevice = room.devices[0];
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(room.roomAnnotation ?? '');
  const [savingName, setSavingName] = useState(false);
  const [roomEditorOpen, setRoomEditorOpen] = useState(false);
  const [draftAnnotation, setDraftAnnotation] = useState(room.roomAnnotation ?? '');
  const [draftFloor, setDraftFloor] = useState<string>(String(Number.isFinite(room.floor) ? room.floor : 1));
  const [savingRoom, setSavingRoom] = useState(false);
  const [switchPending, setSwitchPending] = useState(false);
  const [limitDialogOpen, setLimitDialogOpen] = useState(false);
  const [limitEditTarget, setLimitEditTarget] = useState<'daily' | 'cost'>('daily');
  const [limitEnabled, setLimitEnabled] = useState(room.limitEnabled);
  const [limitValue, setLimitValue] = useState(
    room.dailyLimit != null && room.dailyLimit > 0 ? String(room.dailyLimit) : '10',
  );
  const [costLimitEnabled, setCostLimitEnabled] = useState(room.costLimitEnabled);
  const [costLimitValue, setCostLimitValue] = useState(
    room.monthlyCostLimit != null && room.monthlyCostLimit > 0 ? String(room.monthlyCostLimit) : '200',
  );
  const [savingLimit, setSavingLimit] = useState(false);
  const [limitTogglePending, setLimitTogglePending] = useState(false);
  const [costLimitTogglePending, setCostLimitTogglePending] = useState(false);
  const [cameraDetailOpen, setCameraDetailOpen] = useState(false);
  const [cameraSnapshotBump, setCameraSnapshotBump] = useState(0);
  const snapshotThumbReloadRef = useRef<number>(0);
  const [takeSnapshotLoading, setTakeSnapshotLoading] = useState(false);
  // 局域网设备控制配置（HTTP / Modbus / Tuya / MiIO）
  const [controlProtocol, setControlProtocol] = useState('');
  const [controlLocalIp, setControlLocalIp] = useState('');
  const [httpOnUrl, setHttpOnUrl] = useState('');
  const [httpOffUrl, setHttpOffUrl] = useState('');
  const [httpStateUrl, setHttpStateUrl] = useState('');
  const [modbusPort, setModbusPort] = useState('502');
  const [modbusUnitId, setModbusUnitId] = useState('1');
  const [modbusCoilAddr, setModbusCoilAddr] = useState('0');
  const [controlSaving, setControlSaving] = useState(false);
  const [controlTesting, setControlTesting] = useState(false);
  const [controlTestResult, setControlTestResult] = useState('');
  const cardVideoRef = useRef<HTMLVideoElement | null>(null);
  const cardHlsInstanceRef = useRef<any>(null);
  const [cardStream, setCardStream] = useState<{ hlsUrl?: string } | null>(null);
  const cardReconnectAttemptRef = useRef(0);
  const [cardStreamEpoch, setCardStreamEpoch] = useState(0);
  const [networkDetailOpen, setNetworkDetailOpen] = useState(false);
  const [deviceDetailOpen, setDeviceDetailOpen] = useState(false);
  const [deviceCategoryDraft, setDeviceCategoryDraft] = useState<string>('');
  const [deviceCategorySaving, setDeviceCategorySaving] = useState(false);
  const [deviceNameDraft, setDeviceNameDraft] = useState('');
  const [deviceNameSaving, setDeviceNameSaving] = useState(false);
  const [deviceDeleting, setDeviceDeleting] = useState(false);
  const [deviceDeleteConfirming, setDeviceDeleteConfirming] = useState(false);
  const [adapterKind, setAdapterKind] = useState<'huawei_cpe' | 'nokia_beacon' | null>(null);
  const [adapterBaseUrl, setAdapterBaseUrl] = useState('');
  const [adapterUsername, setAdapterUsername] = useState('admin');
  const [adapterPassword, setAdapterPassword] = useState('');
  const [adapterSessionSid, setAdapterSessionSid] = useState('');
  const [adapterPasswordMasked, setAdapterPasswordMasked] = useState(false);
  const [adapterConfigExpanded, setAdapterConfigExpanded] = useState(false);
  const [adapterSaving, setAdapterSaving] = useState(false);
  const [adapterRefreshLoading, setAdapterRefreshLoading] = useState(false);
  const [adapterLastError, setAdapterLastError] = useState<string>('');
  const detectedAdapterKind =
    (((firstDevice as any)?.adapterKind ??
      ((firstDevice as any)?.fiveGCpe ? 'huawei_cpe' : null) ??
      ((firstDevice as any)?.wifiAp ? 'nokia_beacon' : null)) as 'huawei_cpe' | 'nokia_beacon' | null);
  const effectiveAdapterKind = adapterKind ?? detectedAdapterKind;
  const showCpeRuntime = effectiveAdapterKind === 'huawei_cpe' || !!(firstDevice as any)?.fiveGCpe;
  const networkAdminUrl = useMemo(() => {
    const fromConfig = adapterBaseUrl.trim();
    if (fromConfig) return fromConfig;
    const ip = String((firstDevice as any)?.ipAddress ?? '').trim();
    if (ip) return /^https?:\/\//i.test(ip) ? ip : `http://${ip}`;
    return '';
  }, [adapterBaseUrl, firstDevice]);
  const openNetworkAdmin = (event?: MouseEvent) => {
    event?.stopPropagation?.();
    if (!networkAdminUrl) {
      toast.warning('还没有可打开的管理地址');
      return;
    }
    window.open(networkAdminUrl, '_blank', 'noopener,noreferrer');
  };

  const openNetworkDevicePage = (panel: 'clients' | 'nodes' = 'clients', event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.();
    if (!deviceDid) {
      toast.warning('设备信息不存在');
      return;
    }
    navigate(`/network-devices/${encodeURIComponent(deviceDid)}?panel=${panel}`);
  };

  useEffect(() => {
    if (!networkDetailOpen && !adapterConfigExpanded) return;
    if (!deviceDid) return;
    (async () => {
      try {
        setAdapterLastError('');
        const cfg = await system.getDeviceAdapterConfig(deviceDid);
        setAdapterKind(cfg.kind);
        setAdapterBaseUrl(cfg.baseUrl ?? '');
        setAdapterUsername(cfg.username ?? 'admin');
        setAdapterSessionSid(cfg.sessionSid ?? '');
        if (cfg.hasPersistedPassword) {
          setAdapterPassword('••••••••');
          setAdapterPasswordMasked(true);
        } else {
          setAdapterPassword('');
          setAdapterPasswordMasked(false);
        }
      } catch (e: any) {
        setAdapterLastError(e?.message || '读取配置失败');
      }
    })();
  }, [networkDetailOpen, adapterConfigExpanded, deviceDid]);

  const handleSaveAdapterConfig = async () => {
    if (!deviceDid) {
      toast.error('设备 DID 不存在');
      return;
    }
    try {
      setAdapterSaving(true);
      setAdapterLastError('');
      const finalPassword = adapterPasswordMasked ? null : (adapterPassword || null);
      await system.saveDeviceAdapterConfig(deviceDid, {
        kind: adapterKind,
        baseUrl: adapterBaseUrl.trim() || null,
        username: adapterUsername.trim() || null,
        password: finalPassword,
        sessionSid: adapterSessionSid.trim() || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (!adapterPasswordMasked && finalPassword && finalPassword.trim().length > 0) {
        setAdapterPassword('••••••••');
        setAdapterPasswordMasked(true);
      }
      toast.success('本地适配器配置已保存');
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || '保存失败';
      setAdapterLastError(msg);
      toast.error(msg);
    } finally {
      setAdapterSaving(false);
    }
  };

  const handleRefreshRuntime = async () => {
    if (!deviceDid) {
      toast.error('设备 DID 不存在');
      return;
    }
    try {
      setAdapterRefreshLoading(true);
      setAdapterLastError('');
      const r = await system.refreshDeviceRuntime(deviceDid);
      if (!r.ok) {
        const msg = r.errorMessage || '刷新失败';
        setAdapterLastError(msg);
        toast.error(msg);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('已刷新本地设备运行时');
    } catch (e: any) {
      const raw = e?.response?.data ?? {};
      const msg = raw?.errorMessage || raw?.message || e?.message || '刷新运行时失败';
      setAdapterLastError(msg);
      toast.error(msg);
    } finally {
      setAdapterRefreshLoading(false);
    }
  };



  const statusColor = ROOM_STATUS_COLORS[room.status];
  const statusText = ROOM_STATUS_TEXT[room.status];
  const percent =
    room.dailyLimit && room.dailyLimit > 0
      ? Math.min(100, (room.todayUsage / room.dailyLimit) * 100)
      : 0;
  const todayCost = room.todayUsage * pricePerKwh;
  const monthCost = room.monthCost ?? 0;
  const monthlyCostLimit = room.monthlyCostLimit ?? 0;
  const costPercent =
    monthlyCostLimit > 0
      ? Math.min(100, (monthCost / monthlyCostLimit) * 100)
      : 0;
  const cooldownActive = room.powerActionRetryAfterSeconds > 0;
  const cooldownLabel =
    room.powerActionLastType === 'cutoff_power'
      ? `断电后冷却中，还需 ${room.powerActionRetryAfterSeconds} 秒`
      : room.powerActionLastType === 'restore_power'
        ? `恢复后冷却中，还需 ${room.powerActionRetryAfterSeconds} 秒`
        : `冷却中，还需 ${room.powerActionRetryAfterSeconds} 秒`;

  const devices: DeviceItem[] = (room.devices ?? []) as DeviceItem[];
  const categoryCounts = countDeviceCategories(devices);
  const primaryCategory = pickPrimaryCategory(devices);
  const primaryCategoryLabel = DEVICE_CATEGORY_LABEL[primaryCategory] ?? '其他智能设备';
  const multiCategory = Object.values(categoryCounts).filter((n) => n > 0).length >= 2;

  // 录像回放页快捷入口：通过 ?camera=<did> 深链直接打开摄像头详情
  const deepLinkCameraDid = searchParams.get('camera');
  useEffect(() => {
    if (
      deepLinkCameraDid &&
      primaryCategory === DeviceCategory.CAMERA &&
      deviceDid === deepLinkCameraDid
    ) {
      setCameraDetailOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('camera');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkCameraDid, primaryCategory, deviceDid]);

  const cardToneClassName = getRoomStatusCardToneClass(room.status);

  const openDeviceDetail = async () => {
    if (!deviceDid) {
      toast.warning('设备信息不存在');
      return;
    }
    setDeviceCategoryDraft(String((firstDevice as any)?.category ?? primaryCategory ?? 'other'));
    setDeviceNameDraft(String(room.title ?? (firstDevice as any)?.name ?? ''));
    setDeviceDeleteConfirming(false);
    // 加载局域网控制配置
    setControlProtocol('');
    setControlLocalIp('');
    setHttpOnUrl('');
    setHttpOffUrl('');
    setHttpStateUrl('');
    setModbusPort('502');
    setModbusUnitId('1');
    setModbusCoilAddr('0');
    setControlTestResult('');
    try {
      const cfg = await system.getDeviceControlConfig(deviceDid);
      if (cfg.controlProtocol) setControlProtocol(cfg.controlProtocol);
      if (cfg.localip) setControlLocalIp(cfg.localip);
      const c = (cfg.controlConfig ?? {}) as any;
      setHttpOnUrl(c.onUrl ?? '');
      setHttpOffUrl(c.offUrl ?? '');
      setHttpStateUrl(c.stateUrl ?? '');
      if (c.modbusPort != null) setModbusPort(String(c.modbusPort));
      if (c.modbusUnitId != null) setModbusUnitId(String(c.modbusUnitId));
      if (c.coilAddress != null) setModbusCoilAddr(String(c.coilAddress));
    } catch {
      // 未配置或非局域网设备，保持默认空值
    }
    setDeviceDetailOpen(true);
  };

  const buildControlConfig = () => {
    const base: Record<string, unknown> = {};
    if (controlProtocol === 'http') {
      base.onUrl = httpOnUrl.trim();
      base.offUrl = httpOffUrl.trim();
      base.stateUrl = httpStateUrl.trim();
    } else if (controlProtocol === 'modbus_tcp') {
      base.modbusPort = Number(modbusPort) || 502;
      base.modbusUnitId = Number(modbusUnitId) || 1;
      base.coilAddress = Number(modbusCoilAddr) || 0;
    }
    return base;
  };

  const handleSaveControlConfig = async () => {
    if (!deviceDid) return;
    try {
      setControlSaving(true);
      await system.updateDeviceControlConfig(deviceDid, {
        localip: controlLocalIp.trim(),
        controlProtocol: controlProtocol || null,
        controlConfig: controlProtocol ? buildControlConfig() : null,
      });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('局域网控制配置已保存');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || '保存失败');
    } finally {
      setControlSaving(false);
    }
  };

  const handleTestControl = async (action?: 'on' | 'off') => {
    if (!deviceDid) return;
    try {
      setControlTesting(true);
      setControlTestResult('');
      const res = await system.testDeviceControlConfig(deviceDid, {
        localip: controlLocalIp.trim(),
        controlProtocol: controlProtocol || undefined,
        controlConfig: controlProtocol ? buildControlConfig() : undefined,
        action,
      });
      if (action) {
        setControlTestResult(res.ok ? `测试成功（${action === 'on' ? '开' : '关'}）` : '测试失败');
      } else {
        setControlTestResult(
          res.state?.reachable
            ? `状态读取成功：${res.state.on === true ? '开' : res.state.on === false ? '关' : '未知'}${res.state.powerW != null ? `，功率 ${res.state.powerW}W` : ''}`
            : `状态读取失败：${res.state?.error || '设备不可达'}`,
        );
      }
    } catch (e: any) {
      setControlTestResult(e?.response?.data?.message || e?.message || '测试失败');
    } finally {
      setControlTesting(false);
    }
  };

  const handleSaveDeviceCategory = async () => {
    if (!deviceDid || !canControl) return;
    if (!Object.values(DeviceCategory).includes(deviceCategoryDraft as DeviceCategory)) {
      toast.error('无效的设备分类');
      return;
    }
    try {
      setDeviceCategorySaving(true);
      await system.updateDeviceCategory(deviceDid, deviceCategoryDraft);
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setDeviceDetailOpen(false);
      toast.success('设备分类已更新');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '更新设备分类失败');
    } finally {
      setDeviceCategorySaving(false);
    }
  };

  const handleSaveDeviceName = async () => {
    if (!deviceDid || !canRename) return;
    const trimmed = (deviceNameDraft ?? '').trim();
    if (!trimmed) {
      toast.error('设备名称不能为空');
      return;
    }
    try {
      setDeviceNameSaving(true);
      await system.renameDevice(deviceDid, trimmed);
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('设备名称已更新');
    } catch {
      toast.error('修改设备名称失败');
    } finally {
      setDeviceNameSaving(false);
    }
  };

  const handleDeleteDevice = async () => {
    if (!deviceDid || !canControl) return;
    if (!deviceDeleteConfirming) {
      setDeviceDeleteConfirming(true);
      return;
    }
    try {
      setDeviceDeleting(true);
      await system.deleteDevice(deviceDid);
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setDeviceDetailOpen(false);
      setDeviceDeleteConfirming(false);
      toast.success('设备已删除');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '删除设备失败');
    } finally {
      setDeviceDeleting(false);
    }
  };

  const handleOpenDetail = () => {
    if (editingName) return;
    if (primaryCategory === DeviceCategory.CAMERA) {
      setCameraDetailOpen(true);
      return;
    }
    if (primaryCategory === DeviceCategory.WIFI_AP || primaryCategory === DeviceCategory.FIVE_G_CPE) {
      setNetworkDetailOpen(true);
      return;
    }
    if (room.roomId) {
      navigate(`/rooms/${room.roomId}`);
      return;
    }
    openDeviceDetail();
  };

  const cameraSnapshotThumbUrl = useMemo(() => {
    if (primaryCategory !== DeviceCategory.CAMERA || !deviceDid) return '';
    return system.getDeviceSnapshotUrl(deviceDid, { fresh: false });
  }, [primaryCategory, deviceDid, cameraSnapshotBump]);

  useEffect(() => {
    if (primaryCategory !== DeviceCategory.CAMERA) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!mounted) return;
      setCameraSnapshotBump((prev) => prev + 1);
      timer = setTimeout(tick, 10_000);
    };
    timer = setTimeout(tick, 10_000);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [primaryCategory, deviceDid]);

  // 卡片主画面：自动拉取 HLS 真实视频流（米家摄像头走云端 m3u8，绕开 logo 快照问题）
  useEffect(() => {
    if (primaryCategory !== DeviceCategory.CAMERA || !deviceDid) {
      setCardStream(null);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const tryFetch = async () => {
      try {
        // 复用服务端现有代理/缓存会话：绝不强制换新云端会话，
        // 避免高频 startHLSStream 触发小米云端限流（会返回全部无效 URL）。
        const res = await system.getCameraStream(deviceDid);
        if (cancelled) return;
        // 只有后端确认实时流就绪（hlsReady=true）才播流，否则保持快照兜底
        if (res.hlsUrl && res.hlsReady === true) {
          setCardStream({ hlsUrl: res.hlsUrl });
          return;
        }
        // 拉流未就绪（代理冷却/重建中）：周期重试，等待后端云端会话自愈后再播流
        setCardStream(null);
        retryTimer = setTimeout(tryFetch, 10_000);
      } catch {
        // 拉流失败时保持快照兜底，不打断渲染；稍后自动重试
        if (!cancelled) {
          setCardStream(null);
          retryTimer = setTimeout(tryFetch, 10_000);
        }
      }
    };
    tryFetch();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [primaryCategory, deviceDid, cardStreamEpoch]);

  useEffect(() => {
    const url = cardStream?.hlsUrl;
    const videoEl = cardVideoRef.current;
    if (!url || !videoEl) return;
    let destroyed = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerCardReconnect = () => {
      if (stallTimer) return;
      if (cardReconnectAttemptRef.current >= 3) return;
      cardReconnectAttemptRef.current += 1;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        setCardStreamEpoch((e) => e + 1);
      }, 2500);
    };
    const onVideoError = () => triggerCardReconnect();
    // 短时网络抖动交给 hls.js 重试，仅当持续 8s 无数据才重连
    let stallSince = 0;
    const onStalled = () => {
      if (videoEl.readyState >= 2) return;
      const now = Date.now();
      if (!stallSince) stallSince = now;
      else if (now - stallSince > 8000) {
        stallSince = 0;
        triggerCardReconnect();
      }
    };
    const onPlaying = () => {
      stallSince = 0;
    };
    videoEl.addEventListener('error', onVideoError);
    videoEl.addEventListener('stalled', onStalled);
    videoEl.addEventListener('playing', onPlaying);
    const run = async () => {
      const canNative =
        typeof videoEl.canPlayType === 'function' &&
        videoEl.canPlayType('application/vnd.apple.mpegurl');
      if (canNative) {
        videoEl.src = url;
        try { await videoEl.play(); } catch {}
        return;
      }
      try {
        const Hls = (await import('hls.js')).default;
        if (!Hls || !Hls.isSupported()) return;
        const hls = new Hls({
          lowLatencyMode: true,
          enableWorker: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 4,
          maxBufferLength: 8,
          maxMaxBufferLength: 12,
          backBufferLength: 3,
          maxLiveSyncPlaybackRate: 1.5,
          initialLiveManifestSize: 1,
          manifestLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 400,
        });
        if (destroyed) return;
        cardHlsInstanceRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        let fatalRecovers = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data || !data.fatal) return;
          if (fatalRecovers < 2) {
            fatalRecovers += 1;
            try {
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              else hls.startLoad();
            } catch {}
            return;
          }
          triggerCardReconnect();
        });
      } catch {
        // 忽略，保留快照兜底
      }
    };
    run();
    return () => {
      destroyed = true;
      if (stallTimer) clearTimeout(stallTimer);
      videoEl.removeEventListener('error', onVideoError);
      videoEl.removeEventListener('stalled', onStalled);
      videoEl.removeEventListener('playing', onPlaying);
      if (cardHlsInstanceRef.current) {
        try { cardHlsInstanceRef.current.destroy(); } catch {}
        cardHlsInstanceRef.current = null;
      }
      try {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      } catch {}
    };
  }, [cardStream?.hlsUrl]);

  const handleStartRename = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const initial = isPublicFacility ? room.title : (room.roomAnnotation ?? '');
    setDraftName(initial.replace(/未命名房间/g, '').trim());
    setEditingName(true);
    return;
  };

  const handleCancelRename = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setDraftName(isPublicFacility ? room.title : (room.roomAnnotation ?? ''));
    setEditingName(false);
  };

  const handleSaveRename = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const trimmed = (draftName ?? '').trim();
    if (!isPublicFacility && !trimmed) {
      // Empty name restores the "unnamed room"
    }
    if (trimmed.length > 8) {
      toast.error('名称最多 8 个字');
      return;
    }

    if (isPublicFacility) {
      const did = room.devices[0]?.did;
      if (!did) {
        toast.error('设备信息不存在');
        return;
      }
      try {
        setSavingName(true);
        const finalName = trimmed || '公共设备';
        await system.renameDevice(did, finalName);
        await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        await queryClient.invalidateQueries({ queryKey: ['device', did] });
        setEditingName(false);
        toast.success('设备名称已更新');
      } catch {
        toast.error('修改设备名称失败');
      } finally {
        setSavingName(false);
      }
      return;
    }

    if (!room.roomId) {
      toast.error('房间信息不存在');
      return;
    }

    try {
      setSavingName(true);
      await system.updateRoomAnnotation(room.roomId, trimmed);
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      await queryClient.invalidateQueries({ queryKey: ['room', room.roomId] });
      setEditingName(false);
      toast.success('房间名称已更新');
    } catch {
      toast.error('修改房间名称失败');
    } finally {
      setSavingName(false);
    }
  };

  const handleOpenRoomEditor = (event?: MouseEvent<HTMLButtonElement>) => {
    event?.stopPropagation?.();
    if (!room.roomId || !canRename) return;
    setDraftAnnotation(room.roomAnnotation ?? '');
    setDraftFloor(String(Number.isFinite(room.floor) ? room.floor : 1));
    setRoomEditorOpen(true);
  };

  const handleSaveRoomEditor = async () => {
    if (!room.roomId) {
      toast.error('房间信息不存在');
      return;
    }
    const floorNum = Number(draftFloor);
    if (!Number.isFinite(floorNum) || floorNum < -10 || floorNum > 50) {
      toast.error('楼层范围应为 UG 10 ~ 50. OG（-10 ~ 50）');
      return;
    }
    try {
      setSavingRoom(true);
      await Promise.all([
        system.updateRoomAnnotation(room.roomId, draftAnnotation),
        system.updateRoomFloor(room.roomId, floorNum),
      ]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['room', room.roomId] }),
      ]);
      setRoomEditorOpen(false);
      setEditingName(false);
      toast.success('房间设置已更新');
    } catch {
      toast.error('保存房间设置失败');
    } finally {
      setSavingRoom(false);
    }
  };

  const handleDeviceSwitch = async (checked: boolean) => {
    if (!deviceDid || !canControl) return;

    try {
      setSwitchPending(true);
      await system.controlDevice(deviceDid, checked ? 'on' : 'off');
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(checked ? '已开启设备' : '已关闭设备');
    } catch {
      toast.error(checked ? '开启设备失败' : '关闭设备失败');
    } finally {
      setSwitchPending(false);
    }
  };

  const handleLimitDialogChange = (open: boolean) => {
    setLimitDialogOpen(open);
    if (open) {
      setLimitEnabled(room.limitEnabled);
      setLimitValue(room.dailyLimit != null && room.dailyLimit > 0 ? String(room.dailyLimit) : '10');
      setCostLimitEnabled(room.costLimitEnabled);
      setCostLimitValue(room.monthlyCostLimit != null && room.monthlyCostLimit > 0 ? String(room.monthlyCostLimit) : '200');
    }
  };

  const openLimitDialog = (target: 'daily' | 'cost', event?: MouseEvent<HTMLElement>) => {
    event?.stopPropagation();
    if (!room.roomId || !canControl) return;
    setLimitEditTarget(target);
    handleLimitDialogChange(true);
  };

  const handleSaveLimit = async () => {
    if (!room.roomId || !canControl) return;

    const nextLimit = Number(limitValue);
    if (!Number.isFinite(nextLimit) || nextLimit < 0) {
      toast.error('限额值不正确');
      return;
    }
    const nextCostLimit = Number(costLimitValue);
    if (!Number.isFinite(nextCostLimit) || nextCostLimit < 0) {
      toast.error('费用限额不正确');
      return;
    }

    try {
      setSavingLimit(true);
      await energy.updateLimit(room.roomId, nextLimit, limitEnabled, nextCostLimit, costLimitEnabled);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['room', room.roomId] }),
      ]);
      setLimitDialogOpen(false);
      toast.success('限额设置已更新');
    } catch {
      toast.error('保存限额失败');
    } finally {
      setSavingLimit(false);
    }
  };

  const handleLimitToggle = async (checked: boolean) => {
    if (!room.roomId || !canControl) return;

    const nextLimit =
      Number(limitValue) > 0
        ? Number(limitValue)
        : room.dailyLimit && room.dailyLimit > 0
          ? room.dailyLimit
          : 10;

    if (!Number.isFinite(nextLimit) || nextLimit < 0) {
      toast.error('限额值不正确');
      return;
    }

    try {
      setLimitTogglePending(true);
      await energy.updateLimit(room.roomId, nextLimit, checked);
      setLimitEnabled(checked);
      if (checked) {
        setLimitValue(String(nextLimit));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['room', room.roomId] }),
      ]);
      toast.success(checked ? '已开启限额断电' : '已关闭限额断电');
    } catch {
      toast.error(checked ? '开启限额断电失败' : '关闭限额断电失败');
    } finally {
      setLimitTogglePending(false);
    }
  };

  const handleCostLimitToggle = async (checked: boolean) => {
    if (!room.roomId || !canControl) return;

    const nextDailyLimit =
      Number(limitValue) > 0
        ? Number(limitValue)
        : room.dailyLimit && room.dailyLimit > 0
          ? room.dailyLimit
          : 10;
    const nextCostLimit =
      Number(costLimitValue) > 0
        ? Number(costLimitValue)
        : room.monthlyCostLimit && room.monthlyCostLimit > 0
          ? room.monthlyCostLimit
          : 200;

    if (!Number.isFinite(nextDailyLimit) || nextDailyLimit < 0 || !Number.isFinite(nextCostLimit) || nextCostLimit < 0) {
      toast.error('费用限额不正确');
      return;
    }

    try {
      setCostLimitTogglePending(true);
      await energy.updateLimit(room.roomId, nextDailyLimit, room.limitEnabled, nextCostLimit, checked);
      setCostLimitEnabled(checked);
      if (checked) {
        setCostLimitValue(String(nextCostLimit));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['room', room.roomId] }),
      ]);
      toast.success(checked ? '已开启费用断电' : '已关闭费用断电');
    } catch {
      toast.error(checked ? '开启费用断电失败' : '关闭费用断电失败');
    } finally {
      setCostLimitTogglePending(false);
    }
  };




  const handleTakeEvidenceSnapshot = async () => {
    if (!deviceDid) return;
    try {
      setTakeSnapshotLoading(true);
      const result = await (
        await fetch(system.getDeviceSnapshotUrl(deviceDid, { fresh: true }), {
          method: 'GET',
          credentials: 'include',
        })
      );
      if (!result.ok) {
        throw new Error(`HTTP ${result.status} ${result.statusText}`);
      }
      const blob = await result.blob();
      if (!blob || blob.size < 512) {
        throw new Error('快照内容过小，可能摄像头尚未接入成功');
      }
      const ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
      const url = URL.createObjectURL(blob);
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const safeTitle = (room.title || '摄像头').replace(/[\\/:*?"<>|]/g, '_');
      const filename = `${safeTitle}_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
      }, 500);
      toast.success(`已保存截图：${filename}`);
      setCameraSnapshotBump((prev) => prev + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '截图失败');
    } finally {
      setTakeSnapshotLoading(false);
    }
  };


  return (
    <>
    <Card
      className={cn(
        'h-full w-full min-w-0 border border-l-4 transition-all duration-200 hover:shadow-lg',
        cardToneClassName,
        room.roomId ? 'cursor-pointer' : 'cursor-default'
      )}
      style={{ borderLeftColor: statusColor }}
      onClick={handleOpenDetail}
    >
      <CardContent className="flex h-full flex-col gap-3 p-3 sm:p-4">
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {editingName ? (
                <div
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    className="h-8 max-w-[220px] flex-none"
                    placeholder={isPublicFacility ? '设备名称（最多8字）' : '房间名称（最多8字）'}
                    disabled={savingName}
                    maxLength={8}
                  />
                  <Button
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={handleSaveRename}
                    disabled={savingName}
                  >
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={handleCancelRename}
                    disabled={savingName}
                  >
                    取消
                  </Button>
                  {!isPublicFacility ? (
                    <span className="ml-1 truncate text-[11px] text-muted-foreground sm:text-xs">
                      {floorToDualLabel(room.floor)}
                    </span>
                  ) : null}
                </div>
              ) : (
                <>
                  <h3 className="min-w-0 break-words text-[clamp(1.125rem,1.9vw,1.375rem)] font-extrabold tracking-tight">
                    {room.title}
                  </h3>
                  {canRename && (isPublicFacility ? true : !!room.roomId) ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={handleStartRename}
                      title={isPublicFacility ? '修改设备名称' : '修改房间名称'}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  ) : null}
                  {!isPublicFacility ? (
                    <span className="truncate text-[11px] text-muted-foreground sm:text-xs">
                      {floorToDualLabel(room.floor)}
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {isPublicFacility ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 border border-amber-300/40 dark:border-amber-700/40">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500/80" />
                  公共设施
                </span>
              ) : null}
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0"
                style={{
                  backgroundColor: `${statusColor}15`,
                  color: statusColor,
                  borderColor: `${statusColor}40`,
                }}
              >
                {statusText}
              </Badge>
            </div>
          </div>
          <div className="min-w-0 whitespace-nowrap text-[11px] text-muted-foreground sm:text-xs">
            <span className="block w-full truncate" title={room.idHint || ''}>{room.idHint || '\u00A0'}</span>
          </div>
        </div>

        <div className={`text-[clamp(0.68rem,1vw,0.78rem)] ${
          primaryCategory === DeviceCategory.CAMERA
            ? 'flex flex-col gap-2'
            : 'grid grid-cols-2 gap-2'
        }`}>
          {primaryCategory === DeviceCategory.CIRCUIT_BREAKER ? (
            <>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="text-muted-foreground">实时功率</div>
                <div className="mt-1 break-words text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                  {room.cutoff ? '已断电' : formatPower(room.power)}
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="text-muted-foreground">累计电量</div>
                <div className="mt-1 break-words text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                  {formatEnergy(room.cumulativeUsage)}
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="text-muted-foreground">当日用电</div>
                <div className="mt-1 break-words text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                  {formatEnergy(room.todayUsage)}
                </div>
              </div>
              <FeeHint pricePerKwh={pricePerKwh} stopPropagationOnMobile>
                <div className="cursor-help rounded-md bg-muted/40 p-2">
                  <div className="text-muted-foreground">费用参考</div>
                  <div className="mt-1 break-words text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                    {formatCost(todayCost)}
                  </div>
                </div>
              </FeeHint>
            </>
          ) : primaryCategory === DeviceCategory.CAMERA ? (
            <div className="w-full space-y-2">
              <div
                className="relative w-full overflow-hidden rounded-md border border-indigo-200/60 bg-slate-900/95 dark:border-indigo-900/60"
                style={{ minHeight: '280px' }}
              >
                <div className="absolute inset-0">
                  {cardStream?.hlsUrl ? (
                    <video
                      ref={cardVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="h-full w-full object-contain"
                      style={{ background: '#000' }}
                    />
                  ) : cameraSnapshotThumbUrl ? (
                    <img
                      key={cameraSnapshotThumbUrl + '_' + snapshotThumbReloadRef.current}
                      src={cameraSnapshotThumbUrl}
                      alt={room.title + ' 实时快照'}
                      className="h-full w-full object-contain"
                      onError={() => {}}
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] leading-4 text-slate-400">
                      <span>暂无可渲染的画面</span>
                      <span className="text-slate-500">点右上角查看详情后再配置接入</span>
                    </div>
                  )}
                </div>
                {room.deviceOnline ? (
                  <div className="pointer-events-none absolute left-1 top-1 inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-emerald-100">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE
                  </div>
                ) : (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900/35">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45">
                      <WifiOff className="h-7 w-7 text-white/75" />
                    </span>
                    <span className="rounded bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white/80">
                      离线 / 连接断开
                    </span>
                  </div>
                )}
                <div className="pointer-events-auto absolute right-1.5 top-1.5 inline-flex gap-1">
                  <button
                    type="button"
                    className="rounded-full bg-black/55 p-1 text-white/85 hover:bg-black/70"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCameraSnapshotBump((prev) => prev + 1);
                      snapshotThumbReloadRef.current += 1;
                    }}
                    title="刷新快照"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-black/55 p-1 text-white/85 hover:bg-black/70"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCameraDetailOpen(true);
                    }}
                    title="查看画面"
                  >
                    <Maximize2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              {(() => {
                const cam = (firstDevice as any)?.camera ?? null;
                const caps = [
                  { key: 'audio', label: '录音', show: cam?.hasAudio === true, Icon: Mic },
                  { key: 'motion', label: '移动侦测', show: cam?.hasMotion === true || typeof cam?.lastMotionAt === 'string', Icon: BellRing },
                  { key: 'night', label: '夜视', show: cam?.hasNightVision === true, Icon: Moon },
                  { key: 'recording', label: '录像存储', show: cam?.hasRecording === true, Icon: HardDrive },
                ].filter((c) => c.show);
                if (caps.length === 0) return null;
                return (
                  <div className="w-full flex flex-wrap gap-1">
                    {caps.map(({ key, label, Icon }) => (
                      <div
                        key={key}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-400/50 bg-emerald-50/60 px-2 py-1 text-[10.5px] text-emerald-600 dark:border-emerald-400/50 dark:bg-emerald-950/30 dark:text-emerald-400"
                      >
                        <Icon className="h-3 w-3 shrink-0" />
                        <span className="truncate">{label}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          ) : primaryCategory === DeviceCategory.WIFI_AP && !showCpeRuntime ? (
            (() => {
              const rt = (firstDevice as any)?.wifiAp ?? (firstDevice as any)?.fiveGCpe ?? null;
              const clients = Array.isArray(rt?.clients) ? rt.clients.length : null;
              const nodes = Array.isArray(rt?.meshTopology) ? rt.meshTopology.length : null;
              const bands = (Array.isArray(rt?.bands) ? rt.bands : []) as Array<{ band?: string | null; ssid?: string | null; enabled?: boolean | null }>;
              const bands2 = bands.filter((b) => /^2\.?4/i.test(String(b?.band ?? '')));
              const bands5 = bands.filter((b) => /^5/i.test(String(b?.band ?? '')));
              const has2 = bands.length > 0 ? bands2.some((b) => b.enabled !== false) : null;
              const has5 = bands.length > 0 ? bands5.some((b) => b.enabled !== false) : null;
              const ssid = String(rt?.ssid ?? bands[0]?.ssid ?? '').trim();
              const fmtBand = () => {
                if (has2 === null && has5 === null) {
                  const bandVal = String(rt?.band ?? '').trim();
                  if (bandVal) return bandVal;
                  return '--';
                }
                const parts: string[] = [];
                if (has2) parts.push('2.4G');
                if (has5) parts.push('5G');
                if (parts.length === 0) return '--';
                return parts.join(' / ');
              };
              const fmtSsid = () => {
                const ch = Number(rt?.channel);
                const channelText = Number.isFinite(ch) && ch > 0 ? `CH${ch} · ` : '';
                if (ssid) return `${channelText}${ssid}`;
                const firstSsid = bands.find((b) => String(b?.ssid ?? '').trim())?.ssid;
                if (firstSsid) return `${channelText}${firstSsid}`;
                return '--';
              };
              const clientCount = clients ?? (Number.isFinite(Number(rt?.clientCount)) ? Number(rt.clientCount) : null);
              const backhaulState = String(rt?.meshBackhaulState ?? '').trim().toLowerCase();
              const summaryCards = [
                { label: '双频', value: fmtBand() },
                { label: '挂载设备', value: clientCount != null && clientCount > 0 ? `${clientCount} 台` : null, interactive: true },
                { label: 'Mesh 节点', value: nodes != null && nodes > 0 ? `${nodes} 个` : null, interactive: true },
                { label: '回程状态', value: backhaulState === 'up' ? '正常' : backhaulState === 'down' ? '异常' : null },
                { label: 'SSID', value: fmtSsid() },
              ].filter((item) => hasMeaningfulValue(item.value));
              return (
                <>
                  {summaryCards.length > 0 ? (
                    <div className="col-span-2 grid grid-cols-2 gap-2">
                      {summaryCards.map((item, index) => (
                        <button
                          key={item.label}
                          type="button"
                          onClick={item.label === '挂载设备'
                            ? (event) => openNetworkDevicePage('clients', event)
                            : item.label === 'Mesh 节点'
                              ? (event) => openNetworkDevicePage('nodes', event)
                              : undefined}
                          className={cn(
                            'rounded-md p-2 border text-left',
                            index === 0
                              ? 'col-span-2 bg-sky-50 border-sky-200/60 dark:bg-sky-950/20 dark:border-sky-900/60'
                              : 'bg-muted/40 border-transparent',
                            item.interactive && 'transition-colors hover:bg-muted/70 cursor-pointer',
                          )}
                        >
                          <div className={cn(
                            'flex items-center gap-1',
                            index === 0 ? 'text-sky-700 dark:text-sky-300' : 'text-muted-foreground',
                          )}>
                            {item.label === '双频' ? <SignalHigh className="h-3 w-3" /> : item.label === '挂载设备' ? <Users className="h-3 w-3" /> : <Server className="h-3 w-3" />}
                            <span>{item.label}</span>
                          </div>
                          <div className={cn(
                            'mt-1 break-all',
                            index === 0
                              ? 'text-[clamp(0.78rem,1.2vw,0.98rem)] font-semibold text-sky-800 dark:text-sky-200'
                              : 'text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold',
                          )}>
                            {String(item.value)}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              );
            })()
          ) : (primaryCategory === DeviceCategory.FIVE_G_CPE || showCpeRuntime) ? (
            (() => {
              const cpe = (firstDevice as any)?.fiveGCpe as any;
              const download = Number(cpe?.downloadMbps);
              const upload = Number(cpe?.uploadMbps);
              const peakDownload = Number(cpe?.peakDownloadMbps ?? cpe?.downloadMbps);
              const peakUpload = Number(cpe?.peakUploadMbps ?? cpe?.uploadMbps);
              const clientCount = Number(cpe?.clientCount ?? cpe?.connectedDevices);
              const fmtMbps = (v: number | null) => (v != null && Number.isFinite(v) && v > 0 ? `${v.toFixed(1)} Mbps` : '-- Mbps');
              const operatorLabel = String(cpe?.operatorShort ?? cpe?.operatorFullname ?? '').trim() || '--';
              const monthTrafficLabel = formatBytes(
                Number(cpe?.monthRxBytes ?? 0) + Number(cpe?.monthTxBytes ?? 0),
              );
              const summaryCards = [
                { label: '实时下行', value: hasMeaningfulValue(fmtMbps(download)) ? fmtMbps(download) : null, icon: Download },
                { label: '实时上行', value: hasMeaningfulValue(fmtMbps(upload)) ? fmtMbps(upload) : null, icon: Upload },
                { label: '最高下行', value: hasMeaningfulValue(fmtMbps(peakDownload)) ? fmtMbps(peakDownload) : null, icon: Download },
                { label: '最高上行', value: hasMeaningfulValue(fmtMbps(peakUpload)) ? fmtMbps(peakUpload) : null, icon: Upload },
                { label: '挂载设备', value: Number.isFinite(clientCount) && clientCount > 0 ? `${clientCount} 台` : null, icon: Users, interactive: true },
                { label: '本月流量', value: hasMeaningfulValue(monthTrafficLabel) ? monthTrafficLabel : null, icon: BarChart3 },
              ].filter((item) => hasMeaningfulValue(item.value));
              return (
                <>
                  <div className="col-span-2 rounded-md bg-amber-50 p-2 border border-amber-200/60 dark:bg-amber-950/20 dark:border-amber-900/60">
                    <div className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                      <SignalHigh className="h-3 w-3" />
                      <span className="font-medium">移动网络</span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                      {[
                        ['信号', cpe?.signalBars != null ? `${cpe.signalBars} 格` : null],
                        ['运营商', operatorLabel !== '--' ? operatorLabel : null],
                        ['网络类型', cpe?.currentRat ?? null],
                      ].filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                        <div key={String(label)} className="rounded-md bg-white/60 px-2 py-1.5 dark:bg-slate-900/25">
                          <div className="text-[10px] text-amber-700/80 dark:text-amber-300/80">{label}</div>
                          <div className="mt-0.5 font-semibold text-amber-900 dark:text-amber-100 break-all">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {summaryCards.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.label}
                        type="button"
                        onClick={item.label === '挂载设备'
                          ? (event) => openNetworkDevicePage('clients', event)
                          : undefined}
                        className={cn(
                          'rounded-md bg-muted/40 p-2 text-left',
                          item.label === '本月流量' && 'whitespace-nowrap',
                          item.label === '挂载设备' && 'transition-colors hover:bg-muted/70 cursor-pointer',
                        )}
                      >
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Icon className="h-3 w-3" />
                          <span>{item.label}</span>
                        </div>
                        <div className={cn(
                          'mt-1 break-all',
                          'text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold',
                        )}>
                          {String(item.value)}
                        </div>
                      </button>
                    );
                  })}
                </>
              );
            })()
          ) : primaryCategory === DeviceCategory.SMART_APPLIANCE ? (
            <>
              <div className="rounded-md bg-violet-50 p-2 border border-violet-200/60 dark:bg-violet-950/20 dark:border-violet-900/60">
                <div className="flex items-center justify-between gap-2 text-violet-700 dark:text-violet-300">
                  <div className="flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    <span className="font-medium">运行模式</span>
                  </div>
                  <span className="text-[10px]">控制接口待接入</span>
                </div>
                <div className="mt-1 text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold text-violet-800 dark:text-violet-200">
                  --
                </div>
              </div>
              <div className="space-y-2">
                <div className="rounded-md bg-muted/40 p-2">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Power className="h-3 w-3" />
                    <span>开关状态</span>
                  </div>
                  <div className="mt-1 text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                    未接入
                  </div>
                </div>
                <div className="rounded-md bg-muted/40 p-2">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Thermometer className="h-3 w-3" />
                    <span>温度 / 档位</span>
                  </div>
                  <div className="mt-1 text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                    --
                  </div>
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>剩余时间</span>
                </div>
                <div className="mt-1 text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                  -- 分
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Cpu className="h-3 w-3" />
                  <span>设备类型</span>
                </div>
                <div className="mt-1 text-[clamp(0.7rem,1.1vw,0.9rem)] text-muted-foreground">
                  厂商/型号接入后自动识别
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-md bg-slate-50 p-2 border border-slate-200/60 dark:bg-slate-900/40 dark:border-slate-800/60 col-span-2">
                <div className="flex items-center justify-between gap-2 text-slate-700 dark:text-slate-300">
                  <div className="flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    <span className="font-medium">设备信息</span>
                  </div>
                  <span className="text-[10px]">可在「设备管理」手动调整分类</span>
                </div>
                <div className="mt-1 text-[clamp(0.7rem,1.1vw,0.9rem)] text-slate-600 dark:text-slate-300 break-all">
                  厂商 / 型号 / MAC / IP 信息在详情页显示
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="text-muted-foreground">在线状态</div>
                <div className="mt-1 text-[clamp(0.74rem,1.2vw,0.95rem)] font-semibold">
                  {room.deviceOnline ? '在线' : '离线 / 未知'}
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <div className="text-muted-foreground">最后同步</div>
                <div className="mt-1 text-[clamp(0.7rem,1.1vw,0.9rem)] text-muted-foreground">
                  {room.devices[0]?.lastSyncAt ? new Date(room.devices[0].lastSyncAt).toLocaleString() : '尚未同步'}
                </div>
              </div>
            </>
          )}
        </div>

        {primaryCategory === DeviceCategory.CIRCUIT_BREAKER ? (
          <div>
            <div className="mb-1.5 flex flex-col gap-1 text-[clamp(0.72rem,1vw,0.78rem)] sm:flex-row sm:items-center sm:justify-between">
              <span className="text-muted-foreground">今日用电 / 日限额</span>
              <span className="break-words font-medium">
                {formatEnergy(room.todayUsage)} / {' '}
                {room.dailyLimit != null ? (
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center rounded px-1 py-0.5',
                      canControl && room.roomId
                        ? 'text-sky-700 underline-offset-2 hover:underline dark:text-sky-300'
                        : 'cursor-default'
                    )}
                    disabled={!canControl || !room.roomId}
                    onClick={(event) => openLimitDialog('daily', event)}
                    title="修改当前房间日限额"
                  >
                    {formatEnergy(room.dailyLimit)}
                  </button>
                ) : '--'}
              </span>
            </div>
            <Progress
              value={percent}
              indicatorClassName={progressColorForPercent(percent)}
              className="h-1.5"
            />
            <div className="mt-2 mb-1.5 flex flex-col gap-1 text-[clamp(0.72rem,1vw,0.78rem)] sm:flex-row sm:items-center sm:justify-between">
              <span className="text-muted-foreground">本月费用 / 费用限额</span>
              <span className="break-words font-medium">
                {formatCost(monthCost)} / {' '}
                {monthlyCostLimit > 0 ? (
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center rounded px-1 py-0.5',
                      canControl && room.roomId
                        ? 'text-sky-700 underline-offset-2 hover:underline dark:text-sky-300'
                        : 'cursor-default'
                    )}
                    disabled={!canControl || !room.roomId}
                    onClick={(event) => openLimitDialog('cost', event)}
                    title="修改当前房间费用限额"
                  >
                    {formatCost(monthlyCostLimit)}
                  </button>
                ) : '--'}
              </span>
            </div>
            <Progress
              value={costPercent}
              indicatorClassName={progressColorForPercent(costPercent)}
              className="h-1.5"
            />
          </div>
        ) : null}

        <Dialog open={limitDialogOpen} onOpenChange={handleLimitDialogChange}>
          <DialogContent onClick={(event) => event.stopPropagation()}>
            <DialogHeader>
              <DialogTitle>
                {room.title} {limitEditTarget === 'cost' ? '费用限额' : '日限额'}设置
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className={cn('space-y-2 rounded-md p-2', limitEditTarget === 'daily' && 'bg-muted/30')}>
                <div className="text-sm font-medium">每日限额（度）</div>
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  value={limitValue}
                  onChange={(event) => setLimitValue(event.target.value)}
                />
              </div>
              <div className={cn('space-y-2 rounded-md p-2', limitEditTarget === 'cost' && 'bg-muted/30')}>
                <div className="text-sm font-medium">本月费用限额（EUR）</div>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={costLimitValue}
                  onChange={(event) => setCostLimitValue(event.target.value)}
                />
              </div>
              <div className="rounded-md border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
                这里只改当前房间。通用月费用限额默认 200 EUR，需要统一修改时到系统设置里调整。
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setLimitDialogOpen(false)}
                disabled={savingLimit}
              >
                取消
              </Button>
              <Button onClick={handleSaveLimit} disabled={savingLimit}>
                {savingLimit ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex flex-wrap items-center gap-2">
          {multiCategory ? (
            Object.entries(categoryCounts)
              .filter(([, n]) => n > 0)
              .map(([c, n]) => {
                const cat = c as DeviceCategory;
                return (
                  <Badge
                    key={c}
                    variant="outline"
                    className={cn('text-[10px] border', getCategoryToneClass(cat))}
                  >
                    <span className="mr-1 inline-flex items-center">
                      {(() => { const I = getCategoryIcon(cat); return <I className="h-3.5 w-3.5" />; })()}
                    </span>
                    {DEVICE_CATEGORY_LABEL[cat] ?? cat} {n}
                  </Badge>
                );
              })
          ) : primaryCategory !== DeviceCategory.CAMERA ? (
            <Badge
              variant="outline"
              className={cn('text-[10px] border', getCategoryToneClass(primaryCategory))}
            >
              <span className="mr-1 inline-flex items-center">
                {(() => { const I = getCategoryIcon(primaryCategory); return <I className="h-3.5 w-3.5" />; })()}
              </span>
              {primaryCategoryLabel} {Object.values(categoryCounts).reduce((a, b) => a + b, 0) || '无'}
            </Badge>
          ) : null}
          {cooldownActive ? (
            <Badge variant="outline" className="text-[10px]">
              {cooldownLabel}
            </Badge>
          ) : null}
        </div>

        <div className={cn(
          'flex flex-col gap-3',
          'mt-auto',
          (showCpeRuntime || primaryCategory === DeviceCategory.WIFI_AP) && 'border-t border-slate-200/70 pt-2 dark:border-slate-700/50',
        )}>
          {primaryCategory !== DeviceCategory.CAMERA ? (
            <div className="min-w-0">
              {primaryCategory === DeviceCategory.CIRCUIT_BREAKER ? (
                <div className="grid min-w-0 grid-cols-3 gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={getToggleButtonClass(devicePower, !deviceDid || !canControl || switchPending || !room.deviceOnline)}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDeviceSwitch(!devicePower)
                    }}
                    disabled={
                      !deviceDid ||
                      !canControl ||
                      switchPending ||
                      !room.deviceOnline
                    }
                    title={devicePower ? '关闭电源' : '开启电源'}
                    aria-label={devicePower ? '关闭电源' : '开启电源'}
                  >
                    <Power className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={getToggleButtonClass(room.limitEnabled, !room.roomId || !canControl || savingLimit || limitTogglePending)}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleLimitToggle(!room.limitEnabled)
                    }}
                    disabled={!room.roomId || !canControl || savingLimit || limitTogglePending}
                  >
                    限额
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={getToggleButtonClass(room.costLimitEnabled, !room.roomId || !canControl || savingLimit || costLimitTogglePending)}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleCostLimitToggle(!room.costLimitEnabled)
                    }}
                    disabled={!room.roomId || !canControl || savingLimit || costLimitTogglePending}
                  >
                    计费
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {primaryCategory === DeviceCategory.CAMERA ? (
              <>
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)] bg-indigo-600 hover:bg-indigo-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCameraDetailOpen(true);
                  }}
                >
                  查看详情
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 min-w-0 flex-1 basis-[100px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleTakeEvidenceSnapshot();
                  }}
                  disabled={takeSnapshotLoading || !deviceDid}
                >
                  {takeSnapshotLoading ? (
                    <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Image className="mr-1 h-3.5 w-3.5" />
                  )}
                  临时截图
                </Button>
              </>
            ) : room.roomId ? (
              <Button
                size="sm"
                variant="outline"
                className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                onClick={(event) => {
                  event.stopPropagation();
                  handleOpenDetail();
                }}
              >
                查看详情
              </Button>
            ) : null}
            {primaryCategory === DeviceCategory.CIRCUIT_BREAKER && room.roomId && canControl ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleOpenRoomEditor(event as any);
                  }}
                  disabled={!canRename}
                >
                  <Settings className="mr-1 h-3.5 w-3.5" /> 房间设置
                </Button>
              </>
            ) : showCpeRuntime ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    setNetworkDetailOpen(true);
                  }}
                >
                  <SignalHigh className="mr-1 h-3.5 w-3.5" /> 状态详情
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => {
                    openNetworkAdmin(event as unknown as MouseEvent);
                  }}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> 打开后台
                </Button>
              </>
            ) : primaryCategory === DeviceCategory.WIFI_AP ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    setNetworkDetailOpen(true);
                  }}
                >
                  <WifiIcon className="mr-1 h-3.5 w-3.5" /> 状态详情
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => {
                    openNetworkAdmin(event as unknown as MouseEvent);
                  }}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> 打开后台
                </Button>
              </>
            ) : primaryCategory === DeviceCategory.SMART_APPLIANCE ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => event.stopPropagation()}
                  disabled
                >
                  <Cpu className="mr-1 h-3.5 w-3.5" /> 运行详情
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                  onClick={(event) => event.stopPropagation()}
                  disabled
                >
                  <Settings className="mr-1 h-3.5 w-3.5" /> 设备设置
                </Button>
              </>
            ) : (primaryCategory === DeviceCategory.OTHER || (!room.roomId && !isPublicFacility)) ? (
              <Button
                size="sm"
                variant="outline"
                className="h-9 min-w-0 flex-1 basis-[120px] text-[clamp(0.72rem,0.95vw,0.78rem)]"
                onClick={(event) => {
                  event.stopPropagation();
                  openDeviceDetail();
                }}
              >
                <Settings className="mr-1 h-3.5 w-3.5" /> 查看 / 分类
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>

    <Dialog open={deviceDetailOpen} onOpenChange={setDeviceDetailOpen}>
      <DialogContent onClick={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{room.title || '设备详情'}</DialogTitle>
          <DialogDescription>未分类设备：可查看信息、手动归类或重命名。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-muted/40 p-3 text-xs leading-5">
            {(() => {
              const any = firstDevice as any;
              const rows: Array<[string, string]> = [
                ['DID', String(deviceDid ?? '--')],
                ['名称', String(any?.name ?? room.title ?? '--')],
                ['类型', inferEndpointTypeLabel({
                  name: any?.name ?? null,
                  hostname: any?.hostname ?? any?.hostName ?? null,
                  vendor: any?.vendorName ?? any?.vendor ?? any?.manufacturer ?? null,
                  systemCategory: any?.category ?? null,
                })],
                ['型号', String(any?.model ?? any?.modelName ?? '--')],
                ['厂商', String(any?.vendorName ?? any?.vendor ?? any?.manufacturer ?? '--')],
                ['MAC', String(any?.mac ?? any?.macAddress ?? '--')],
                ['IP', String(any?.ipAddress ?? any?.ip ?? '--')],
                ['状态', any?.status === 'online' ? '在线' : any?.status === 'offline' ? '离线' : '未知'],
              ];
              return rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3 border-b border-slate-200/60 py-1 last:border-0 dark:border-slate-700/50">
                  <span className="shrink-0 text-muted-foreground">{label}</span>
                  <span className="min-w-0 break-all text-right font-medium">{value}</span>
                </div>
              ));
            })()}
          </div>
          <div className="space-y-2 rounded-md border border-indigo-200/60 bg-indigo-50/40 p-3 dark:border-indigo-800/40 dark:bg-indigo-950/20">
            <Label className="flex items-center gap-1.5 text-[12px] font-semibold text-indigo-700 dark:text-indigo-300">
              <Power className="h-3.5 w-3.5" /> 局域网控制（无需厂商云）
            </Label>
            <div className="space-y-2">
              <div>
                <Label className="text-[10.5px]">控制协议</Label>
                <Select value={controlProtocol} onValueChange={setControlProtocol} disabled={!canControl}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder="未启用（走厂商云）" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">未启用</SelectItem>
                    <SelectItem value="http">HTTP / JSON 开关</SelectItem>
                    <SelectItem value="modbus_tcp">Modbus TCP 断路器</SelectItem>
                    <SelectItem value="tuya_local">涂鸦本地（开发中）</SelectItem>
                    <SelectItem value="miio_lan">MiIO LAN（开发中）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10.5px]">设备 IP</Label>
                <Input
                  value={controlLocalIp}
                  onChange={(e) => setControlLocalIp(e.target.value)}
                  placeholder="如 192.168.1.50"
                  className="h-8 text-xs"
                  disabled={!canControl}
                />
              </div>
              {controlProtocol === 'http' && (
                <div className="space-y-1.5">
                  <Input
                    value={httpOnUrl}
                    onChange={(e) => setHttpOnUrl(e.target.value)}
                    placeholder="开命令 URL（如 http://ip/relay?state=1）"
                    className="h-8 text-xs"
                    disabled={!canControl}
                  />
                  <Input
                    value={httpOffUrl}
                    onChange={(e) => setHttpOffUrl(e.target.value)}
                    placeholder="关命令 URL"
                    className="h-8 text-xs"
                    disabled={!canControl}
                  />
                  <Input
                    value={httpStateUrl}
                    onChange={(e) => setHttpStateUrl(e.target.value)}
                    placeholder="状态 URL（返回 JSON，可选）"
                    className="h-8 text-xs"
                    disabled={!canControl}
                  />
                </div>
              )}
              {controlProtocol === 'modbus_tcp' && (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-[10.5px]">端口</Label>
                    <Input value={modbusPort} onChange={(e) => setModbusPort(e.target.value)} className="h-8 text-xs" disabled={!canControl} />
                  </div>
                  <div>
                    <Label className="text-[10.5px]">单元ID</Label>
                    <Input value={modbusUnitId} onChange={(e) => setModbusUnitId(e.target.value)} className="h-8 text-xs" disabled={!canControl} />
                  </div>
                  <div>
                    <Label className="text-[10.5px]">线圈地址</Label>
                    <Input value={modbusCoilAddr} onChange={(e) => setModbusCoilAddr(e.target.value)} className="h-8 text-xs" disabled={!canControl} />
                  </div>
                </div>
              )}
              {controlTestResult && (
                <div className="max-w-full break-all rounded bg-slate-100 px-2 py-1 text-[10.5px] text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
                  {controlTestResult}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => handleTestControl('on')} disabled={controlTesting || !controlProtocol || !canControl}>
                  测试开
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => handleTestControl('off')} disabled={controlTesting || !controlProtocol || !canControl}>
                  测试关
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => handleTestControl()} disabled={controlTesting || !controlProtocol || !canControl}>
                  测试状态
                </Button>
                <Button size="sm" className="ml-auto h-7 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700" onClick={handleSaveControlConfig} disabled={controlSaving || !canControl}>
                  {controlSaving ? '保存中...' : '保存配置'}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label>设备分类</Label>
            <Select value={deviceCategoryDraft} onValueChange={setDeviceCategoryDraft} disabled={!canControl}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent>
                {(Object.values(DeviceCategory) as DeviceCategory[]).map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {DEVICE_CATEGORY_LABEL[cat] ?? cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>设备名称</Label>
            <Input
              value={deviceNameDraft}
              onChange={(event) => setDeviceNameDraft(event.target.value)}
              placeholder="输入设备名称"
              disabled={!canRename}
              maxLength={32}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={handleDeleteDevice}
            disabled={!canControl || deviceDeleting}
            className="mr-auto"
          >
            {deviceDeleting ? '删除中...' : deviceDeleteConfirming ? '确认删除？' : '删除设备'}
          </Button>
          <Button variant="outline" onClick={() => setDeviceDetailOpen(false)} disabled={deviceCategorySaving || deviceNameSaving}>
            取消
          </Button>
          <Button variant="outline" onClick={handleSaveDeviceName} disabled={!canRename || deviceNameSaving}>
            {deviceNameSaving ? '保存中...' : '重命名'}
          </Button>
          <Button onClick={handleSaveDeviceCategory} disabled={!canControl || deviceCategorySaving}>
            {deviceCategorySaving ? '保存中...' : '保存分类'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>


    <RoomDetailDialog
      room={room}
      firstDevice={firstDevice}
      deviceDid={deviceDid}
      canControl={canControl}
      open={cameraDetailOpen}
      onOpenChange={setCameraDetailOpen}
      onSnapshotBump={() => {
        setCameraSnapshotBump((prev) => prev + 1);
        snapshotThumbReloadRef.current += 1;
      }}
      onTakeSnapshot={() => void handleTakeEvidenceSnapshot()}
      takeSnapshotLoading={takeSnapshotLoading}
    />

    <Dialog
      open={networkDetailOpen}
      onOpenChange={(next) => {
        setNetworkDetailOpen(next);
      }}
    >
      <DialogContent
        onClick={(event) => event.stopPropagation()}
        className="sm:max-w-4xl max-h-[92vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="inline-flex flex-wrap items-center gap-2 text-[clamp(0.9rem,1.2vw,1rem)]">
            {showCpeRuntime ? (
              <>
                <SignalHigh className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                {room.title}
              </>
            ) : (
              <>
                <WifiIcon className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                {room.title}
              </>
            )}
            <div className="ml-auto inline-flex flex-wrap items-center gap-1">
              {firstDevice?.vendorName ? (
                <Badge variant="outline" className="text-[10px]">厂商 {firstDevice.vendorName}</Badge>
              ) : null}
              {firstDevice?.ipAddress ? (
                <Badge variant="outline" className="text-[10px]">IP {firstDevice.ipAddress}</Badge>
              ) : null}
              {firstDevice?.macAddress ? (
                <Badge variant="outline" className="text-[10px]">MAC {firstDevice.macAddress}</Badge>
              ) : null}
              {showCpeRuntime ? (
                <Badge variant="outline" className="text-[10px] border-amber-400/50 text-amber-700 dark:text-amber-300">
                  {(firstDevice as any)?.fiveGCpe?.model ?? 'Huawei 主路由'}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] border-sky-400/50 text-sky-700 dark:text-sky-300">Nokia Mesh 主网关</Badge>
              )}
            </div>
          </DialogTitle>
          <DialogDescription className="hidden"></DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <div className="inline-flex flex-wrap items-center justify-between gap-2 w-full">
            <div className="inline-flex rounded-md border bg-muted/30 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              运行时概览
            </div>
            <div className="inline-flex items-center gap-2">
              {adapterLastError ? (
                <Badge variant="outline" className="text-[10px] border-rose-400/50 text-rose-700 dark:text-rose-300 break-all max-w-[60%]">
                  {adapterLastError}
                </Badge>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[11px]"
                onClick={(event) => openNetworkAdmin(event as unknown as MouseEvent)}
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                打开后台
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[11px]"
                onClick={handleRefreshRuntime}
                disabled={adapterRefreshLoading || !deviceDid}
              >
                <RefreshCw className={cn('mr-1 h-3 w-3', adapterRefreshLoading && 'animate-spin')} />
                {adapterRefreshLoading ? '刷新中...' : '立即刷新运行时'}
              </Button>
            </div>
          </div>

          <div className="space-y-2.5">
              {showCpeRuntime ? (
                (() => {
                  const cpe = (firstDevice as any)?.fiveGCpe as any;
                  const mainCell = Array.isArray(cpe?.servingCells) ? cpe.servingCells[0] : null;
                  const bands = (Array.isArray(cpe?.bands) ? cpe.bands : []) as any[];
                  const peakDownload = Number(cpe?.peakDownloadMbps ?? cpe?.downloadMbps);
                  const peakUpload = Number(cpe?.peakUploadMbps ?? cpe?.uploadMbps);
                  const totalClients =
                    Array.isArray(cpe?.clients) && cpe.clients.length > 0
                      ? (cpe.clients as any[]).length
                      : (Number.isFinite(Number(cpe?.connectedDevices)) ? Number(cpe?.connectedDevices) : null);
                  const fmtMbps = (value: unknown) => {
                    const n = Number(value);
                    return Number.isFinite(n) && n > 0 ? `${n.toFixed(2)} Mbps` : '--';
                  };
                  const networkRows = [
                    ['状态', cpe?.online ? '在线' : '离线'],
                    ['接入制式', cpe?.currentRat ?? null],
                    ['运营商', cpe?.operatorFullname ?? cpe?.operatorShort ?? null],
                    ['型号', cpe?.model ?? null],
                    ['频段', mainCell?.band ? `${mainCell.band}${mainCell?.bandwidthMHz ? ` (${mainCell.bandwidthMHz}MHz)` : ''}` : null],
                    ['物理小区', mainCell?.physicalCellId ?? mainCell?.cellId ?? null],
                    ['信号格', cpe?.signalBars != null ? `${cpe.signalBars} / 5` : null],
                    ['漫游', typeof cpe?.roaming === 'boolean' ? (cpe.roaming ? '是' : '否') : null],
                    ['RSRP', mainCell?.rsrpDbm != null ? `${mainCell.rsrpDbm} dBm` : null],
                    ['SINR', mainCell?.sinrDb != null ? `${mainCell.sinrDb} dB` : null],
                    ['RSRQ', mainCell?.rsrqDb != null ? `${mainCell.rsrqDb} dB` : null],
                    ['RSSI', mainCell?.rssiDbm != null ? `${mainCell.rssiDbm} dBm` : null],
                    ['公网 IP', cpe?.publicIpv4 ?? cpe?.publicIpv6 ?? null],
                    ['管理地址', networkAdminUrl || null],
                  ].filter(([, value]) => hasMeaningfulValue(value));
                  const trafficRows = [
                    ['实时下行', hasMeaningfulValue(fmtMbps(cpe?.downloadMbps)) ? fmtMbps(cpe?.downloadMbps) : null, 'text-emerald-700 dark:text-emerald-300'],
                    ['实时上行', hasMeaningfulValue(fmtMbps(cpe?.uploadMbps)) ? fmtMbps(cpe?.uploadMbps) : null, 'text-sky-700 dark:text-sky-300'],
                    ['最高下行', hasMeaningfulValue(fmtMbps(peakDownload)) ? fmtMbps(peakDownload) : null, 'text-emerald-700 dark:text-emerald-300'],
                    ['最高上行', hasMeaningfulValue(fmtMbps(peakUpload)) ? fmtMbps(peakUpload) : null, 'text-sky-700 dark:text-sky-300'],
                    ['会话时长', cpe?.sessionTimeSeconds ? `${Math.floor(Number(cpe.sessionTimeSeconds)/3600)}h ${Math.floor((Number(cpe.sessionTimeSeconds)%3600)/60)}m` : null, ''],
                    ['总流量', (cpe?.totalRxBytes != null || cpe?.totalTxBytes != null) ? `↓${formatBytes(cpe?.totalRxBytes)} ↑${formatBytes(cpe?.totalTxBytes)}` : null, ''],
                    ['本月', (cpe?.monthRxBytes != null || cpe?.monthTxBytes != null) ? `↓${formatBytes(cpe?.monthRxBytes)} ↑${formatBytes(cpe?.monthTxBytes)}` : null, ''],
                    ['今日', (cpe?.dayRxBytes != null || cpe?.dayTxBytes != null) ? `↓${formatBytes(cpe?.dayRxBytes)} ↑${formatBytes(cpe?.dayTxBytes)}` : null, ''],
                    ['挂载设备', totalClients != null && totalClients > 0 ? `${totalClients}` : null, ''],
                    ['SIM 状态', typeof cpe?.simReady === 'boolean' ? (cpe.simReady ? '就绪' : '未就绪') : null, ''],
                    ['固件', cpe?.firmwareVersion ?? null, ''],
                    ['IMEI', cpe?.imei ?? null, ''],
                  ].filter(([, value]) => hasMeaningfulValue(value));
                  return (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      <div className="rounded-md border p-2.5 space-y-1.5 bg-amber-50/40 border-amber-200/60 dark:bg-amber-950/20 dark:border-amber-700/40">
                        <div className="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">移动网络</div>
                        <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-[11px]">
                          {networkRows.map(([label, value]) => (
                            <div key={String(label)} className="flex justify-between gap-3">
                              <span className="text-slate-500 dark:text-slate-400">{label}</span>
                              <span className="font-medium break-all max-w-[60%]">{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-md border p-2.5 space-y-1.5 bg-slate-50 dark:bg-slate-900/40">
                        <div className="text-[11px] text-slate-700 dark:text-slate-300 font-semibold">速率 / 流量 / 会话</div>
                        <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-[11px]">
                          {trafficRows.map(([label, value, tone]) => (
                            <div key={String(label)} className="flex justify-between gap-3">
                              <span className="text-slate-500 dark:text-slate-400">{label}</span>
                              <span className={cn('font-medium break-all max-w-[60%]', tone)}>{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {bands.length > 0 ? (
                        <div className="md:col-span-2 rounded-md border p-2.5 space-y-1.5 bg-white dark:bg-slate-900/30">
                          <div className="text-[11px] text-slate-700 dark:text-slate-300 font-semibold">Wi-Fi 双频状态</div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {bands.map((b, i) => (
                              <div key={i} className="rounded border p-2 text-[11px] space-y-0.5 bg-slate-50 dark:bg-slate-950/40 border-slate-200 dark:border-slate-700/50">
                                <div className="flex items-center justify-between font-semibold">
                                  <span className="text-slate-700 dark:text-slate-300">{b.band ?? (b.frequencyGHz ? `${b.frequencyGHz} GHz` : `频段${i+1}`)}</span>
                                  <Badge variant="outline" className={cn('text-[9px]', b.enabled ? 'border-emerald-400/40 text-emerald-700 dark:text-emerald-300' : 'border-slate-400/40 text-slate-500')}>
                                    {b.enabled ? '已启用' : '已禁用'}
                                  </Badge>
                                </div>
                                {[
                                  ['SSID', b.ssid ?? null],
                                  ['信道 / 频宽', b.channel ? `Ch ${b.channel}${b.bandwidthMHz ? ` / ${b.bandwidthMHz}MHz` : ''}` : null],
                                  ['加密', b.security ?? null],
                                  ['客户端数', b.clientCount != null && b.clientCount > 0 ? `${b.clientCount}` : null],
                                ].filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                                  <div key={String(label)} className="flex justify-between gap-3">
                                    <span className="text-slate-500 dark:text-slate-400">{label}</span>
                                    <span className="font-medium break-all max-w-[60%]">{value}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {!cpe ? (
                        <div className="md:col-span-2 rounded-md border border-dashed border-slate-300 dark:border-slate-600 p-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
                          暂无运行时数据。
                        </div>
                      ) : null}
                    </div>
                  );
                })()
              ) : (
                (() => {
                  const wifi = (firstDevice as any)?.wifiAp as any;
                  const nodes = (Array.isArray(wifi?.meshTopology) ? wifi.meshTopology : []) as any[];
                  const bands = (Array.isArray(wifi?.bands) ? wifi.bands : []) as any[];
                  return (
                    <div className="space-y-2.5">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {nodes.length > 0 ? nodes.map((n, i) => (
                          <div
                            key={n.nodeId ?? i}
                            className={cn(
                              'rounded-md border p-2 space-y-1 text-[11px]',
                              n.online
                                ? 'bg-sky-50 border-sky-200/60 dark:bg-sky-950/20 dark:border-sky-700/50 text-slate-700 dark:text-sky-200'
                                : 'bg-slate-50 border-slate-200/60 dark:bg-slate-900/30 dark:border-slate-700/50 text-slate-500 dark:text-slate-400',
                            )}
                          >
                            <div className="flex items-center justify-between font-semibold">
                              <span className="inline-flex items-center gap-1">
                                <span className={cn('h-2 w-2 rounded-full', n.online ? 'bg-emerald-500' : 'bg-slate-400')} />
                                {n.role === 'master' ? '主控 Beacon 1' : n.role === 'satellite' ? `Beacon ${i + 1}` : (n.model ?? `节点${i + 1}`)}
                              </span>
                              <Badge variant="outline" className={cn('text-[9px]', n.role === 'master' ? 'border-sky-400/40 text-sky-700 dark:text-sky-300' : 'border-slate-400/40')}>
                                {n.role === 'master' ? '主控' : (n.role ?? '子节点')}
                              </Badge>
                            </div>
                            {[
                              ['型号', n.model ?? null],
                              ['IP', n.ip ?? null],
                              ['客户端', n.totalClientCount != null && n.totalClientCount > 0 ? `${n.totalClientCount}` : null],
                              ['回程', n.backhaulType ? `${n.backhaulType === 'ethernet' ? '有线' : n.backhaulType === 'wifi_5G' ? '5G Wi-Fi' : n.backhaulType === 'wifi_2.4G' ? '2.4G Wi-Fi' : n.backhaulType}${n.backhaulRateMbps ? ` ${n.backhaulRateMbps} Mbps` : ''}` : null],
                              ['回程 RSSI', n.backhaulRssiDbm != null ? `${n.backhaulRssiDbm} dBm` : null],
                              ['固件', n.firmware ?? null],
                              ['上行至', n.parentNodeId ? (() => {
                                const parent = nodes.find((x) => x.nodeId === n.parentNodeId);
                                return parent ? (parent.role === 'master' ? '主控' : (parent.model ?? parent.nodeId)) : n.parentNodeId;
                              })() : '（根）'],
                            ].filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                              <div key={String(label)} className="flex justify-between gap-3">
                                <span className="opacity-70">{label}</span>
                                <span className="font-medium break-all max-w-[55%]">{value}</span>
                              </div>
                            ))}
                          </div>
                        )) : (
                          [0, 1, 2, 3].map((i) => (
                            <div
                              key={i}
                              className="rounded-md border border-dashed border-slate-300 dark:border-slate-600 p-2 space-y-1 text-[11px] text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-900/20"
                            >
                              <div className="flex items-center justify-between font-semibold">
                                <span className="inline-flex items-center gap-1">
                                  <span className="h-2 w-2 rounded-full bg-slate-400/70" />
                                  Beacon {i + 1}{i === 0 ? ' · 主控' : ''}
                                </span>
                                <Badge variant="outline" className="text-[9px]">{i === 0 ? '占位' : '待接入'}</Badge>
                              </div>
                              <div className="text-[10px] opacity-80">
                                {i === 0 ? '暂无主节点数据。' : '暂无节点数据。'}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      {bands.length > 0 ? (
                        <div className="rounded-md border p-2.5 space-y-1.5 bg-white dark:bg-slate-900/30">
                          <div className="text-[11px] text-slate-700 dark:text-slate-300 font-semibold">主 AP 双频状态</div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {bands.map((b, i) => (
                              <div key={i} className="rounded border p-2 text-[11px] space-y-0.5 bg-slate-50 dark:bg-slate-950/40 border-slate-200 dark:border-slate-700/50">
                                <div className="flex items-center justify-between font-semibold">
                                  <span className="text-slate-700 dark:text-slate-300">{b.band ?? (b.frequencyGHz ? `${b.frequencyGHz} GHz` : `频段${i+1}`)}</span>
                                  <Badge variant="outline" className={cn('text-[9px]', b.enabled ? 'border-emerald-400/40 text-emerald-700 dark:text-emerald-300' : 'border-slate-400/40 text-slate-500')}>
                                    {b.enabled ? '已启用' : '已禁用'}
                                  </Badge>
                                </div>
                                {[
                                  ['SSID', b.ssid ?? null],
                                  ['信道 / 频宽', b.channel ? `Ch ${b.channel}${b.bandwidthMHz ? ` / ${b.bandwidthMHz}MHz` : ''}` : null],
                                  ['发送功率', b.txPowerDbm != null ? `${b.txPowerDbm} dBm` : null],
                                  ['下行/上行', (b.txRateMbps != null || b.rxRateMbps != null) ? `${b.txRateMbps ?? '--'} / ${b.rxRateMbps ?? '--'} Mbps` : null],
                                  ['客户端数', b.clientCount != null && b.clientCount > 0 ? `${b.clientCount}` : null],
                                ].filter(([, value]) => hasMeaningfulValue(value)).map(([label, value]) => (
                                  <div key={String(label)} className="flex justify-between gap-3">
                                    <span className="text-slate-500 dark:text-slate-400">{label}</span>
                                    <span className="font-medium break-all max-w-[60%]">{value}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {!wifi ? (
                        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-600 p-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
                          暂无运行时数据。
                        </div>
                      ) : null}
                    </div>
                  );
                })()
              )}
          </div>

          <div className="rounded-md border mt-1 overflow-hidden">
            <button
              type="button"
              onClick={() => setAdapterConfigExpanded((prev) => !prev)}
              className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left text-[11px] bg-slate-50 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors"
            >
              {adapterConfigExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span className="font-semibold text-slate-700 dark:text-slate-200">本地适配器配置</span>
              <div className="ml-auto inline-flex items-center gap-1">
                {effectiveAdapterKind === 'huawei_cpe' ? <Badge variant="outline" className="text-[9px] border-amber-400/40 text-amber-700 dark:text-amber-300">Huawei 5G CPE</Badge> : null}
                {effectiveAdapterKind === 'nokia_beacon' ? <Badge variant="outline" className="text-[9px] border-sky-400/40 text-sky-700 dark:text-sky-300">Nokia Beacon 1 Mesh</Badge> : null}
                {!effectiveAdapterKind ? <Badge variant="outline" className="text-[9px]">自动识别</Badge> : null}
              </div>
            </button>
            {adapterConfigExpanded ? (
              <div className="p-2.5 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <div className="sm:col-span-6 space-y-1">
                    <Label htmlFor={`adapter-kind-${room.key}`} className="text-[11px]">适配器类型</Label>
                    <Select
                      value={adapterKind ?? effectiveAdapterKind ?? ''}
                      onValueChange={(v) => setAdapterKind(v === '' ? null : (v as any))}
                    >
                      <SelectTrigger id={`adapter-kind-${room.key}`} className="h-8 text-xs">
                        <SelectValue placeholder="自动识别" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">自动识别</SelectItem>
                        <SelectItem value="huawei_cpe">Huawei H122-373 · 5G CPE Pro 2</SelectItem>
                        <SelectItem value="nokia_beacon">Nokia Beacon 1 (HA-020W-B) Mesh 主控</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-6 space-y-1">
                    <Label htmlFor={`adapter-baseurl-${room.key}`} className="text-[11px]">访问地址</Label>
                    <Input
                      id={`adapter-baseurl-${room.key}`}
                      size={16}
                      className="h-8 text-xs font-mono"
                      placeholder={(effectiveAdapterKind === 'huawei_cpe' || primaryCategory === DeviceCategory.FIVE_G_CPE) ? 'http://192.168.41.1' : 'http://192.168.41.101'}
                      value={adapterBaseUrl}
                      onChange={(e) => setAdapterBaseUrl(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-6 space-y-1">
                    <Label htmlFor={`adapter-username-${room.key}`} className="text-[11px]">用户名</Label>
                    <Input
                      id={`adapter-username-${room.key}`}
                      size={16}
                      className="h-8 text-xs"
                      placeholder="admin"
                      value={adapterUsername}
                      onChange={(e) => setAdapterUsername(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-6 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`adapter-password-${room.key}`} className="text-[11px]">密码</Label>
                      {adapterPasswordMasked ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-400/40 text-[9px] text-emerald-700 dark:text-emerald-300">
                          密码已保存
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id={`adapter-password-${room.key}`}
                        type="password"
                        size={16}
                        className="h-8 text-xs flex-1"
                        placeholder={
                          adapterPasswordMasked
                            ? '（已保存，留空或编辑表示不更新密码）'
                            : adapterBaseUrl
                              ? '（留空表示不更新已有密码）WebUI 登录密码'
                              : 'WebUI 登录密码'
                        }
                        value={adapterPassword}
                        onChange={(e) => {
                          setAdapterPassword(e.target.value);
                          setAdapterPasswordMasked(false);
                        }}
                        onFocus={() => setAdapterPasswordMasked(false)}
                      />
                    </div>
                  </div>
                  {effectiveAdapterKind === 'nokia_beacon' ? (
                    <div className="sm:col-span-12 space-y-1">
                      <Label htmlFor={`adapter-session-sid-${room.key}`} className="text-[11px]">Session SID</Label>
                      <Input
                        id={`adapter-session-sid-${room.key}`}
                        size={16}
                        className="h-8 text-xs font-mono"
                        placeholder="可选：已登录 WebUI 时填 sid"
                        value={adapterSessionSid}
                        onChange={(e) => setAdapterSessionSid(e.target.value)}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[11px]"
                    onClick={() => setNetworkDetailOpen(false)}
                  >
                    关闭
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 bg-indigo-600 text-[11px] hover:bg-indigo-700"
                    onClick={handleSaveAdapterConfig}
                    disabled={adapterSaving || !deviceDid}
                  >
                    <RefreshCw className={cn('mr-1 h-3 w-3', adapterSaving && 'animate-spin')} />
                    {adapterSaving ? '保存中...' : '保存配置并同步'}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog
      open={roomEditorOpen}
      onOpenChange={(next) => {
        if (savingRoom) return;
        setRoomEditorOpen(next);
        if (next) {
          setDraftAnnotation(room.roomAnnotation ?? '');
          setDraftFloor(String(Number.isFinite(room.floor) ? room.floor : 1));
        }
      }}
    >
      <DialogContent
        onClick={(event) => event.stopPropagation()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{room.title} 房间设置</DialogTitle>
          <DialogDescription>
            可自定义房间备注与所在楼层，保存后将按楼层重新分组显示。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${room.key}-annotation`}>房间备注</Label>
            <Input
              id={`${room.key}-annotation`}
              value={draftAnnotation}
              onChange={(event) => setDraftAnnotation(event.target.value)}
              placeholder="不填则直接显示房号"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${room.key}-floor`}>所在楼层</Label>
            <Select value={draftFloor} onValueChange={setDraftFloor}>
              <SelectTrigger id={`${room.key}-floor`} className="w-full">
                <SelectValue placeholder="请选择楼层" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 5 }, (_, i) => -(i + 1)).reverse().map((floor) => (
                  <SelectItem key={floor} value={String(floor)}>
                    {floorToDualLabel(floor)}
                  </SelectItem>
                ))}
                {Array.from({ length: 11 }, (_, i) => i).map((floor) => (
                  <SelectItem key={floor} value={String(floor)}>
                    {floorToDualLabel(floor)}
                  </SelectItem>
                ))}
                {Array.from({ length: 20 }, (_, i) => i + 11).map((floor) => (
                  <SelectItem key={floor} value={String(floor)}>
                    {floorToDualLabel(floor)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground">
              EG 地面层 · n. OG 楼上第 n 层 · UG n 地下第 n 层
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setRoomEditorOpen(false)}
            disabled={savingRoom}
          >
            取消
          </Button>
          <Button onClick={handleSaveRoomEditor} disabled={savingRoom}>
            {savingRoom ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

export default RoomCard;
