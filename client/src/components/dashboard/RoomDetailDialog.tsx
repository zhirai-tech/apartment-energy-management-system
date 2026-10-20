import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Activity,
  ArrowLeft,
  BellRing,
  Camera as CameraIcon,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  HardDrive,
  HelpCircle,
  Image,
  Mic,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { cn } from '../../lib/utils';
import { system } from '../../lib/api';
import type { CameraCapabilities, CameraCapabilityState, CameraScheduleRule } from '../../lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { useXiaomiRememberedCredentials } from '../../hooks/useXiaomiRememberedCredentials';
import type { DashboardSpaceCard } from './RoomsGrid';
import type { DeviceItem } from '../../types';

interface RoomDetailDialogProps {
  room: DashboardSpaceCard;
  firstDevice: DeviceItem | undefined;
  deviceDid: string;
  canControl: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存手动配置/重连流后通知卡片刷新缩略图 */
  onSnapshotBump: () => void;
  /** 卡片共用的"取证截图"（操作 RoomCard 内的 takeSnapshotLoading 状态） */
  onTakeSnapshot: () => void;
  takeSnapshotLoading: boolean;
}

// 摄像头实时监控 / 录像管理 / 能力控制详情对话框（自 RoomCard 拆出的独立组件）
export function RoomDetailDialog({
  room,
  firstDevice,
  deviceDid,
  canControl,
  open,
  onOpenChange,
  onSnapshotBump,
  onTakeSnapshot,
  takeSnapshotLoading,
}: RoomDetailDialogProps) {
  const queryClient = useQueryClient();
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
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingLoading, setRecordingLoading] = useState(false);
  // 摄像头能力自识别（识别到显示对应按钮，识别不到降级提示）
  const [cameraCaps, setCameraCaps] = useState<CameraCapabilities | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  // 录制模式：motion 智能侦测 / continuous 连续定时
  const [recMode, setRecMode] = useState<'motion' | 'person' | 'continuous'>('motion');
  const [continuousMinutes, setContinuousMinutes] = useState(30);
  // 录像文件列表
  const [recordings, setRecordings] = useState<Array<{ name: string; size: number; mtime: number; url: string }>>([]);
  // 智能侦测灵敏度设置
  const [motionSettings, setMotionSettings] = useState<{ threshold: number; tailSeconds: number; ringSeconds: number } | null>(null);
  // 录制计划（自动布防）
  const [schedules, setSchedules] = useState<CameraScheduleRule[]>([]);
  const [schedDraft, setSchedDraft] = useState<{
    mode: 'motion' | 'continuous';
    days: number[];
    start: string;
    end: string;
  }>({ mode: 'motion', days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '20:00' });
  // 录像与布防面板（默认折叠，避免挤压视频区域）
  const [recordingPanelOpen, setRecordingPanelOpen] = useState(false);
  // 视频流自动重连（epoch 递增触发重新拉流）
  const [streamEpoch, setStreamEpoch] = useState(0);
  // 视频黑屏时显示实时快照兜底
  const [streamVideoBroken, setStreamVideoBroken] = useState(false);
  const [snapshotFallbackUrl, setSnapshotFallbackUrl] = useState('');
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (!open) return;
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
  }, [open, firstDevice]);

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
      onSnapshotBump();

      toast.success('摄像头快照配置已保存');
    } catch {
      toast.error('保存摄像头快照配置失败');
    } finally {
      setSavingCameraManual(false);
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

  const startCameraStream = async (fresh = false) => {
    if (!deviceDid) return;
    try {
      setOpenStreamLoading(true);
      setStartStreamError('');
      const res = await system.getCameraStream(deviceDid, fresh ? { fresh: true } : undefined);
      if (!res.hlsUrl) {
        setStartStreamError(res.errorMessage || '开启视频流失败');
        return;
      }
      // 后端已等待 ffmpeg 真实出流；hlsReady 为 false 时表示实时流未建立，
      // 直接提示离线，绝不播放残留的旧录像文件
      if (res.hlsReady !== true) {
        setStartStreamError(res.errorMessage || '实时流未建立（可能摄像头离线或云端 RTSP 不可用）');
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
      if (res.proxyMode === 'none') {
        setStartStreamError(res.errorMessage || '视频流代理未就绪');
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
    if (!open) return;
    if (cameraViewTab !== 'live') return;
    if (currentStream?.hlsUrl || openStreamLoading) return;
    startCameraStream(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cameraViewTab, streamEpoch]);

  useEffect(() => {
    if (!open) return;
    if (cameraViewTab !== 'live') return;
    if (currentStream?.hlsUrl || openStreamLoading || !startStreamError) return;
    const t = setTimeout(() => setStreamEpoch((e) => e + 1), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cameraViewTab, currentStream?.hlsUrl, openStreamLoading, startStreamError]);

  useEffect(() => {
    if (!open) return;
    if (cameraViewTab !== 'live') return;
    if (currentStream?.hlsUrl && !streamVideoBroken) return;
    if (!deviceDid) return;
    let stopped = false;
    const refresh = () => {
      if (stopped) return;
      setSnapshotFallbackUrl(system.getDeviceSnapshotUrl(deviceDid, { fresh: true }));
    };
    refresh();
    const t = setInterval(refresh, 4000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cameraViewTab, deviceDid, currentStream?.hlsUrl, streamVideoBroken]);

  useEffect(() => {
    if (!open) return;
    if (cameraViewTab !== 'live' || !currentStream?.hlsUrl || !hlsVideoRef.current) return;
    const videoEl = hlsVideoRef.current;
    const hlsUrl = currentStream.hlsUrl;
    let destroyed = false;
    const run = async () => {
      const canNative = typeof videoEl.canPlayType === 'function' && videoEl.canPlayType('application/vnd.apple.mpegurl');
      // 优先 hls.js（MSE）；桌面 Chrome 原生 HLS 解码 MPEG-TS 常报 DEMUXER_ERROR 黑屏
      let Hls: any = null;
      try {
        Hls = (await import('hls.js')).default;
      } catch {
        Hls = null;
      }
      const hlsSupported = !!(Hls && typeof Hls.isSupported === 'function' && Hls.isSupported());
      if (!hlsSupported) {
        if (canNative) {
          videoEl.src = hlsUrl;
          try { await videoEl.play(); } catch {}
          setStreamVideoBroken(false);
        } else {
          setStartStreamError('当前浏览器不支持 HLS 播放');
        }
        return;
      }
      try {
        if (!Hls || !hlsSupported) {
          setStartStreamError('当前浏览器不支持 HLS 播放');
          return;
        }
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
          // 云端 CDN 间歇性拒连：加大重试次数、缩短退避，让 hls.js 在会话内自行恢复，
          // 避免一抖动就销毁重建会话（新建会话反而会打断正在播放的旧流）。
          manifestLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 400,
        });
        if (destroyed) return;
        hlsInstanceRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoEl);
        let fatalRecovers = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play().catch(() => {});
          setStreamVideoBroken(false);
        });
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data || !data.fatal) return;
          // 先尝试会话内恢复（网络抖动可自行续传），连续失败才重建会话
          if (fatalRecovers < 2) {
            fatalRecovers += 1;
            try {
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              else hls.startLoad();
            } catch {}
            return;
          }
          setStartStreamError(`HLS 播放错误：${data.type || ''} ${data.details || ''}`);
          armSnapshotFallback();
          scheduleStreamReconnect();
        });
      } catch (err) {
        setStartStreamError(err instanceof Error ? err.message : 'HLS 初始化失败');
      }
    };
    // video 元素事件兜底：error 立即重连；stalled 仅当持续 8s 无数据才重连，
    // 短时网络抖动交给 hls.js 自动重试，避免把瞬断放大成 5s 黑屏。
    let stallSince = 0;
    const onVideoError = () => {
      setStartStreamError('视频流中断，正在自动重连...');
      armSnapshotFallback();
      scheduleStreamReconnect();
    };
    const onStalled = () => {
      if (videoEl.readyState >= 2) return;
      const now = Date.now();
      if (!stallSince) stallSince = now;
      else if (now - stallSince > 8000) {
        stallSince = 0;
        scheduleStreamReconnect();
      }
    };
    const onPlaying = () => {
      stallSince = 0;
    };
    videoEl.addEventListener('error', onVideoError);
    videoEl.addEventListener('stalled', onStalled);
    videoEl.addEventListener('playing', onPlaying);
    run();
    return () => {
      destroyed = true;
      videoEl.removeEventListener('error', onVideoError);
      videoEl.removeEventListener('stalled', onStalled);
      videoEl.removeEventListener('playing', onPlaying);
      stopHls();
    };
  }, [open, cameraViewTab, currentStream?.hlsUrl]);

  useEffect(() => {
    if (open) return;
    stopHls();
    setCurrentStream(null);
    setStartStreamError('');
    setOpenStreamLoading(false);
    setStreamVideoBroken(false);
    setSnapshotFallbackUrl('');
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, [open]);

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

  const loadCameraCapabilities = async () => {
    if (!deviceDid) return;
    try {
      setCapLoading(true);
      const caps = await system.getCameraCapabilities(deviceDid);
      setCameraCaps(caps);
    } catch {
      setCameraCaps(null);
    } finally {
      setCapLoading(false);
    }
  };

  const loadRecordingsList = async () => {
    if (!deviceDid) return;
    try {
      const res = await system.listCameraRecordings(deviceDid);
      setRecordings(res.files ?? []);
    } catch { /* noop */ }
  };

  const loadCameraSchedules = async () => {
    if (!deviceDid) return;
    try {
      const res = await system.listCameraSchedules(deviceDid);
      setSchedules(res.schedules ?? []);
    } catch { /* noop */ }
  };

  const loadMotionSettingsData = async () => {
    try {
      const s = await system.getCameraMotionSettings();
      setMotionSettings(s);
    } catch { /* noop */ }
  };

  // 视频流自动重连：HLS fatal / video error / stalled 时重新拉流（最多 3 次）
  const scheduleStreamReconnect = () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (reconnectAttemptRef.current >= 3) {
      reconnectAttemptRef.current = 0;
      return;
    }
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      stopHls();
      setCurrentStream(null);
      setStartStreamError('');
      armSnapshotFallback();
      setStreamEpoch((e) => e + 1);
    }, 2000);
  };

  // 视频黑屏时叠加快照兜底，保证"有画面"
  const armSnapshotFallback = () => {
    setStreamVideoBroken(true);
    if (deviceDid) {
      setSnapshotFallbackUrl(system.getDeviceSnapshotUrl(deviceDid, { fresh: true }));
    }
  };

  const handleCameraCalibrate = async () => {
    if (!deviceDid || !canControl) return;
    try {
      setPtzLoading(true);
      await system.controlCameraPTZ(deviceDid, 'calibrate', 0);
      toast.success('已发送云台回中指令');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '云台回中失败');
    } finally {
      setPtzLoading(false);
    }
  };

  const refreshRecordings = async () => {
    if (!deviceDid) return;
    try {
      const status = await system.getCameraRecordingStatus(deviceDid);
      setRecordingActive(status.recording);
      if (status.mode === 'motion' || status.mode === 'person' || status.mode === 'continuous') setRecMode(status.mode);
    } catch {
      /* noop */
    }
  };

  const handleToggleRecording = async () => {
    if (!deviceDid || !canControl) return;
    try {
      setRecordingLoading(true);
      if (recordingActive) {
        await system.stopCameraRecording(deviceDid);
        setRecordingActive(false);
        toast.success('已停止录制');
      } else {
        const opts =
          recMode === 'continuous'
            ? { mode: 'continuous' as const, segmentMinutes: continuousMinutes }
            : { mode: 'motion' as const };
        const res = await system.startCameraRecording(deviceDid, opts);
        if (res.recording) {
          setRecordingActive(true);
          toast.success(res.mode === 'continuous' ? '已开启连续录制' : '已开启智能侦测录制');
        } else {
          toast.error(res.errorMessage || '开启录制失败');
        }
      }
      await refreshRecordings();
      await loadRecordingsList();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '录制操作失败');
    } finally {
      setRecordingLoading(false);
    }
  };

  const handleSaveSchedule = async () => {
    if (!deviceDid || !canControl) return;
    if (!schedDraft.start || !schedDraft.end || schedDraft.days.length === 0) {
      toast.error('请选择时间段与星期');
      return;
    }
    try {
      await system.upsertCameraSchedule({
        did: deviceDid,
        mode: schedDraft.mode,
        days: schedDraft.days,
        start: schedDraft.start,
        end: schedDraft.end,
      });
      toast.success('录制计划已保存，到点自动布防');
      await loadCameraSchedules();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存计划失败');
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    if (!canControl) return;
    try {
      await system.deleteCameraSchedule(id);
      toast.success('已删除录制计划');
      await loadCameraSchedules();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除计划失败');
    }
  };

  const handleDeleteRecording = async (name: string) => {
    if (!deviceDid || !canControl) return;
    try {
      await system.deleteCameraRecording(deviceDid, name);
      toast.success('已删除录像');
      await loadRecordingsList();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除录像失败');
    }
  };

  // 通用能力控制：仅对后端探测为可控的能力下发（不可控能力前端不渲染可点击按钮）
  const controlCameraCap = async (capability: string) => {
    if (!deviceDid || !canControl) return;
    try {
      await system.controlCameraCapability(deviceDid, capability);
      toast.success('控制指令已下发');
      await loadCameraCapabilities();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '控制失败');
    }
  };

  const fmtFileSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const fmtRecordingTime = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '--';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const saveMotionSetting = async (data: { threshold: number }) => {
    if (!canControl) return;
    try {
      const s = await system.updateCameraMotionSettings(data);
      setMotionSettings(s);
      toast.success('灵敏度已保存，下次开启侦测录制生效');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存灵敏度失败');
    }
  };

  useEffect(() => {
    if (!open) return;
    refreshRecordings();
    void loadCameraCapabilities();
    void loadCameraSchedules();
    void loadMotionSettingsData();
    void loadRecordingsList();
    // 详情打开期间轮询刷新，保证录制按钮状态实时同步
    const timer = setInterval(() => {
      refreshRecordings();
      void loadRecordingsList();
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
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
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-400/50 bg-emerald-50/60 px-2 py-1 text-[11px] text-emerald-600 dark:border-emerald-400/50 dark:bg-emerald-950/30 dark:text-emerald-400"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{label}</span>
                    </div>
                  ))}
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
                      onClick={() => onOpenChange(false)}
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
            <div className="rounded-md border bg-slate-950/90 flex-1 min-h-[240px] flex items-stretch justify-stretch overflow-hidden">
              <div className="relative w-full h-full flex items-center justify-center">
                {currentStream?.hlsUrl ? (
                  <div className="relative h-full w-full">
                    <video
                      ref={hlsVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="h-full w-full object-contain"
                      style={{ background: '#000' }}
                      onError={() => {
                        setStartStreamError('视频流中断，摄像头可能已离线');
                        armSnapshotFallback();
                        setCurrentStream(null);
                        if (hlsVideoRef.current) {
                          try {
                            hlsVideoRef.current.pause();
                            hlsVideoRef.current.removeAttribute('src');
                            hlsVideoRef.current.load();
                          } catch {}
                        }
                      }}
                    />
                    {streamVideoBroken ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-slate-950">
                        {snapshotFallbackUrl ? (
                          <img
                            src={snapshotFallbackUrl}
                            alt="实时快照"
                            className="h-full w-full object-contain"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : null}
                        <div className="pointer-events-none absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded bg-black/70 px-2 py-1 text-[10.5px] text-amber-200">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          实时流信号中断 · 自动重连中
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 py-6 text-center text-xs leading-5">
                    {snapshotFallbackUrl ? (
                      <img
                        src={snapshotFallbackUrl}
                        alt="实时快照"
                        className="absolute inset-0 h-full w-full object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.visibility = 'hidden';
                        }}
                      />
                    ) : null}
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 py-6 text-center text-xs leading-5">
                      {openStreamLoading ? (
                        <div className="flex items-center gap-2 text-slate-400">
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          正在拉取实时流…
                        </div>
                      ) : startStreamError ? (
                        <div className="rounded border border-red-500/40 bg-black/55 px-3 py-2 text-red-200 break-all max-w-[90%] backdrop-blur-sm">
                          {startStreamError}
                        </div>
                      ) : (
                        <div className="rounded bg-black/45 px-3 py-1.5 text-slate-300 backdrop-blur-sm">
                          暂无可渲染的画面
                        </div>
                      )}
                      <Button
                        size="sm"
                        className={cn(
                          'h-8 mt-1 text-[11px] bg-indigo-600 hover:bg-indigo-700',
                          (!deviceDid || !canControl) && 'opacity-50 pointer-events-none',
                        )}
                        onClick={() => void startCameraStream()}
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
                  </div>
                )}
                {currentStream?.hlsUrl ? (
                  <div className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-[11px] font-medium text-emerald-100">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE · {currentStream.proxyMode || 'HLS'}
                    {typeof currentStream.processId === 'number' ? ` · pid ${currentStream.processId}` : ''}
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
                {(() => {
                  // 能力自识别：识别到（supported）→ 显示；可控 → 真按钮；不可控 → 虚线灰态（hover 显示原因）
                  const caps = cameraCaps;
                  const items = ([
                    { key: 'humanDetection', label: '人形识别', cap: caps?.humanDetection, Icon: BellRing },
                    { key: 'faceRecognition', label: '人脸识别', cap: caps?.faceRecognition, Icon: Users },
                    { key: 'motionDetection', label: '动态识别', cap: caps?.motionDetection, Icon: Activity },
                    { key: 'nightVision', label: '夜视', cap: caps?.nightVision, Icon: Moon },
                    { key: 'audio', label: '语音', cap: caps?.audio, Icon: Mic },
                    { key: 'privacy', label: '遮挡', cap: caps?.privacy, Icon: Eye },
                  ] as Array<{ key: string; label: string; cap: CameraCapabilityState | undefined; Icon: any }>).filter(
                    (it): it is { key: string; label: string; cap: CameraCapabilityState; Icon: any } => !!it.cap?.supported,
                  );
                  if (capLoading) {
                    return <span className="text-[10.5px] text-slate-400">能力探测中…</span>;
                  }
                  if (items.length === 0) return null;
                  return (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {items.map(({ key, label, cap, Icon }) =>
                        cap.controllable ? (
                          <TooltipProvider key={key} delayDuration={150}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  disabled={!canControl || !deviceDid}
                                  onClick={() => void controlCameraCap(key)}
                                  className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-400/60 bg-emerald-50 px-2 text-[10.5px] text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 disabled:opacity-50"
                                >
                                  <Icon className="h-3.5 w-3.5" />
                                  {label}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="text-[11px]">
                                设备支持此功能，点击下发控制指令
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <TooltipProvider key={key} delayDuration={150}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex h-7 cursor-default items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[10.5px] text-slate-400 dark:border-slate-600 dark:text-slate-500">
                                  <Icon className="h-3.5 w-3.5" />
                                  {label}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
                                {cap.hint || '设备支持，但当前接入方式暂不可控'}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ),
                      )}
                    </div>
                  );
                })()}
              </div>
              <div className="inline-flex flex-wrap items-center gap-1.5">
                <Select
                  value={recMode}
                  onValueChange={(v) => setRecMode(v as 'motion' | 'person' | 'continuous')}
                  disabled={recordingActive || !canControl}
                >
                  <SelectTrigger className="h-7 w-auto gap-1 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="motion">智能侦测</SelectItem>
                    <SelectItem value="continuous">连续定时</SelectItem>
                  </SelectContent>
                </Select>
                {recMode === 'continuous' ? (
                  <Select
                    value={String(continuousMinutes)}
                    onValueChange={(v) => setContinuousMinutes(Number(v) || 30)}
                    disabled={recordingActive || !canControl}
                  >
                    <SelectTrigger className="h-7 w-auto gap-1 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="15">15 分/段</SelectItem>
                      <SelectItem value="30">30 分/段</SelectItem>
                      <SelectItem value="60">60 分/段</SelectItem>
                      <SelectItem value="120">120 分/段</SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
                <Button
                  size="sm"
                  variant="default"
                  className={cn(
                    'h-7 rounded-md px-2 text-[11px]',
                    recordingActive ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700',
                  )}
                  disabled={!canControl || !deviceDid || recordingLoading}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleToggleRecording();
                  }}
                >
                  {recordingLoading ? (
                    <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <HardDrive className="mr-1 h-3.5 w-3.5" />
                  )}
                  {recordingActive ? '停止录制' : '开始录制'}
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 rounded-md px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onTakeSnapshot();
                  }}
                  disabled={takeSnapshotLoading || !deviceDid}
                >
                  {takeSnapshotLoading ? (
                    <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Image className="mr-1 h-3.5 w-3.5" />
                  )}
                  截图
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-md px-2 text-[11px]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSnapshotBump();
                    void startCameraStream(true);
                  }}
                  disabled={openStreamLoading}
                >
                  <RefreshCw className={cn('mr-1 h-3 w-3', openStreamLoading && 'animate-spin')} />
                  重连流
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={cn(
                    'h-7 rounded-md px-2 text-[11px]',
                    recordingPanelOpen && 'border-indigo-400/60 text-indigo-600 dark:text-indigo-300',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRecordingPanelOpen((v) => !v);
                  }}
                >
                  <ChevronDown className={cn('mr-1 h-3 w-3 transition-transform', recordingPanelOpen && 'rotate-180')} />
                  录像管理
                </Button>
              </div>
            </div>

            <div className="shrink-0 rounded-md border bg-slate-50 dark:bg-slate-900/40 p-3 flex flex-wrap items-center justify-center gap-3">
              {(() => {
                // 能力自识别：云台方向识别到（directions 非空）才显示方向盘，否则降级为"仅回中"
                const ptz = cameraCaps?.ptz;
                const hasDirections = !!ptz?.supported && ptz.directions.length > 0;
                if (hasDirections) {
                  const dirBtn = (dir: 'up' | 'down' | 'left' | 'right', glyph: string, title: string) => (
                    <button
                      type="button"
                      key={dir}
                      title={title}
                      disabled={!canControl || !deviceDid || ptzLoading}
                      onMouseDown={() => { void system.controlCameraPTZ(deviceDid, dir, 50); }}
                      onMouseUp={() => { void system.controlCameraPTZ(deviceDid, 'stop', 0); }}
                      onMouseLeave={() => { void system.controlCameraPTZ(deviceDid, 'stop', 0); }}
                      className="h-8 w-8 rounded-md border border-slate-300 bg-white text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      {glyph}
                    </button>
                  );
                  return (
                    <div className="flex items-center gap-3">
                      <div className="grid grid-cols-3 gap-1">
                        <div />
                        {dirBtn('up', '↑', '向上')}
                        <div />
                        {dirBtn('left', '←', '向左')}
                        <button
                          type="button"
                          title="停止"
                          disabled={!canControl || !deviceDid || ptzLoading}
                          onClick={() => { void system.controlCameraPTZ(deviceDid, 'stop', 0); }}
                          className="h-8 w-8 rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400"
                        >
                          ●
                        </button>
                        {dirBtn('right', '→', '向右')}
                        <div />
                        {dirBtn('down', '↓', '向下')}
                        <div />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          disabled={!canControl || !deviceDid || ptzLoading}
                          onClick={handleCameraCalibrate}
                          title="云台回中 / 校准"
                        >
                          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', ptzLoading && 'animate-spin')} />
                          回中 / 校准
                        </Button>
                        <span className="text-[9.5px] text-slate-400">按住方向键转动，松开停止</span>
                      </div>
                    </div>
                  );
                }
                return (
                  <>
                    <Badge variant="outline" className="text-[10px] border-slate-300 text-slate-500">
                      {ptz?.supported ? (ptz.hint || '方向控制不可用') : '云台控制不可用'}
                    </Badge>
                    {ptz?.supported && ptz.calibrate ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!canControl || !deviceDid || ptzLoading}
                        onClick={handleCameraCalibrate}
                        title="云台回中 / 校准"
                      >
                        <RefreshCw className={cn('mr-1 h-4 w-4', ptzLoading && 'animate-spin')} />
                        回中 / 校准
                      </Button>
                    ) : null}
                  </>
                );
              })()}
            </div>

            {recordingPanelOpen ? (
              <>
            {/* 智能侦测设置（灵敏度 / 预录 / 尾留） */}
            {motionSettings ? (
              <div className="shrink-0 rounded-md border bg-slate-50 dark:bg-slate-900/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">智能侦测设置</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10.5px]"
                    onClick={() => void loadMotionSettingsData()}
                  >
                    <RefreshCw className="mr-1 h-3 w-3" /> 刷新
                  </Button>
                </div>
                <div className="mt-1.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10.5px] text-slate-500">灵敏度</span>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      value={Math.round(motionSettings.threshold * 100)}
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100;
                        setMotionSettings((s) => (s ? { ...s, threshold: v } : s));
                      }}
                      onMouseUp={() => void saveMotionSetting({ threshold: motionSettings.threshold })}
                      onTouchEnd={() => void saveMotionSetting({ threshold: motionSettings.threshold })}
                      className="h-1.5 flex-1 cursor-pointer accent-indigo-600"
                    />
                    <span className="w-12 shrink-0 text-right text-[10px] text-slate-500">
                      {Math.round(motionSettings.threshold * 100)}/100
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10.5px] text-slate-500">预录</span>
                    <Select
                      value={String(motionSettings.ringSeconds)}
                      onValueChange={(v) => {
                        const ringSeconds = Number(v) || 60;
                        setMotionSettings((s) => (s ? { ...s, ringSeconds } : s));
                        void system.updateCameraMotionSettings({ ringSeconds });
                      }}
                    >
                      <SelectTrigger className="h-7 w-auto gap-1 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30">30 秒</SelectItem>
                        <SelectItem value="60">60 秒</SelectItem>
                        <SelectItem value="120">120 秒</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-[10px] text-slate-400">动作前预录时长</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10.5px] text-slate-500">尾留</span>
                    <Select
                      value={String(motionSettings.tailSeconds)}
                      onValueChange={(v) => {
                        const tailSeconds = Number(v) || 60;
                        setMotionSettings((s) => (s ? { ...s, tailSeconds } : s));
                        void system.updateCameraMotionSettings({ tailSeconds });
                      }}
                    >
                      <SelectTrigger className="h-7 w-auto gap-1 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30">30 秒</SelectItem>
                        <SelectItem value="60">60 秒</SelectItem>
                        <SelectItem value="120">120 秒</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-[10px] text-slate-400">动作后延续保存</span>
                  </div>
                </div>
              </div>
            ) : null}

            {/* 录制管理：录像回放 */}
            <div className="shrink-0 rounded-md border bg-slate-50 dark:bg-slate-900/40 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
                  录像回放（{recordings.length}）
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10.5px]"
                  onClick={() => void loadRecordingsList()}
                >
                  <RefreshCw className="mr-1 h-3 w-3" /> 刷新
                </Button>
              </div>
              {recordings.length === 0 ? (
                <div className="mt-1.5 text-[10.5px] leading-4 text-slate-400">
                  暂无录像。智能侦测模式：画面有动静才保存片段；连续定时模式：按设定时段全程录制，自动保留 7 天（可在服务器环境变量 CAMERA_RETENTION_DAYS 调整）。
                </div>
              ) : (
                <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                  {recordings.map((r) => (
                    <div
                      key={r.name}
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[10.5px] text-slate-700 dark:text-slate-200">{r.name}</div>
                        <div className="text-[9.5px] text-slate-400">
                          {fmtFileSize(r.size)} · {fmtRecordingTime(r.mtime)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <a href={r.url} download={r.name} title="下载录像" className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                          <Download className="h-3.5 w-3.5" />
                        </a>
                        <button
                          type="button"
                          title="删除录像"
                          onClick={() => void handleDeleteRecording(r.name)}
                          className="text-slate-500 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 录制计划 · 自动布防 */}
            <div className="shrink-0 rounded-md border bg-slate-50 dark:bg-slate-900/40 p-3">
              <div className="text-[11px] font-medium text-slate-600 dark:text-slate-300">录制计划 · 到点自动布防</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Select
                  value={schedDraft.mode}
                  onValueChange={(v) => setSchedDraft((d) => ({ ...d, mode: v as 'motion' | 'continuous' }))}
                >
                  <SelectTrigger className="h-7 w-auto gap-1 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="motion">智能侦测</SelectItem>
                    <SelectItem value="continuous">连续录制</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="time"
                  className="h-7 w-[92px] text-[11px]"
                  value={schedDraft.start}
                  onChange={(e) => setSchedDraft((d) => ({ ...d, start: e.target.value }))}
                />
                <span className="text-[10.5px] text-slate-400">至</span>
                <Input
                  type="time"
                  className="h-7 w-[92px] text-[11px]"
                  value={schedDraft.end}
                  onChange={(e) => setSchedDraft((d) => ({ ...d, end: e.target.value }))}
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={!canControl || !deviceDid}
                  onClick={handleSaveSchedule}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> 添加计划
                </Button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                  const on = schedDraft.days.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() =>
                        setSchedDraft((cur) => ({
                          ...cur,
                          days: on ? cur.days.filter((x) => x !== d) : [...cur.days, d].sort(),
                        }))
                      }
                      className={cn(
                        'h-6 w-8 rounded border text-[10px]',
                        on
                          ? 'border-indigo-400/60 bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300'
                          : 'border-slate-200 text-slate-400 dark:border-slate-700',
                      )}
                    >
                      {['日', '一', '二', '三', '四', '五', '六'][d]}
                    </button>
                  );
                })}
              </div>
              {schedules.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {schedules.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10.5px] dark:border-slate-700 dark:bg-slate-800"
                    >
                      <span className="text-slate-700 dark:text-slate-200">
                        {s.mode === 'continuous' ? '连续' : '智能'} · {s.start} - {s.end} ·{' '}
                        {s.days.map((d) => ['日', '一', '二', '三', '四', '五', '六'][d] ?? d).join('')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          title={s.enabled ? '点击停用' : '点击启用'}
                          onClick={() =>
                            void system
                              .upsertCameraSchedule({ id: s.id, did: s.did, enabled: !s.enabled, mode: s.mode, days: s.days, start: s.start, end: s.end })
                              .then(() => loadCameraSchedules())
                          }
                        >
                          <Badge variant={s.enabled ? 'success' : 'secondary'} className="text-[9px]">
                            {s.enabled ? '已启用' : '已停用'}
                          </Badge>
                        </button>
                        <button type="button" title="删除计划" onClick={() => void handleDeleteSchedule(s.id)} className="text-slate-500 hover:text-red-600">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
