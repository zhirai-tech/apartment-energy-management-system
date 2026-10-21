import { useState, type MouseEvent, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Camera as CameraIcon,
  Mic,
  HardDrive,
  BellRing,
  Moon,
  Settings,
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
  HelpCircle,
  ArrowLeft,
  X,
  Eye,
  EyeOff,
  MicOff,
  ShieldAlert,
  Monitor,
  ExternalLink,
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
import { useXiaomiRememberedCredentials } from '../../hooks/useXiaomiRememberedCredentials';
import { DashboardSpaceCard, floorToDualLabel } from './RoomsGrid';
import { FeeHint } from '../ui/fee-hint';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

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
  const [camManualSnapshotUrl, setCamManualSnapshotUrl] = useState('');
  const [camManualAuthUsername, setCamManualAuthUsername] = useState('');
  const [camManualAuthPassword, setCamManualAuthPassword] = useState('');
  const [camManualAuthType, setCamManualAuthType] = useState<'digest' | 'basic' | 'none'>('digest');
  const [camManualBrand, setCamManualBrand] = useState('');
  const [camManualModel, setCamManualModel] = useState('');
  const [savingCameraManual, setSavingCameraManual] = useState(false);
  const [cameraManualExpanded, setCameraManualExpanded] = useState(false);
  const [cameraViewTab, setCameraViewTab] = useState<'live' | 'settings'>('live');
  const [helpModalTopic, setHelpModalTopic] = useState<'eu' | 'lan' | null>(null);
  const [streamQuality, setStreamQuality] = useState<'hd' | 'sd'>('hd');
  const [camSwitches, setCamSwitches] = useState<{
    motion: boolean; night: boolean; audio: boolean; privacy: boolean;
  }>({ motion: false, night: false, audio: false, privacy: false });
  const [takeSnapshotLoading, setTakeSnapshotLoading] = useState(false);
  const [openStreamLoading, setOpenStreamLoading] = useState(false);
  const [startStreamError, setStartStreamError] = useState<string>('');
  const [currentStream, setCurrentStream] = useState<{
    hlsUrl?: string;
    webrtcUrl?: string;
    proxyMode?: string;
    processId?: number;
    startedAt?: string;
    ffmpegAvailable?: boolean;
  } | null>(null);
  const hlsVideoRef = useRef<HTMLVideoElement | null>(null);
  const hlsInstanceRef = useRef<any>(null);
  const [ptzLoading, setPtzLoading] = useState(false);
  const [euCameraLoginExpanded, setEuCameraLoginExpanded] = useState(false);
  const { credentials: euCameraRemember, persist: persistEuCameraRemember, clear: clearEuCameraRemember } =
    useXiaomiRememberedCredentials('camera')
  void clearEuCameraRemember;
  const [euCameraUsername, setEuCameraUsername] = useState(euCameraRemember.username);
  const [euCameraPassword, setEuCameraPassword] = useState(euCameraRemember.password);
  const [euCameraRegion, setEuCameraRegion] = useState<string>(euCameraRemember.region || 'de');
  useEffect(() => {
    setEuCameraUsername(euCameraRemember.username);
    setEuCameraPassword(euCameraRemember.password);
    setEuCameraRegion(euCameraRemember.region || 'de');
  }, [euCameraRemember.username, euCameraRemember.password, euCameraRemember.region]);
  const [euCameraLoginLoading, setEuCameraLoginLoading] = useState(false);
  void euCameraLoginLoading;
  const [euCameraLoginInfo, setEuCameraLoginInfo] = useState<{
    loggedIn: boolean;
    username?: string;
    region?: string;
    devices?: any[];
    needsVerification?: boolean | null;
    verificationMethod?: 'email_code' | 'browser' | null;
    notificationUrl?: string | null;
    authMessage?: string | null;
    codeSentAt?: string | null;
  } | null>(null);
  const [euCameraVerificationCode, setEuCameraVerificationCode] = useState('');
  const [euCameraOtpLoading, setEuCameraOtpLoading] = useState<null | 'send' | 'verify'>(null);
  void euCameraOtpLoading;
  const [otpResendCountdown, setOtpResendCountdown] = useState<number>(0);
  const [networkDetailOpen, setNetworkDetailOpen] = useState(false);
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

  useEffect(() => {
    if (!cameraDetailOpen) return;
    const raw = firstDevice?.model ?? '';
    let obj: any = null;
    try {
      if (raw && typeof raw === 'string') obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
    if (obj && typeof obj === 'object') {
      const cam = (obj as any).camera && typeof (obj as any).camera === 'object' ? (obj as any).camera : null;
      setCamManualSnapshotUrl(String(cam?.manualSnapshotUrl ?? obj?.manualSnapshotUrl ?? ''));
      setCamManualAuthUsername(String(cam?.manualAuthUsername ?? obj?.manualAuthUsername ?? ''));
      setCamManualAuthPassword(String(cam?.manualAuthPassword ?? obj?.manualAuthPassword ?? ''));
      const at = String(cam?.manualAuthType ?? obj?.manualAuthType ?? 'digest').toLowerCase();
      setCamManualAuthType(at === 'basic' ? 'basic' : at === 'none' ? 'none' : 'digest');
      setCamManualBrand(String(cam?.manualBrand ?? cam?.brand ?? obj?.vendorName ?? ''));
      setCamManualModel(String(cam?.manualModel ?? cam?.model ?? obj?.model ?? ''));
    } else {
      setCamManualSnapshotUrl('');
      setCamManualAuthUsername('');
      setCamManualAuthPassword('');
      setCamManualAuthType('digest');
      setCamManualBrand(String(firstDevice?.vendorName ?? ''));
      setCamManualModel(String(firstDevice?.camera?.model ?? firstDevice?.model ?? ''));
    }
  }, [cameraDetailOpen, firstDevice]);

  const handleSaveCameraManual = async () => {
    if (!deviceDid) {
      toast.error('设备 DID 不存在');
      return;
    }
    try {
      setSavingCameraManual(true);
      await system.updateDeviceCamera(deviceDid, {
        manualSnapshotUrl: camManualSnapshotUrl || null,
        manualAuthUsername: camManualAuthUsername || null,
        manualAuthPassword: camManualAuthPassword || null,
        manualAuthType: camManualAuthType,
        manualBrand: camManualBrand || null,
        manualModel: camManualModel || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setCameraSnapshotBump((prev) => prev + 1);
      snapshotThumbReloadRef.current += 1;
      toast.success('摄像头快照配置已保存');
    } catch {
      toast.error('保存摄像头快照配置失败');
    } finally {
      setSavingCameraManual(false);
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

  const cardToneClassName = getRoomStatusCardToneClass(room.status);

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
    }
  };

  const cameraSnapshotThumbUrl = useMemo(() => {
    if (primaryCategory !== DeviceCategory.CAMERA || !deviceDid) return '';
    return system.getDeviceSnapshotUrl(deviceDid, { fresh: false });
  }, [primaryCategory, deviceDid, cameraSnapshotBump]);
  const cameraSnapshotLargeUrl = useMemo(() => {
    if (primaryCategory !== DeviceCategory.CAMERA || !deviceDid) return '';
    return system.getDeviceSnapshotUrl(deviceDid, { fresh: true });
  }, [primaryCategory, deviceDid, cameraSnapshotBump, cameraDetailOpen]);

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

  const stopHls = () => {
    if (hlsInstanceRef.current) {
      try { hlsInstanceRef.current.destroy(); } catch {}
      hlsInstanceRef.current = null;
    }
    if (hlsVideoRef.current) {
      try { hlsVideoRef.current.pause(); hlsVideoRef.current.removeAttribute('src'); hlsVideoRef.current.load(); } catch {}
    }
  };

  const startCameraStream = async () => {
    if (!deviceDid) return;
    try {
      setOpenStreamLoading(true);
      setStartStreamError('');
      const res = await system.getCameraStream(deviceDid);
      if (!res.ok) {
        setStartStreamError(res.errorMessage || '开启视频流失败');
        return;
      }
      setCurrentStream({
        hlsUrl: res.hlsUrl,
        webrtcUrl: res.webrtcUrl,
        proxyMode: res.proxyMode,
        processId: res.processId,
        startedAt: res.startedAt,
        ffmpegAvailable: res.ffmpegAvailable,
      });
      if (res.proxyMode && res.proxyMode !== 'ffmpeg-hls') {
        setStartStreamError(`当前代理模式：${res.proxyMode}，需单独配置`);
      }
      if (!res.hlsUrl && res.ffmpegAvailable === false) {
        setStartStreamError('服务器未检测到 ffmpeg，无法生成 HLS 切片。请安装 ffmpeg 后重试。');
      }
    } catch (error) {
      setStartStreamError(error instanceof Error ? error.message : '开启视频流失败');
    } finally {
      setOpenStreamLoading(false);
    }
  };

  useEffect(() => {
    if (!cameraDetailOpen) return;
    if (cameraViewTab !== 'live' || !currentStream?.hlsUrl || !hlsVideoRef.current) return;
    const videoEl = hlsVideoRef.current;
    const hlsUrl = currentStream.hlsUrl;
    let destroyed = false;
    const run = async () => {
      const canNative = typeof videoEl.canPlayType === 'function' && videoEl.canPlayType('application/vnd.apple.mpegurl');
      if (canNative) {
        videoEl.src = hlsUrl;
        try { await videoEl.play(); } catch {}
        return;
      }
      try {
        const Hls = (await import('hls.js')).default;
        if (!Hls || !Hls.isSupported()) {
          setStartStreamError('当前浏览器不支持 HLS 播放');
          return;
        }
        const hls = new Hls({ lowLatencyMode: true, enableWorker: true });
        if (destroyed) return;
        hlsInstanceRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (data && data.fatal) {
            setStartStreamError(`HLS 播放错误：${data.type || ''} ${data.details || ''}`);
          }
        });
      } catch (err) {
        setStartStreamError(err instanceof Error ? err.message : 'HLS 初始化失败');
      }
    };
    run();
    return () => {
      destroyed = true;
      stopHls();
    };
  }, [cameraDetailOpen, cameraViewTab, currentStream?.hlsUrl]);

  useEffect(() => {
    if (cameraDetailOpen) return;
    stopHls();
    setCurrentStream(null);
    setStartStreamError('');
    setOpenStreamLoading(false);
  }, [cameraDetailOpen]);

  useEffect(() => {
    if (!euCameraLoginInfo?.codeSentAt) return;
    try {
      const t0 = new Date(euCameraLoginInfo.codeSentAt as string).getTime();
      if (!Number.isFinite(t0)) return;
      const elapsed = Math.floor((Date.now() - t0) / 1000);
      const remaining = Math.max(0, 60 - elapsed);
      setOtpResendCountdown(remaining);
    } catch {}
  }, [euCameraLoginInfo?.codeSentAt]);

  useEffect(() => {
    if (otpResendCountdown <= 0) return;
    const timer = setInterval(() => {
      setOtpResendCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpResendCountdown]);

  const handleCameraPTZ = async (dir: 'left' | 'right' | 'up' | 'down' | 'stop') => {
    if (!deviceDid || !canControl) return;
    try {
      setPtzLoading(true);
      await system.controlCameraPTZ(deviceDid, dir, 50);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '云台控制失败');
    } finally {
      setPtzLoading(false);
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
      toast.success(`已保存临时证据截图：${filename}`);
      setCameraSnapshotBump((prev) => prev + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '临时截图失败');
    } finally {
      setTakeSnapshotLoading(false);
    }
  };

  const handleEuCameraLogin = async () => {
    try {
      persistEuCameraRemember({ enabled: euCameraRemember.enabled, username: euCameraUsername.trim(), password: euCameraPassword, region: euCameraRegion })
      setEuCameraLoginLoading(true);
      setEuCameraVerificationCode('');
      const params = {
        username: euCameraUsername,
        password: euCameraPassword,
        region: euCameraRegion,
      };
      const res = await system.xiaomiCameraLogin(params);
      const auth = res.auth ?? null;
      const needsVerification =
        res.needsVerification ?? auth?.needsVerification ?? false;
      const verificationMethod =
        res.verificationMethod ?? auth?.verificationMethod ?? null;
      const notificationUrl =
        res.notificationUrl ?? auth?.notificationUrl ?? null;
      const authMessage = auth?.message ?? res.message ?? null;
      const codeSentAt = auth?.codeSentAt ?? null;

      if (res.loggedIn) {
        toast.success(`已登录 EU 区米家：${res.username || '(env 账号)'} · ${res.region || 'de'}`);
        persistEuCameraRemember({ enabled: euCameraRemember.enabled, username: euCameraUsername.trim(), password: euCameraRemember.enabled ? euCameraPassword : '', region: euCameraRegion })
        setEuCameraPassword(euCameraRemember.enabled ? euCameraPassword : '')
        setEuCameraLoginInfo({
          loggedIn: true,
          username: res.username,
          region: res.region,
          needsVerification: false,
          verificationMethod: null,
          notificationUrl: null,
          authMessage: null,
          codeSentAt: null,
        });
        await refreshEuCameraDevices();
        return;
      }

      if (needsVerification) {
        const msg =
          authMessage ||
          '米家 EU 触发了安全验证，正在自动向邮箱发送验证码，请稍后查收并输入';
        toast.warning(msg);
        setEuCameraLoginInfo({
          loggedIn: false,
          username: res.username,
          region: res.region,
          needsVerification: true,
          verificationMethod: verificationMethod ?? 'email_code',
          notificationUrl,
          authMessage: msg,
          codeSentAt,
        });
        if ((verificationMethod ?? 'email_code') === 'email_code') {
          try {
            setEuCameraOtpLoading('send');
            const otpRes = await system.xiaomiCameraLogin({ sendEmailVerificationCode: true });
            const otpAuth = otpRes.auth ?? null;
            setEuCameraLoginInfo((prev) => ({
              ...(prev ?? { loggedIn: false }),
              needsVerification: true,
              verificationMethod: otpRes.verificationMethod ?? 'email_code',
              codeSentAt: otpAuth?.codeSentAt ?? new Date().toISOString(),
              authMessage: otpAuth?.message ?? '米家验证码已发送到邮箱，输入 6 位数字后点提码',
              notificationUrl: otpAuth?.notificationUrl ?? (prev as any)?.notificationUrl ?? null,
            }));
            toast.success(
              otpRes.sent
                ? '✅ 验证码已发送到 EU 邮箱，查收后直接填右边 6 位点提码即可'
                : (otpAuth?.message || '验证码已触发，注意查收 EU 邮箱'),
            );
          } catch (err) {
            toast.error((err as Error)?.message || '自动发送验证码失败，仍可稍后点发码');
          } finally {
            setEuCameraOtpLoading(null);
          }
        }
        return;
      }

      toast.error(res.message || '登录欧洲区米家账号失败');
      setEuCameraLoginInfo({
        loggedIn: false,
        username: res.username,
        region: res.region,
        needsVerification: false,
        verificationMethod: null,
        notificationUrl: null,
        authMessage: res.message || null,
        codeSentAt: null,
      });
    } catch (error: any) {
      const data = (error as any)?.response?.data ?? null;
      const needsVerification = data?.needsVerification ?? false;
      const verificationMethod = data?.verificationMethod ?? data?.auth?.verificationMethod ?? null;
      const notificationUrl = data?.notificationUrl ?? data?.auth?.notificationUrl ?? null;
      const authMessage =
        data?.auth?.message ?? data?.message ?? (error instanceof Error ? error.message : '登录 EU 区米家账号失败');

      if (needsVerification) {
        toast.warning(authMessage);
        setEuCameraLoginInfo({
          loggedIn: false,
          username: data?.username,
          region: data?.region,
          needsVerification: true,
          verificationMethod: verificationMethod ?? 'email_code',
          notificationUrl,
          authMessage,
          codeSentAt: data?.auth?.codeSentAt ?? null,
        });
        if ((verificationMethod ?? 'email_code') === 'email_code') {
          try {
            setEuCameraOtpLoading('send');
            const otpRes = await system.xiaomiCameraLogin({ sendEmailVerificationCode: true });
            const otpAuth = otpRes.auth ?? null;
            setEuCameraLoginInfo((prev) => ({
              ...(prev ?? { loggedIn: false }),
              needsVerification: true,
              verificationMethod: otpRes.verificationMethod ?? 'email_code',
              codeSentAt: otpAuth?.codeSentAt ?? new Date().toISOString(),
              authMessage: otpAuth?.message ?? '米家验证码已发送到邮箱，输入 6 位数字后点提码',
              notificationUrl: otpAuth?.notificationUrl ?? (prev as any)?.notificationUrl ?? null,
            }));
            toast.success(
              otpRes.sent
                ? '✅ 验证码已发送到 EU 邮箱，查收后直接填右边 6 位点提码即可'
                : (otpAuth?.message || '验证码已触发，注意查收 EU 邮箱'),
            );
          } catch (err) {
            toast.error((err as Error)?.message || '自动发送验证码失败，仍可稍后点发码');
          } finally {
            setEuCameraOtpLoading(null);
          }
        }
      } else {
        toast.error(authMessage);
        setEuCameraLoginInfo({
          loggedIn: false,
          username: data?.username,
          region: data?.region,
          needsVerification: false,
          verificationMethod: null,
          notificationUrl: null,
          authMessage,
          codeSentAt: null,
        });
      }
    } finally {
      setEuCameraLoginLoading(false);
    }
  };

  const handleEuCameraSendCode = async () => {
    try {
      setEuCameraOtpLoading('send');
      const res = await system.xiaomiCameraLogin({ sendEmailVerificationCode: true });
      const auth = res.auth ?? null;
      toast.success(res.sent ? '验证码已发送到邮箱，查收后输入下方提交' : (auth?.message || '验证码已触发发送'));
      setEuCameraLoginInfo((prev) => ({
        ...(prev ?? { loggedIn: false }),
        needsVerification: true,
        verificationMethod: res.verificationMethod ?? 'email_code',
        codeSentAt: auth?.codeSentAt ?? new Date().toISOString(),
        authMessage: auth?.message ?? (prev as any)?.authMessage ?? null,
        notificationUrl: auth?.notificationUrl ?? (prev as any)?.notificationUrl ?? null,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送邮箱验证码失败');
    } finally {
      setEuCameraOtpLoading(null);
    }
  };

  const handleEuCameraVerifyCode = async () => {
    const code = euCameraVerificationCode.trim();
    if (!code) {
      toast.error('请先输入邮箱验证码');
      return;
    }
    try {
      setEuCameraOtpLoading('verify');
      const res = await system.xiaomiCameraLogin({ verificationCode: code });
      if (res.loggedIn) {
        const username = res.username ?? (res.auth as any)?.username ?? euCameraUsername;
        const region = res.region ?? (res.auth as any)?.region ?? euCameraRegion;
        toast.success(`✅ 验证码通过，已登录 EU 区米家${username ? ' ' + username : ''}${region ? ' · ' + region : ''}`);
        persistEuCameraRemember({ enabled: euCameraRemember.enabled, username: username ? String(username).trim() : euCameraUsername.trim(), password: euCameraRemember.enabled ? euCameraPassword : '', region: region ? String(region) : euCameraRegion })
        setEuCameraPassword(euCameraRemember.enabled ? euCameraPassword : '')
        setEuCameraLoginInfo({
          loggedIn: true,
          username,
          region,
          devices: (res as any).devices ?? [],
          needsVerification: false,
          verificationMethod: null,
          notificationUrl: null,
          authMessage: null,
          codeSentAt: null,
        });
        setEuCameraVerificationCode('');
        try { await refreshEuCameraDevices(); } catch {}
        return;
      }
      const auth = (res as any).auth ?? null;
      setEuCameraLoginInfo((prev) => ({
        ...(prev ?? { loggedIn: false }),
        loggedIn: false,
        username: auth?.username ?? (prev as any)?.username ?? null,
        region: auth?.region ?? (prev as any)?.region ?? null,
        devices: (res as any).devices ?? (prev as any)?.devices ?? [],
        needsVerification: auth?.needsVerification ?? false,
        verificationMethod: auth?.verificationMethod ?? null,
        notificationUrl: auth?.notificationUrl ?? null,
        authMessage: auth?.message ?? res.message ?? '验证码校验失败',
        codeSentAt: auth?.codeSentAt ?? null,
      }));
      toast.error(auth?.message ?? res.message ?? '验证码校验失败，再检查邮件里最新的 6 位数字');
    } catch (error: any) {
      const data = (error as any)?.response?.data ?? null;
      const auth = data?.auth ?? null;
      const msg = auth?.message ?? data?.message ?? (error instanceof Error ? error.message : '验证码校验失败');
      setEuCameraLoginInfo((prev) => ({
        ...(prev ?? { loggedIn: false }),
        loggedIn: false,
        username: auth?.username ?? (prev as any)?.username ?? null,
        region: auth?.region ?? (prev as any)?.region ?? null,
        needsVerification: auth?.needsVerification ?? false,
        verificationMethod: auth?.verificationMethod ?? null,
        notificationUrl: auth?.notificationUrl ?? null,
        authMessage: msg,
        codeSentAt: auth?.codeSentAt ?? null,
      }));
      toast.error(msg);
    } finally {
      setEuCameraOtpLoading(null);
    }
  };

  const refreshEuCameraDevices = async () => {
    try {
      const res = await system.xiaomiCameraDevices();
      setEuCameraLoginInfo({
        loggedIn: res.loggedIn,
        username: res.username,
        region: res.region,
        devices: res.devices,
        needsVerification: res.loggedIn ? false : (res as any)?.auth?.needsVerification ?? false,
        verificationMethod: res.loggedIn ? null : (res as any)?.auth?.verificationMethod ?? null,
        notificationUrl: res.loggedIn ? null : (res as any)?.auth?.notificationUrl ?? null,
        authMessage: res.loggedIn ? null : (res as any)?.auth?.message ?? null,
        codeSentAt: res.loggedIn ? null : (res as any)?.auth?.codeSentAt ?? null,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取 EU 区摄像头列表失败');
    }
  };

  void handleEuCameraLogin;
  void handleEuCameraSendCode;
  void handleEuCameraVerifyCode;

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
                  {cameraSnapshotThumbUrl ? (
                    <img
                      key={cameraSnapshotThumbUrl + '_' + snapshotThumbReloadRef.current}
                      src={cameraSnapshotThumbUrl}
                      alt={room.title + ' 实时快照'}
                      className="h-full w-full object-cover"
                      onError={() => {}}
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] leading-4 text-slate-400">
                      <span>暂无可渲染的快照来源</span>
                      <span className="text-slate-500">点右上角查看详情后再配置接入</span>
                    </div>
                  )}
                </div>
                <div className="pointer-events-none absolute left-1 top-1 inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-rose-100">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                  LIVE
                </div>
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
                const hasAudio = cam?.hasAudio === true || cam?.audioEnabled === true;
                const hasMotion = typeof cam?.lastMotionAt === 'string' || cam?.motionEnabled === true;
                const hasNight = cam?.hasNightVision === true || cam?.nightVision === true || cam?.nightMode === true;
                const hasRecording = cam?.recordingEnabled === true || cam?.storageEnabled === true || cam?.sdCard === true;
                const tone = (ok: boolean) =>
                  ok
                    ? 'text-emerald-600 dark:text-emerald-400 border-emerald-400/50 bg-emerald-50/60 dark:bg-emerald-950/30'
                    : 'text-rose-600 dark:text-rose-400 border-rose-400/50 bg-rose-50/60 dark:bg-rose-950/30';
                return (
                  <div className="w-full grid grid-cols-4 gap-1">
                    <div className="min-w-0">
                      <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10.5px] ${tone(hasAudio)}`}>
                        <Mic className="h-3 w-3 shrink-0" />
                        <span className="truncate">录音</span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10.5px] ${tone(hasMotion)}`}>
                        <BellRing className="h-3 w-3 shrink-0" />
                        <span className="truncate">移动侦测</span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10.5px] ${tone(hasNight)}`}>
                        <Moon className="h-3 w-3 shrink-0" />
                        <span className="truncate">夜视</span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10.5px] ${tone(hasRecording)}`}>
                        <HardDrive className="h-3 w-3 shrink-0" />
                        <span className="truncate">录像存储</span>
                      </div>
                    </div>
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
          {primaryCategory !== DeviceCategory.CAMERA && room.deviceOnline ? (
            <Badge variant="success" className="text-[10px]">
              {typeof room.deviceOnline === 'number' && isPublicFacility
                ? `在线 ${room.deviceOnline} 台`
                : '设备在线'}
            </Badge>
          ) : primaryCategory !== DeviceCategory.CAMERA && !room.deviceOnline ? (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="destructive" className="cursor-help text-[10px]">
                    设备离线
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs leading-5">
                  设备已离线，请检查上一级控开及总电源。
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
              ) : (
                <Badge variant={room.deviceOnline ? 'success' : 'destructive'} className="text-[10px]">
                  {room.deviceOnline ? '设备在线' : '设备离线'}
                </Badge>
              )}
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
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>

    <Dialog
      open={cameraDetailOpen}
      onOpenChange={(next) => {
        setCameraDetailOpen(next);
        if (!next) setHelpModalTopic(null);
      }}
    >
      <DialogContent
        onClick={(event) => event.stopPropagation()}
        className="sm:max-w-6xl max-h-[92vh] h-[90vh] flex flex-col p-0 overflow-hidden"
      >
        <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <DialogTitle className="inline-flex flex-wrap items-center gap-2 text-[clamp(0.88rem,1.1vw,0.98rem)]">
            <CameraIcon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            {room.title} · 实时监控
            <div className="ml-auto inline-flex flex-wrap items-center gap-1">
              {firstDevice?.vendorName ? (
                <Badge variant="outline" className="text-[10px]">
                  厂商 {firstDevice.vendorName}
                </Badge>
              ) : null}
              {firstDevice?.ipAddress ? (
                <Badge variant="outline" className="text-[10px]">
                  IP {firstDevice.ipAddress}
                </Badge>
              ) : null}
              {firstDevice?.macAddress ? (
                <Badge variant="outline" className="text-[10px]">
                  MAC {firstDevice.macAddress}
                </Badge>
              ) : null}
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn(
                        'h-7 rounded-md px-2 text-[11px]',
                        cameraViewTab === 'settings'
                          ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
                      )}
                      onClick={() => setCameraViewTab(cameraViewTab === 'settings' ? 'live' : 'settings')}
                    >
                      <Settings className="mr-1 h-3.5 w-3.5" /> {cameraViewTab === 'settings' ? '返回监控' : '设置'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-[11px]">
                    {cameraViewTab === 'settings' ? '返回实时监控画面' : '接入配置'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </DialogTitle>
          <DialogDescription className="hidden"></DialogDescription>
        </DialogHeader>

        {helpModalTopic ? (
          <div className="relative flex-1 overflow-hidden flex flex-col bg-slate-50 dark:bg-slate-950/60">
            <div className="flex items-center gap-2 px-4 py-2 border-b bg-white dark:bg-slate-900 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setHelpModalTopic(null)}
              >
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> 返回
              </Button>
              <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">
                {helpModalTopic === 'eu' ? '接入说明 · 米家 EU 官方接入' : '接入说明 · 纯局域网手动配置'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 ml-auto rounded-full"
                onClick={() => setHelpModalTopic(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 text-[12px] leading-6 text-slate-700 dark:text-slate-300">
              {helpModalTopic === 'eu' ? (
                <>
                  <div className="rounded-md bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-800/50 px-3 py-2">
                    <div className="font-semibold text-indigo-700 dark:text-indigo-300 mb-0.5">C301 / MBCMC23 接入方式 ①（推荐，免手动开关）</div>
                    你不需要在小米国际版 App 里翻开关、记密码。本面板直接通过 EU 米家官方授权，调用官方 MiOT Action <span className="font-mono">start-rtsp-stream</span>，自动拿到 RTSP 地址，然后服务器 ffmpeg 切片 HLS 播放。
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">📋 字段说明</div>
                    <ul className="list-disc pl-5 space-y-1">
                      <li><span className="font-mono">EU 米家账号 / 密码</span>：<a className="text-indigo-600 dark:text-indigo-400 underline" href="https://account.xiaomi.com/" target="_blank" rel="noreferrer noopener">小米账号系统</a> 里与中国区独立的欧洲区账号，在米家 App（国际版）注册使用，登录服务器选德国/法国等欧洲节点。<span className="font-semibold text-rose-600">中国区的小米账号直接登录无法发现国际版 C301</span>。</li>
                      <li><span className="font-mono">地区</span>：按你注册时选的区域填；不确定就试 de / sg / us，登录成功后会话与该区域绑定。</li>
                    </ul>
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">🔁 流程</div>
                    <ol className="list-decimal pl-5 space-y-1">
                      <li>填 EU 米家账号 + 密码 → 点「登录」（不影响中国区 10 个房间的空开）</li>
                      <li>会话建立后会自动列出 EU 账号下所有设备（型号为 MBCMC23 即为 C301）</li>
                      <li>回到实时监控视图 → 点「开启实时流」：服务器会通过 MiOT Action 调 <span className="font-mono">start-rtsp-stream</span> → 服务器 ffmpeg 切片为 HLS 播放</li>
                    </ol>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/60 dark:border-emerald-800/50 px-3 py-2">
                    <div className="font-semibold text-emerald-700 dark:text-emerald-300 mb-0.5">C301 / MBCMC23 接入方式 ②（纯局域网直连 · 先在 App 里一次性开启 RTSP）</div>
                    本面板<b>同时适用于小米 C301 / MBCMC23</b> 与 Sigmastar / 海康 / 大华等其他 IP 摄像头。先在手机 App 里一次性打开 RTSP 开关，拿到 URL 和账号密码后填到下方，之后即可长期离线观看。
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">📱 C301 App 内开启步骤</div>
                    <ol className="list-decimal pl-5 space-y-1">
                      <li>打开 <span className="font-mono">Xiaomi Home 国际版</span> → 进入 C301 摄像头详情页 → 点右上角 ⚙「设置」</li>
                      <li>找 <span className="font-mono">高级设置 / 局域网设置 / RTSP 服务</span>（不同固件版本命名略有差异），打开 <span className="font-mono">RTSP</span> 开关</li>
                      <li>在同页面设置 <span className="font-mono">摄像头 RTSP 登录密码</span>，<span className="font-semibold">默认账号固定为 admin，密码就是你在这一步自己设的，≠ 米家账号密码</span></li>
                      <li>App 会展示完整的 RTSP URL（如 <span className="font-mono">rtsp://admin:xxxx@192.168.1.200:554/live</span>），整串抄到下方「快照 URL」，并在账号 / 密码栏填刚才设的 admin / 对应密码</li>
                    </ol>
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">📋 字段说明</div>
                    <ul className="list-disc pl-5 space-y-1">
                      <li><span className="font-mono">快照 URL</span>：C301 填 RTSP 整串即可；其他品牌也可以填 HTTP 快照 URL（从 Web 后台「网络 / 快照」菜单或 ONVIF Device Manager 里拿）</li>
                      <li><span className="font-mono">账号 / 密码</span>：对 C301 来说，就是你在 App 里开 RTSP 时自己设的 admin + 对应密码；其他品牌就是 Web 后台的登录名/密码</li>
                      <li><span className="font-mono">鉴权</span>：海康全系 Digest；老款雄迈/大华可能 Basic；不确定的话 C301 选「Digest」先试</li>
                      <li><span className="font-mono">厂商 / 型号</span>：只用于显示，照机身贴纸抄即可（C301 推荐填 MBCMC23）</li>
                    </ul>
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-slate-800 dark:text-slate-200">📐 常见品牌 URL / 路径模板</div>
                    <table className="w-full text-[11.5px] border-collapse">
                      <tbody>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 pr-3 font-medium whitespace-nowrap">小米 C301 / MBCMC23 · 主码流</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">rtsp://admin:密码@IP:554/live</span></td>
                        </tr>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 pr-3 font-medium whitespace-nowrap">小米 C301 / MBCMC23 · 子码流</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">rtsp://admin:密码@IP:554/sub</span></td>
                        </tr>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 pr-3 font-medium whitespace-nowrap">小米 C301 · 备选模板</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">/Streaming/Channels/101</span></td>
                        </tr>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 pr-3 font-medium">海康 / Dahua</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">/ISAPI/Streaming/channels/101/picture</span></td>
                        </tr>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 pr-3 font-medium">Sigmastar</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">/snapshot.jpg</span></td>
                        </tr>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <td className="py-1.5 pr-3 font-medium">TP-Link / 水星</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">/cgi-bin/snapshot.cgi?channel=1</span></td>
                        </tr>
                        <tr>
                          <td className="py-1.5 pr-3 font-medium">雄迈 / 宇视</td>
                          <td className="py-1.5"><span className="font-mono text-slate-600 dark:text-slate-400">/cgi-bin/snapshot.cgi</span></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : cameraViewTab === 'settings' ? (
          <div className="flex-1 overflow-y-auto space-y-2.5 px-4 py-3">
            {(() => {
              const cam = (firstDevice as any)?.camera ?? null;
              const hasAudio = cam?.hasAudio === true || cam?.audioEnabled === true;
              const hasMotion = typeof cam?.lastMotionAt === 'string' || cam?.motionEnabled === true;
              const hasNight = cam?.hasNightVision === true || cam?.nightVision === true || cam?.nightMode === true;
              const hasRecording = cam?.recordingEnabled === true || cam?.storageEnabled === true || cam?.sdCard === true;
              const tone = (ok: boolean) =>
                ok
                  ? 'text-emerald-600 dark:text-emerald-400 border-emerald-400/50 bg-emerald-50/60 dark:bg-emerald-950/30'
                  : 'text-rose-600 dark:text-rose-400 border-rose-400/50 bg-rose-50/60 dark:bg-rose-950/30';
              return (
                <div className="w-full grid grid-cols-2 md:grid-cols-4 gap-1">
                  <div className="min-w-0">
                    <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] ${tone(hasAudio)}`}>
                      <Mic className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">录音</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] ${tone(hasMotion)}`}>
                      <BellRing className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">移动侦测</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] ${tone(hasNight)}`}>
                      <Moon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">夜视</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] ${tone(hasRecording)}`}>
                      <HardDrive className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">录像存储</span>
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="inline-flex flex-wrap items-center gap-2 text-[11px]">
              {currentStream?.hlsUrl ? (
                <Badge variant="success" className="w-fit text-[10px]">
                  实时流 已就绪
                </Badge>
              ) : euCameraLoginInfo?.loggedIn ? (
                <Badge variant="success" className="w-fit text-[10px]">
                  米家 EU 账号已登录 {euCameraLoginInfo.region || 'de'}
                  {euCameraLoginInfo.username ? ` · ${euCameraLoginInfo.username}` : ''}
                </Badge>
              ) : (
                <>
                  <Badge variant="outline" className="w-fit text-[10px] border-slate-300 text-slate-500">
                    尚未配置接入
                  </Badge>
                  <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
                    需要时展开下方接入配置。
                  </span>
                </>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              <div className="rounded-md border bg-muted/20">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/40"
                  onClick={() => setEuCameraLoginExpanded((v) => !v)}
                >
                  {euCameraLoginExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                  )}
                  🔐 米家 EU 官方接入
                {euCameraLoginInfo?.loggedIn ? (
                  <Badge variant="success" className="ml-2 text-[10px]">
                    已登录 {euCameraLoginInfo.region || 'de'}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="ml-2 text-[10px]">未登录</Badge>
                )}
                <div className="ml-auto inline-flex items-center gap-1">
                  <span className="text-[10px] text-slate-400 hidden sm:inline">C301 / MBCMC23 推荐</span>
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setHelpModalTopic('eu');
                          }}
                          className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <HelpCircle className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-[11px]">查看接入说明</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </button>
              {euCameraLoginExpanded ? (
                <div className="space-y-2.5 border-t px-3 py-3">
                  <div className="rounded-md border border-indigo-200/70 bg-indigo-50/70 px-3 py-2 text-[11px] leading-5 text-indigo-800 dark:border-indigo-800/60 dark:bg-indigo-950/30 dark:text-indigo-200">
                    欧区米家账号登录已经转移到「系统设置 {'>'} 设备同步 {'>'} 账号同步」统一管理。
                    <div className="mt-1.5 text-[10.5px] text-indigo-700/90 dark:text-indigo-300/90">
                      这里不再重复放账号、密码和验证码表单，登录后本摄像头会直接复用后台已建立的欧洲区会话。
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-[10.5px] text-muted-foreground">
                    当前会话状态：
                    {euCameraLoginInfo?.loggedIn
                      ? ` 已登录 ${euCameraLoginInfo.region ? `(${euCameraLoginInfo.region.toUpperCase()})` : ''}${euCameraLoginInfo.username ? ` · ${euCameraLoginInfo.username}` : ''}`
                      : ' 未登录'}
                  </div>
                </div>
              ) : null}
            </div>
              <div className="rounded-md border bg-muted/20">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/40"
                  onClick={() => setCameraManualExpanded((v) => !v)}
                >
                {cameraManualExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                )}
                🌐 纯局域网手动配置
                <div className="ml-auto inline-flex items-center gap-1">
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setHelpModalTopic('lan');
                          }}
                          className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <HelpCircle className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-[11px]">查看字段来源与品牌模板</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </button>
              {cameraManualExpanded ? (
                <div className="space-y-2.5 border-t px-3 py-3">
                  <div className="space-y-1.5">
                    <div className="space-y-1">
                      <Label htmlFor={`cam-manual-url-${room.key}`} className="text-[11px]">快照 URL</Label>
                      <Input
                        id={`cam-manual-url-${room.key}`}
                        size={16}
                        className="h-8 text-xs font-mono"
                        placeholder="rtsp://admin:xxx@192.168.x.x:554/live  或  http://192.168.x.x/cgi-bin/snapshot.cgi"
                        value={camManualSnapshotUrl}
                        onChange={(e) => setCamManualSnapshotUrl(e.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-1 space-y-1">
                        <Label htmlFor={`cam-manual-user-${room.key}`} className="text-[11px]">账号</Label>
                        <Input
                          id={`cam-manual-user-${room.key}`}
                          size={16}
                          className="h-8 text-xs"
                          placeholder="admin"
                          value={camManualAuthUsername}
                          onChange={(e) => setCamManualAuthUsername(e.target.value)}
                        />
                      </div>
                      <div className="col-span-1 space-y-1">
                        <Label htmlFor={`cam-manual-pass-${room.key}`} className="text-[11px]">密码</Label>
                        <Input
                          id={`cam-manual-pass-${room.key}`}
                          type="password"
                          size={16}
                          className="h-8 text-xs"
                          placeholder=""
                          value={camManualAuthPassword}
                          onChange={(e) => setCamManualAuthPassword(e.target.value)}
                        />
                      </div>
                      <div className="col-span-1 space-y-1">
                        <Label htmlFor={`cam-manual-auth-${room.key}`} className="text-[11px]">鉴权</Label>
                        <Select value={camManualAuthType} onValueChange={(v) => setCamManualAuthType(v as any)}>
                          <SelectTrigger id={`cam-manual-auth-${room.key}`} className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="digest">Digest</SelectItem>
                            <SelectItem value="basic">Basic</SelectItem>
                            <SelectItem value="none">无</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`cam-manual-brand-${room.key}`} className="text-[11px]">厂商</Label>
                        <Input
                          id={`cam-manual-brand-${room.key}`}
                          size={16}
                          className="h-8 text-xs"
                          placeholder="Xiaomi / Hikvision"
                          value={camManualBrand}
                          onChange={(e) => setCamManualBrand(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`cam-manual-model-${room.key}`} className="text-[11px]">型号</Label>
                        <Input
                          id={`cam-manual-model-${room.key}`}
                          size={16}
                          className="h-8 text-xs"
                          placeholder="C301 / MBCMC23"
                          value={camManualModel}
                          onChange={(e) => setCamManualModel(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-[11px]"
                      onClick={() => setCameraDetailOpen(false)}
                    >
                      关闭
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 bg-indigo-600 text-[11px] hover:bg-indigo-700"
                      onClick={handleSaveCameraManual}
                      disabled={savingCameraManual || !deviceDid}
                    >
                      <RefreshCw className="mr-1 h-3 w-3" />
                      {savingCameraManual ? '保存中...' : '保存并刷新快照'}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-2.5 px-4 py-3 overflow-hidden">
            <div className="rounded-md border bg-slate-950/90 flex-1 min-h-0 flex items-stretch justify-stretch overflow-hidden">
              <div className="relative w-full h-full flex items-center justify-center">
                {currentStream?.hlsUrl ? (
                  <video
                    ref={hlsVideoRef}
                    autoPlay
                    muted
                    playsInline
                    controls
                    className="h-full w-full object-contain"
                    style={{ background: '#000' }}
                  />
                ) : cameraSnapshotLargeUrl ? (
                  <img
                    key={cameraSnapshotLargeUrl}
                    src={cameraSnapshotLargeUrl}
                    alt={room.title + ' 实时快照'}
                    className="h-full w-full object-contain"
                    onError={() => {}}
                  />
                ) : (
                  <div className="flex w-full flex-col items-center justify-center gap-2 py-6 text-center text-xs leading-5">
                    {startStreamError ? (
                      <div className="rounded border border-red-500/40 bg-red-950/30 px-3 py-2 text-red-200 break-all max-w-[90%]">
                        {startStreamError}
                      </div>
                    ) : (
                      <div className="text-slate-400">
                        <div className="text-slate-200/80">暂无可渲染的画面</div>
                        <div className="text-[10.5px] mt-0.5 text-slate-500">右上角「⚙ 设置」→ 接入账号或填快照 URL</div>
                      </div>
                    )}
                    <Button
                      size="sm"
                      className={cn(
                        'h-8 mt-1 text-[11px] bg-indigo-600 hover:bg-indigo-700',
                        (!deviceDid || !canControl) && 'opacity-50 pointer-events-none',
                      )}
                      onClick={startCameraStream}
                      disabled={openStreamLoading || !deviceDid || !canControl}
                    >
                      {openStreamLoading ? (
                        <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <CameraIcon className="mr-1 h-3 w-3" />
                      )}
                      {openStreamLoading ? '拉流中...' : '开启实时流'}
                    </Button>
                    {currentStream?.ffmpegAvailable === false ? (
                      <div className="text-[10px] text-amber-400 mt-1 max-w-[90%]">
                        ⚠ 服务器未检测到 ffmpeg，无法自动转码。
                      </div>
                    ) : null}
                  </div>
                )}
                {currentStream?.hlsUrl ? (
                  <div className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-[11px] font-medium text-emerald-100">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE · {currentStream.proxyMode || 'HLS'}
                    {typeof currentStream.processId === 'number' ? ` · pid ${currentStream.processId}` : ''}
                  </div>
                ) : cameraSnapshotLargeUrl ? (
                  <div className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-[11px] font-medium text-rose-100">
                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                    LIVE · 快照 10s 刷新
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
              <div className="inline-flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-7 rounded-md px-2 text-[11px]',
                    streamQuality === 'hd' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-800/50' : '',
                  )}
                  onClick={() => setStreamQuality('hd')}
                >
                  <Monitor className="mr-1 h-3.5 w-3.5" /> HD
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-7 rounded-md px-2 text-[11px]',
                    streamQuality === 'sd' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-800/50' : '',
                  )}
                  onClick={() => setStreamQuality('sd')}
                >
                  <Monitor className="mr-1 h-3.5 w-3.5" /> SD
                </Button>
                <div className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setCamSwitches((s) => ({ ...s, motion: !s.motion }))}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10.5px] transition-colors',
                          camSwitches.motion
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-400/60 text-emerald-700 dark:text-emerald-300'
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300',
                        )}
                      >
                        <BellRing className="h-3.5 w-3.5" />
                        人形侦测
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[11px]">
                      {camSwitches.motion ? '已开启移动侦测推送' : '未开启移动侦测'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setCamSwitches((s) => ({ ...s, night: !s.night }))}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10.5px] transition-colors',
                          camSwitches.night
                            ? 'bg-indigo-950/80 dark:bg-indigo-950/60 border-indigo-400/60 text-indigo-100'
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300',
                        )}
                      >
                        <Moon className="h-3.5 w-3.5" />
                        夜视
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[11px]">
                      {camSwitches.night ? '夜视模式 · 红外/全彩' : '自动切换夜视'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setCamSwitches((s) => ({ ...s, audio: !s.audio }))}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10.5px] transition-colors',
                          camSwitches.audio
                            ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-400/60 text-amber-700 dark:text-amber-300'
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300',
                        )}
                      >
                        {camSwitches.audio ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
                        语音
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[11px]">
                      {camSwitches.audio ? '对讲 / 语音已开启' : '关闭拾音与对讲'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setCamSwitches((s) => ({ ...s, privacy: !s.privacy }))}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10.5px] transition-colors',
                          camSwitches.privacy
                            ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-400/60 text-rose-700 dark:text-rose-300'
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300',
                        )}
                      >
                        {camSwitches.privacy ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        遮挡
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-[11px]">
                      {camSwitches.privacy ? '物理遮挡 / 隐私模式' : '正常画面'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="inline-flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-md px-2 text-[11px]"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCameraSnapshotBump((prev) => prev + 1);
                  }}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新快照
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 rounded-md px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleTakeEvidenceSnapshot();
                  }}
                  disabled={takeSnapshotLoading || !deviceDid}
                >
                  {takeSnapshotLoading ? (
                    <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Image className="mr-1 h-3.5 w-3.5" />
                  )}
                  临时截图
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-md px-2 text-[11px]"
                  onClick={startCameraStream}
                  disabled={openStreamLoading}
                >
                  <RefreshCw className={cn('mr-1 h-3 w-3', openStreamLoading && 'animate-spin')} />
                  重连流
                </Button>
              </div>
            </div>

            <div className="shrink-0 rounded-md border bg-slate-50 dark:bg-slate-900/40 p-2.5 flex flex-wrap items-center justify-center gap-5">
              <div className="flex flex-col items-center justify-center">
                <Badge variant="outline" className="mb-2 text-[10px] border-slate-300 text-slate-500">
                  按下持续移动 · 松开停止
                </Badge>
                <div className="relative w-[232px] h-[232px] rounded-full border-2 border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/80 shadow-inner">
                  {([
                    { key: 'up', x: 50, y: 8, dir: 'up' as const, label: '↑', disabled: false },
                    { key: 'up-right', x: 84, y: 20, dir: 'up-right' as const, label: '↗', disabled: true },
                    { key: 'right', x: 92, y: 50, dir: 'right' as const, label: '→', disabled: false },
                    { key: 'down-right', x: 84, y: 80, dir: 'down-right' as const, label: '↘', disabled: true },
                    { key: 'down', x: 50, y: 92, dir: 'down' as const, label: '↓', disabled: false },
                    { key: 'down-left', x: 16, y: 80, dir: 'down-left' as const, label: '↙', disabled: true },
                    { key: 'left', x: 8, y: 50, dir: 'left' as const, label: '←', disabled: false },
                    { key: 'up-left', x: 16, y: 20, dir: 'up-left' as const, label: '↖', disabled: true },
                  ] as const).map((p) => {
                    const btnCls = cn(
                      'absolute h-10 w-10 rounded-full text-lg font-bold transition-colors select-none -translate-x-1/2 -translate-y-1/2 flex items-center justify-center',
                      p.disabled
                        ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 opacity-60 cursor-not-allowed'
                        : 'bg-indigo-500 hover:bg-indigo-600 active:bg-indigo-700 text-white',
                    );
                    const diagsDisabled = p.disabled || !canControl || !deviceDid || ptzLoading;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        disabled={diagsDisabled}
                        className={btnCls}
                        style={{ left: `${p.x}%`, top: `${p.y}%` }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (p.disabled) return;
                          if (p.dir.endsWith('left')) handleCameraPTZ('left');
                          else if (p.dir.endsWith('right')) handleCameraPTZ('right');
                          if (p.dir.startsWith('up')) handleCameraPTZ('up');
                          else if (p.dir.startsWith('down')) handleCameraPTZ('down');
                        }}
                        onMouseUp={(e) => {
                          e.preventDefault();
                          if (p.disabled) return;
                          handleCameraPTZ('stop');
                        }}
                        onMouseLeave={() => {
                          if (p.disabled) return;
                          handleCameraPTZ('stop');
                        }}
                        onTouchStart={(e) => {
                          e.preventDefault();
                          if (p.disabled) return;
                          if (p.dir.endsWith('left')) handleCameraPTZ('left');
                          else if (p.dir.endsWith('right')) handleCameraPTZ('right');
                          if (p.dir.startsWith('up')) handleCameraPTZ('up');
                          else if (p.dir.startsWith('down')) handleCameraPTZ('down');
                        }}
                        onTouchEnd={(e) => {
                          e.preventDefault();
                          if (p.disabled) return;
                          handleCameraPTZ('stop');
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    disabled={!canControl || !deviceDid || ptzLoading}
                    className={cn(
                      'absolute h-[96px] w-[96px] rounded-full text-sm font-bold transition-colors select-none -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center gap-0.5',
                      'bg-indigo-700 hover:bg-indigo-800 active:bg-indigo-900 text-white shadow-md',
                      (!canControl || !deviceDid) && 'opacity-60 cursor-not-allowed',
                    )}
                    style={{ left: '50%', top: '50%' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCameraPTZ('stop');
                    }}
                    title="回到居中位置"
                  >
                    <ShieldAlert className="h-4 w-4" />
                    <span>居中</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>

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
