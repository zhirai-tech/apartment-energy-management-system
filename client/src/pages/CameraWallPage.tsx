import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  Clock,
  LayoutGrid,
  Maximize2,
  Plus,
  RefreshCw,
  Radio,
  Video,
  WifiOff,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { system, type CameraListResponse } from '../lib/api';
import { useHlsStream } from '../hooks/useHlsStream';
import { CameraManageDialog } from '../components/camera/CameraManageDialog';
import { CameraDetailDialog } from '../components/camera/CameraDetailDialog';
import { cn } from '../lib/utils';

const GRID_OPTIONS = [
  { cols: 1, label: '1 画面' },
  { cols: 2, label: '2 画面' },
  { cols: 4, label: '4 画面' },
  { cols: 6, label: '6 画面' },
  { cols: 8, label: '8 画面' },
];

const pad = (n: number) => String(n).padStart(2, '0');

function CameraTile({
  did,
  name,
  online,
  muted,
  onOpen,
}: {
  did: string;
  name: string;
  online?: boolean;
  muted: boolean;
  onOpen: () => void;
}) {
  const { data: stream, isFetching: streamFetching, refetch: refetchStream } = useQuery({
    queryKey: ['camera-wall-stream', did],
    queryFn: () => system.getCameraStream(did),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    staleTime: 8000,
    enabled: !!did && online !== false,
  });
  // 监控墙只显示"是否正在录像"
  const { data: recording } = useQuery({
    queryKey: ['camera-wall-rec', did],
    queryFn: () => system.getCameraRecordingStatus(did),
    refetchInterval: 12000,
    refetchOnWindowFocus: false,
    staleTime: 8000,
    enabled: !!did && online !== false,
  });

  // 播放中 hls.js fatal 自愈：防抖 2s 后重新请求 camera_stream + 强制 reload 播放器。
  const [hlsEpoch, setHlsEpoch] = useState(0);
  const lastHlsRecoverRef = useRef(0);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
  }, []);
  const handleHlsFatal = useCallback(() => {
    if (online === false) return;
    const now = Date.now();
    if (now - lastHlsRecoverRef.current < 10000) return;
    lastHlsRecoverRef.current = now;
    if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
    recoverTimerRef.current = setTimeout(() => {
      recoverTimerRef.current = null;
      refetchStream();
      setHlsEpoch((e) => e + 1);
    }, 2000);
  }, [online, refetchStream]);

  const hlsUrl = stream?.hlsUrl ?? undefined;
  const videoRef = useHlsStream(online === false ? undefined : hlsUrl, {
    epoch: hlsEpoch,
    onFatalError: handleHlsFatal,
  });
  // 只有后端确认实时流就绪（hlsReady=true）才渲染播放器；
  // hlsReady=false 时后端不会下发 hlsUrl，避免 hls.js 持续请求不存在的 m3u8（404）。
  const hasVideo = !!hlsUrl && stream?.hlsReady === true && online !== false;

  return (
    <div className="group relative h-full min-h-0 w-full overflow-hidden rounded-md border bg-black">
      <button
        type="button"
        onClick={onOpen}
        title={`${name}（点击查看详情）`}
        className="absolute inset-0 h-full w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
      {hasVideo ? (
        <video
          ref={videoRef}
          muted={muted}
          autoPlay
          playsInline
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-zinc-950 text-zinc-500">
          {online === false ? (
            <WifiOff className="h-8 w-8" />
          ) : (
            <Video className={cn('h-8 w-8', streamFetching && 'animate-pulse')} />
          )}
          <span className="text-xs">{online === false ? '离线' : stream?.errorMessage || '视频流正在恢复'}</span>
        </div>
      )}

      {/* 只显示录像状态 */}
      {recording?.recording ? (
        <div className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
          <Badge variant="destructive" className="h-4 gap-1 rounded-sm px-1.5 text-[10px] leading-none">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            录像中
          </Badge>
        </div>
      ) : null}

      {/* 名称 + 放大提示 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
          <Camera className="mr-1 inline-block h-3 w-3" />
          {name}
        </span>
        <Maximize2 className="h-3 w-3 shrink-0 text-white/70" />
      </div>
      </button>
    </div>
  );
}

export function CameraWallPage() {
  const queryClient = useQueryClient();
  const [cols, setCols] = useState(2);
  // 监控墙默认只显示在线摄像头，离线的不占画面（可在右上角切换"全部"）
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [singleIndex, setSingleIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [manageOpen, setManageOpen] = useState(false);
  // 点画面 → 居中大框详情（单画面 + 底部水平控制条）
  const [detailCamera, setDetailCamera] = useState<any | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery<CameraListResponse>({
    queryKey: ['camera-wall-devices'],
    queryFn: () => system.listCameras(),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    staleTime: 10000,
  });

  const cameras = useMemo(() => data?.cameras ?? [], [data]);
  const lanCameras = useMemo(() => cameras.filter((c) => c.source === 'lan'), [cameras]);
  const onlineCount = cameras.filter((c) => c.online !== false).length;
  const visibleCameras = onlineOnly ? cameras.filter((c) => c.online !== false) : cameras;
  // 单画面模式：只显示一台，可用上一台/下一台切换
  const shownCameras = cols === 1 && visibleCameras.length > 0
    ? [visibleCameras[((singleIndex % visibleCameras.length) + visibleCameras.length) % visibleCameras.length]]
    : visibleCameras;
  // 根据 camera 区 auth-status 区分：正常 / 自动恢复 / 需要人工验证 / 已失效
  const authState = data?.auth?.state;
  const authBanner =
    data?.loggedIn === false && cameras.some((c) => c.source === 'xiaomi')
      ? { text: '米家云账号未登录，小米摄像头暂不可用；局域网摄像头不受影响', tone: 'error' as const }
      : authState === 'recovering'
        ? { text: '摄像头会话已失效，正在自动恢复…', tone: 'warn' as const }
        : authState === 'challenge_required'
          ? { text: '摄像头登录需要验证，请完成小米账号验证后继续', tone: 'warn' as const }
          : authState === 'error'
            ? { text: '摄像头登录已失效，请重新登录（局域网摄像头不受影响）', tone: 'error' as const }
            : null;
  const d = new Date(now);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const handleCameraChanged = () => {
    void refetch();
    // 新摄像头会进仪表盘摄像头分类，一并刷新相关查询
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['camera-wall-devices'] });
    // 摄像头参数变化后后端会重启 ffmpeg 流：立即重取流地址，避免播放器短暂 404
    void queryClient.invalidateQueries({ queryKey: ['camera-wall-stream'] });
    void queryClient.invalidateQueries({ queryKey: ['camera-wall-rec'] });
  };

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-3">
      <div className="app-page-header shrink-0">
        <h1 className="text-2xl font-bold">
          <Camera className="mr-2 inline-block h-7 w-7" />
          监控墙
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-sm tabular-nums text-muted-foreground sm:flex">
            <Clock className="h-4 w-4" />
            {clock}
          </span>
          <Badge variant="secondary" className="h-6 gap-1 rounded-sm px-2 text-xs">
            <Radio className="h-3 w-3" />
            {onlineCount}/{cameras.length} 在线
          </Badge>
          <Button
            variant="default"
            onClick={() => setManageOpen(true)}
            className="h-9"
            title="添加 / 管理局域网摄像头"
          >
            <Plus className="mr-2 h-4 w-4" />
            添加摄像头
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMuted((m) => !m)}
            className="h-9 w-9"
            title={muted ? '开启声音' : '静音'}
          >
            <Video className="h-4 w-4" />
          </Button>
          <div className="flex items-center rounded-md border p-0.5">
            <button
              type="button"
              onClick={() => setOnlineOnly(true)}
              className={cn(
                'h-8 rounded-sm px-2 text-xs transition-colors',
                onlineOnly ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
              title="只显示在线摄像头"
            >
              在线
            </button>
            <button
              type="button"
              onClick={() => setOnlineOnly(false)}
              className={cn(
                'h-8 rounded-sm px-2 text-xs transition-colors',
                !onlineOnly ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
              title="显示全部摄像头（含离线）"
            >
              全部
            </button>
          </div>
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
            className="h-9"
            title="刷新（重新加载所有画面）"
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
            刷新
          </Button>
          {cols === 1 && visibleCameras.length > 1 ? (
            <div className="flex items-center gap-1">
              <Button variant="outline" className="h-9" title="上一台" onClick={() => setSingleIndex((i) => i - 1)}>‹</Button>
              <span className="text-xs tabular-nums text-muted-foreground">{((singleIndex % visibleCameras.length) + visibleCameras.length) % visibleCameras.length + 1}/{visibleCameras.length}</span>
              <Button variant="outline" className="h-9" title="下一台" onClick={() => setSingleIndex((i) => i + 1)}>›</Button>
            </div>
          ) : null}
          <Select value={String(cols)} onValueChange={(v) => setCols(Number(v))}>
            <SelectTrigger className="h-9 w-[108px]">
              <LayoutGrid className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRID_OPTIONS.map((g) => (
                <SelectItem key={g.cols} value={String(g.cols)}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {authBanner && (
        <div
          className={`shrink-0 rounded-md border px-3 py-2 text-sm ${
            authBanner.tone === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-amber-400/40 bg-amber-400/10 text-amber-300'
          }`}
        >
          {authBanner.text}
        </div>
      )}

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex h-full min-h-0 flex-col p-3">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground">
              <Camera className="h-10 w-10 animate-pulse" />
              <p className="text-sm">加载摄像头…</p>
            </div>
          ) : cameras.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
              <Video className="h-10 w-10" />
              <p className="text-sm">暂无摄像头</p>
              <p className="max-w-md text-center text-xs">
                点击右上角「添加摄像头」接入局域网 ONVIF / RTSP 摄像头（完全本地，不依赖小米云）
              </p>
              <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                添加摄像头
              </Button>
            </div>
          ) : visibleCameras.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
              <Video className="h-10 w-10" />
              <p className="text-sm">当前没有在线摄像头（离线摄像头已隐藏）</p>
              <Button variant="outline" size="sm" onClick={() => setOnlineOnly(false)}>
                显示全部摄像头
              </Button>
            </div>
          ) : (
            <div
              className={cn(
                'grid h-full w-full auto-rows-fr gap-1.5 overflow-auto',
                cols === 1 && 'grid-cols-1',
                cols === 2 && 'grid-cols-1 min-[900px]:grid-cols-2',
                cols === 4 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4',
                cols === 6 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                cols === 8 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
              )}
            >
              {shownCameras.map((cam) => (
                <CameraTile
                  key={cam.did}
                  did={cam.did}
                  name={cam.name}
                  online={cam.online}
                  muted={muted}
                  onOpen={() => setDetailCamera(cam)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CameraManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        lanCameras={lanCameras}
        onChanged={handleCameraChanged}
      />
      <CameraDetailDialog
        open={!!detailCamera}
        onOpenChange={(open) => {
          if (!open) setDetailCamera(null);
        }}
        camera={detailCamera}
      />
    </div>
  );
}
