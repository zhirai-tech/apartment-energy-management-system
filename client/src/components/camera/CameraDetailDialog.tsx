import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clapperboard,
  Loader2,
  Minus,
  PersonStanding,
  Plus,
  Radar,
  RefreshCw,
  Square,
  Video,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useHlsStream } from '../../hooks/useHlsStream';
import { system, type CameraListItem } from '../../lib/api';
import { cn } from '../../lib/utils';
import { CameraPtzJoystick } from './CameraPtzJoystick';
import { HelpTip } from '../ui/help-tip';

/** 摄像头能力展示项：key 对应后端能力接口的字段 */
const CAPABILITY_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'ptz', label: '云台' },
  { key: 'humanDetection', label: '人形侦测' },
  { key: 'motionDetection', label: '移动侦测' },
  { key: 'tamperDetection', label: '视频遮挡' },
  { key: 'lineDetection', label: '越界侦测' },
  { key: 'intrusionDetection', label: '区域入侵' },
  { key: 'objectLeftDetection', label: '物品遗留' },
  { key: 'objectRemovedDetection', label: '物品拿取' },
  { key: 'smartTracking', label: '智能追踪' },
  { key: 'faceRecognition', label: '人脸识别' },
  { key: 'audio', label: '录音' },
  { key: 'recording', label: '录像' },
];

/**
 * 摄像头详情大框：底部只有一排独立按钮（录像 / 缩放 / 圆形云台），没有分组容器；
 * 画面下方展示"摄像头支持的全部功能"，哪些被识别到一眼能看到。
 */
export function CameraDetailDialog({
  open,
  onOpenChange,
  camera,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  camera: CameraListItem | null;
}) {
  const queryClient = useQueryClient();
  const did = camera?.did ?? '';

  const { data: stream, isFetching: streamFetching, refetch: refetchStream } = useQuery({
    queryKey: ['camera-detail-stream', did],
    queryFn: () => system.getCameraStream(did),
    enabled: open && !!did && camera?.online !== false,
    refetchInterval: open ? 15000 : false,
    refetchOnWindowFocus: false,
    staleTime: 8000,
  });
  const hlsUrl = camera?.online === false ? undefined : stream?.hlsUrl ?? undefined;
  const videoRef = useHlsStream(hlsUrl);
  const hasVideo = !!hlsUrl && stream?.hlsReady === true && camera?.online !== false;
  const online = camera?.online !== false;

  const { data: recording } = useQuery({
    queryKey: ['camera-detail-recording', did],
    queryFn: () => system.getCameraRecordingStatus(did),
    enabled: open && !!did,
    refetchInterval: open ? 4000 : false,
    refetchOnWindowFocus: false,
  });
  const recordingMutation = useMutation({
    mutationFn: async () => {
      if (recording?.recording) return system.stopCameraRecording(did);
      return system.startCameraRecording(did, { mode: 'continuous', segmentMinutes: 5 } as any);
    },
    onSuccess: (result: any) => {
      toast.success(result?.recording ? '已开始连续录像' : '已停止录像');
      void queryClient.invalidateQueries({ queryKey: ['camera-detail-recording', did] });
      void queryClient.invalidateQueries({ queryKey: ['camera-wall-rec', did] });
      void queryClient.invalidateQueries({ queryKey: ['camera-recordings'] });
      void queryClient.invalidateQueries({ queryKey: ['all-camera-recordings'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || err?.message || '录像操作失败'),
  });

  // 现场探测摄像头支持的全部功能（显示在画面下方）
  const { data: capabilities } = useQuery({
    queryKey: ['camera-detail-capabilities', did],
    queryFn: () => system.getCameraCapabilities(did),
    enabled: open && !!did,
    staleTime: 60_000,
    retry: false,
  });

  const capabilityState = useMemo(() => {
    const caps: any = capabilities ?? {};
    return CAPABILITY_ITEMS.map((item) => {
      const entry = caps?.[item.key];
      const supported = entry?.supported === true;
      return { ...item, supported, hint: entry?.hint };
    });
  }, [capabilities]);

  // TP-Link 摄像头侦测开关（人形侦测 / 区域入侵），可在系统里直接开关
  const { data: detections, refetch: refetchDetections } = useQuery({
    queryKey: ['camera-detail-detections', did],
    queryFn: () => system.getLanCameraDetections(did),
    enabled: open && !!did && camera?.source === 'lan',
    staleTime: 20_000,
    retry: false,
  });
  const detectionMutation = useMutation({
    mutationFn: (input: { feature: 'human' | 'intrusion'; enabled: boolean }) =>
      system.setLanCameraDetection(did, input.feature, input.enabled),
    onSuccess: () => {
      toast.success('摄像头设置已生效');
      void refetchDetections();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || err?.message || '设置失败'),
  });
  const zoom = (action: 'zoomIn' | 'zoomOut') => {
    system
      .controlLanCameraPtz(did, { action, speed: 50, durationMs: 300 })
      .then((r: any) => {
        if (!r?.ok) toast.error(r?.message || '缩放失败');
      })
      .catch((e: any) => toast.error(e?.response?.data?.message || e?.message || '缩放失败'));
  };

  /** 独立小按钮：图标在上、文字在下，不加任何容器 */
  const labeledBtn = (
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
    opts?: { disabled?: boolean; danger?: boolean; active?: boolean },
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={opts?.disabled}
      className={cn(
        'flex h-10 w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border text-white shadow-sm transition-colors',
        'border-white/20 bg-black/45 hover:bg-black/65 active:bg-black/80 disabled:cursor-not-allowed disabled:opacity-40',
        opts?.danger && 'border-red-400/70 bg-red-600/80 hover:bg-red-600',
        opts?.active && 'border-emerald-400/80 bg-emerald-600/80 hover:bg-emerald-600',
      )}
    >
      {icon}
      <span className="max-w-full truncate text-[8px] leading-none">{label}</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl gap-2 p-3">
        <DialogTitle className="sr-only">{camera?.name ?? '摄像头详情'}</DialogTitle>
        <div className="flex items-center justify-between gap-2 pr-6">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium sm:text-base">{camera?.name ?? '摄像头'}</span>
            <Badge variant={hasVideo ? 'default' : 'secondary'} className="h-5 shrink-0 px-1.5 text-[10px]">
              {hasVideo ? 'LIVE' : online ? '连接中' : '离线'}
            </Badge>
            {recording?.recording ? (
              <Badge variant="destructive" className="h-5 shrink-0 px-1.5 text-[10px]">
                <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                录像中
              </Badge>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => refetchStream()} disabled={streamFetching}>
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', streamFetching && 'animate-spin')} />
            刷新
          </Button>
        </div>

        <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-black">
          {hasVideo ? (
            <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-zinc-500">
              {!online ? <WifiOff className="h-10 w-10" /> : <Video className={cn('h-10 w-10', streamFetching && 'animate-pulse')} />}
              <span className="text-xs">{!online ? '摄像头离线（请检查 WiFi / 电源）' : stream?.errorMessage || '视频流正在连接…'}</span>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => refetchStream()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                重新连接
              </Button>
            </div>
          )}

          {/* 底部一排：独立的录像 / 缩放 / 云台按钮，没有分组容器 */}
          <div
            className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {detections?.supported && detections.human
              ? labeledBtn(
                  () => detectionMutation.mutate({ feature: 'human', enabled: !detections.human!.enabled }),
                  <PersonStanding className="h-4 w-4" />,
                  `人形·${detections.human.enabled ? '开' : '关'}`,
                  { active: detections.human.enabled, disabled: detectionMutation.isPending },
                )
              : null}
            {detections?.supported && detections.intrusion
              ? labeledBtn(
                  () => detectionMutation.mutate({ feature: 'intrusion', enabled: !detections.intrusion!.enabled }),
                  <Radar className="h-4 w-4" />,
                  `区域·${detections.intrusion.enabled ? '开' : '关'}`,
                  { active: detections.intrusion.enabled, disabled: detectionMutation.isPending },
                )
              : null}
            {labeledBtn(
              () => recordingMutation.mutate(),
              recordingMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : recording?.recording ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Clapperboard className="h-4 w-4" />
              ),
              recording?.recording ? '停录' : '录像',
              { disabled: !online || recordingMutation.isPending, danger: !!recording?.recording },
            )}

            {camera?.hasPTZ && online
              ? labeledBtn(() => zoom('zoomOut'), <Minus className="h-4 w-4" />, '缩小')
              : null}

            {camera?.hasPTZ && online ? <CameraPtzJoystick did={did} inline /> : null}

            {camera?.hasPTZ && online
              ? labeledBtn(() => zoom('zoomIn'), <Plus className="h-4 w-4" />, '放大')
              : null}

            {camera?.source === 'xiaomi'
              ? labeledBtn(
                  () => {
                    system
                      .controlCameraCapability(did, 'ptzCalibrate')
                      .then((r: any) => {
                        if (r?.ok) toast.success('已发送云台回中指令');
                        else toast.error(r?.message || '回中失败');
                      })
                      .catch((e: any) => toast.error(e?.response?.data?.message || '回中失败'));
                  },
                  <RefreshCw className="h-4 w-4" />,
                  '回中',
                )
              : null}
          </div>
        </div>

        {/* 画面下方：摄像头支持的全部功能 */}
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            摄像头功能：
            <HelpTip text="绿色=摄像头已上报、可用于事件触发录像；灰色=未识别（可尝试在厂商 App 里开启对应侦测，或该型号不通过 ONVIF 开放）。" />
          </span>
          {capabilityState.map((item) => (
            <span
              key={item.key}
              title={
                item.supported
                  ? `${item.label}（支持）`
                  : `${item.label}（未识别：可能需在厂商 App 中开启，或该型号不通过 ONVIF 上报）`
              }
              className={cn(
                'rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
                item.supported
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-muted-foreground/20 text-muted-foreground/60',
              )}
            >
              {item.label}
            </span>
          ))}
        </div>
        
      </DialogContent>
    </Dialog>
  );
}

export default CameraDetailDialog;
