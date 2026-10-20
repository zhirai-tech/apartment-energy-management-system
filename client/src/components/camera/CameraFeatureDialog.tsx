import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  Loader2,
  Mic,
  PersonStanding,
  Radar,
  RefreshCw,
  Settings2,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  system,
  type CameraFeatureCapabilities,
  type CameraFeaturePatch,
  type CameraFeatureState,
} from '../../lib/api';

interface CameraFeatureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  did: string;
  name: string;
  capabilities?: CameraFeatureCapabilities;
}

function FeatureRow({
  icon,
  title,
  description,
  disabled,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  disabled?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {description ? (
            <div className="text-xs text-muted-foreground">{description}</div>
          ) : null}
          {hint ? (
            <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{hint}</div>
          ) : null}
          {disabled ? (
            <div className="mt-0.5 text-[11px] text-muted-foreground">该摄像头未识别支持此功能</div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function CameraFeatureDialog({
  open,
  onOpenChange,
  did,
  name,
  capabilities,
}: CameraFeatureDialogProps) {
  const queryClient = useQueryClient();
  const [recordMode, setRecordMode] = useState<'continuous' | 'motion' | 'person'>('continuous');

  const { data: features, isFetching, refetch } = useQuery<CameraFeatureState>({
    queryKey: ['camera-features', did],
    queryFn: () => system.getLanCameraFeatures(did),
    enabled: open && !!did,
    refetchOnWindowFocus: false,
    staleTime: 5000,
    retry: false,
  });

  const { data: recording } = useQuery({
    queryKey: ['camera-features-recording', did],
    queryFn: () => system.getCameraRecordingStatus(did),
    enabled: open && !!did,
    refetchInterval: open ? 5000 : false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (recording?.mode === 'motion' || recording?.mode === 'person' || recording?.mode === 'continuous') {
      setRecordMode(recording.mode);
    }
  }, [recording?.mode]);

  const updateMutation = useMutation({
    mutationFn: (patch: CameraFeaturePatch) => system.updateLanCameraFeatures(did, patch),
    onSuccess: (next) => {
      queryClient.setQueryData(['camera-features', did], next);
      void queryClient.invalidateQueries({ queryKey: ['camera-features', did] });
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.message || error?.message || '设置失败');
      void refetch();
    },
  });

  const recordingMutation = useMutation({
    mutationFn: async () => {
      if (recording?.recording) return system.stopCameraRecording(did);
      return system.startCameraRecording(did, {
        mode: recordMode,
        segmentMinutes: recordMode === 'continuous' ? 5 : undefined,
      });
    },
    onSuccess: (result: any) => {
      if (result?.recording === false) {
        toast.success('已停止录像');
      } else {
        const modeLabels: Record<string, string> = {
          continuous: '连续录像',
          motion: '移动侦测录像（服务端检测）',
          person: '人形事件录像（等待摄像头人形事件）',
        };
        toast.success(`已开始${modeLabels[recordMode] ?? '录像'}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['camera-features-recording', did] });
      void queryClient.invalidateQueries({ queryKey: ['camera-wall-rec', did] });
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.message || error?.message || '录像操作失败');
    },
  });

  const setFeature = (patch: CameraFeaturePatch) => updateMutation.mutate(patch);
  const supported = features?.supported === true;
  const busy = updateMutation.isPending || isFetching;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            摄像头功能开关
          </DialogTitle>
          <DialogDescription className="truncate">
            {name} · 以下开关直接写入摄像头，设置后立即生效
          </DialogDescription>
        </DialogHeader>

        {isFetching && !features ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取摄像头设置…
          </div>
        ) : !supported ? (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300">
              {features?.message || '该摄像头暂不支持通过系统直接修改厂商设置（仅支持水星/MERCURY 等同源 Web 协议摄像头）。'}
            </div>
            <div className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">服务端录像</div>
                <Button
                  size="sm"
                  variant={recording?.recording ? 'destructive' : 'default'}
                  disabled={recordingMutation.isPending}
                  onClick={() => recordingMutation.mutate()}
                >
                  {recordingMutation.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Video className="mr-1.5 h-4 w-4" />
                  )}
                  {recording?.recording ? '停止录像' : '开始录像'}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="text-[10px]">
                厂商：{features?.vendor === 'mercury' ? '水星 / MERCURY 协议' : features?.vendor}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2 text-[11px]"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCw className={`mr-1 h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>

            <FeatureRow
              icon={<Radar className="h-4 w-4" />}
              title="移动侦测"
              description="侦测到画面移动时触发事件（摄像头侧开关）"
              disabled={capabilities?.motion === false}
            >
              <Switch
                checked={features?.motionDetected === true}
                disabled={busy || capabilities?.motion === false}
                onCheckedChange={(checked) => setFeature({ motionDetected: checked })}
              />
            </FeatureRow>

            <FeatureRow
              icon={<PersonStanding className="h-4 w-4" />}
              title="人形侦测"
              description="仅当检测到人形时触发（摄像头侧智能识别）"
              hint={features?.motionDetected === false ? '建议先开启「移动侦测」' : undefined}
              disabled={capabilities?.human === false}
            >
              <Switch
                checked={features?.humanDetected === true}
                disabled={busy || capabilities?.human === false}
                onCheckedChange={(checked) => setFeature({ humanDetected: checked })}
              />
            </FeatureRow>

            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <div className="text-sm font-medium">侦测灵敏度</div>
                <div className="text-xs text-muted-foreground">低 / 中 / 高</div>
              </div>
              <Select
                value={String(features?.sensitivity ?? 'medium')}
                onValueChange={(value) =>
                  setFeature({ sensitivity: value as 'low' | 'medium' | 'high' })
                }
                disabled={busy}
              >
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">低</SelectItem>
                  <SelectItem value="medium">中</SelectItem>
                  <SelectItem value="high">高</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <FeatureRow
              icon={<Video className="h-4 w-4" />}
              title="摄像头本地录像"
              description="摄像头按录像计划自行录像（存到摄像头 SD 卡）"
              hint={features?.storageOnline === false ? '未检测到 SD 卡，本地录像不会真正落盘；可改用下方「服务端录像」' : undefined}
            >
              <Switch
                checked={features?.localRecording === true}
                disabled={busy}
                onCheckedChange={(checked) => setFeature({ localRecording: checked })}
              />
            </FeatureRow>

            <FeatureRow
              icon={<Video className="h-4 w-4" />}
              title="移动侦测联动录像"
              description="触发移动侦测时，摄像头自动录像"
            >
              <Switch
                checked={features?.motionLinkRecording === true}
                disabled={busy}
                onCheckedChange={(checked) => setFeature({ motionLinkRecording: checked })}
              />
            </FeatureRow>

            <FeatureRow
              icon={<Mic className="h-4 w-4" />}
              title="录音"
              description="开启后摄像头麦克风采集声音（关闭 = 静音）"
              disabled={capabilities?.audio === false}
            >
              <Switch
                checked={features?.audioEnabled === true}
                disabled={busy || capabilities?.audio === false}
                onCheckedChange={(checked) => setFeature({ audioEnabled: checked })}
              />
            </FeatureRow>

            <div className="rounded-md border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <AudioLines className="h-4 w-4 text-muted-foreground" />
                    服务端录像（本系统录制）
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {recording?.recording
                      ? `录像中（${
                          recording.mode === 'person'
                            ? '人形事件触发'
                            : recording.mode === 'motion'
                              ? '移动侦测触发'
                              : '连续 5 分钟分段'
                        }）`
                      : '当前未录像'}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    人形事件录像 = 摄像头侦测到人形才录（需局域网 ONVIF 摄像头支持人形事件）
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={recordMode}
                    onValueChange={(value) => setRecordMode(value as 'continuous' | 'motion' | 'person')}
                    disabled={recording?.recording || recordingMutation.isPending}
                  >
                    <SelectTrigger className="h-8 w-[140px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="continuous">连续录像</SelectItem>
                      <SelectItem value="motion">移动侦测录像</SelectItem>
                      <SelectItem value="person">人形事件录像</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant={recording?.recording ? 'destructive' : 'default'}
                    disabled={recordingMutation.isPending}
                    onClick={() => recordingMutation.mutate()}
                  >
                    {recordingMutation.isPending ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Video className="mr-1.5 h-4 w-4" />
                    )}
                    {recording?.recording ? '停止录像' : '开始录像'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
