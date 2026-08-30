import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Camera,
  Clock,
  LayoutGrid,
  Maximize2,
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
import { system } from '../lib/api';
import { useHlsStream } from '../hooks/useHlsStream';
import { cn } from '../lib/utils';

const GRID_OPTIONS = [
  { cols: 1, label: '单画面' },
  { cols: 2, label: '4 画面' },
  { cols: 3, label: '9 画面' },
  { cols: 4, label: '16 画面' },
];

const pad = (n: number) => String(n).padStart(2, '0');

function CameraTile({
  did,
  name,
  online,
  muted,
  onClick,
}: {
  did: string;
  name: string;
  online?: boolean;
  muted: boolean;
  onClick: () => void;
}) {
  const { data: stream, isFetching: streamFetching } = useQuery({
    queryKey: ['camera-wall-stream', did],
    queryFn: () => system.getCameraStream(did),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    staleTime: 8000,
    enabled: !!did && online !== false,
  });

  const { data: recording } = useQuery({
    queryKey: ['camera-wall-rec', did],
    queryFn: () => system.getCameraRecordingStatus(did),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    staleTime: 8000,
    enabled: !!did && online !== false,
  });

  const hlsUrl = stream?.hlsUrl ?? undefined;
  const videoRef = useHlsStream(online === false ? undefined : hlsUrl);
  const hasVideo = !!hlsUrl && online !== false;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${name}（点击放大）`}
      className="group relative aspect-video w-full overflow-hidden rounded-md border bg-black text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
          <span className="text-xs">{online === false ? '离线' : stream?.errorMessage || '暂无画面'}</span>
        </div>
      )}

      {/* 状态指示角标 */}
      <div className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
        {recording?.recording && (
          <Badge variant="destructive" className="h-4 gap-1 rounded-sm px-1 text-[10px] leading-none">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            REC
          </Badge>
        )}
        <Badge
          variant={hasVideo ? 'default' : 'secondary'}
          className="h-4 gap-1 rounded-sm px-1 text-[10px] leading-none"
        >
          {online === false ? (
            <WifiOff className="h-2.5 w-2.5" />
          ) : (
            <Radio className="h-2.5 w-2.5" />
          )}
          {online === false ? '离线' : hasVideo ? 'LIVE' : '连接中'}
        </Badge>
      </div>

      {/* 名称 + 放大提示 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
          <Camera className="mr-1 inline-block h-3 w-3" />
          {name}
        </span>
        <Maximize2 className="h-3 w-3 shrink-0 text-white/70" />
      </div>
    </button>
  );
}

export function CameraWallPage() {
  const navigate = useNavigate();
  const [cols, setCols] = useState(2);
  const [muted, setMuted] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['camera-wall-devices'],
    queryFn: () => system.xiaomiCameraDevices(),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    staleTime: 10000,
  });

  const cameras = useMemo(() => data?.devices ?? [], [data]);
  const onlineCount = cameras.filter((c) => c.online !== false).length;
  const d = new Date(now);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

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
            variant="outline"
            size="icon"
            onClick={() => setMuted((m) => !m)}
            className="h-9 w-9"
            title={muted ? '开启声音' : '静音'}
          >
            <Video className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-9"
            title="刷新"
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
            刷新
          </Button>
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

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex h-full min-h-0 flex-col p-3">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground">
              <Camera className="h-10 w-10 animate-pulse" />
              <p className="text-sm">加载摄像头…</p>
            </div>
          ) : cameras.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground">
              <Video className="h-10 w-10" />
              <p className="text-sm">
                {data?.loggedIn === false
                  ? '尚未登录米家账号，请先在系统设置中登录摄像头账号'
                  : '暂无摄像头'}
              </p>
            </div>
          ) : (
            <div
              className={cn(
                'grid h-full w-full auto-rows-fr gap-1.5 overflow-auto',
                cols === 1 && 'grid-cols-1',
                cols === 2 && 'grid-cols-1 sm:grid-cols-2',
                cols === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                cols === 4 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
              )}
            >
              {cameras.map((cam) => (
                <CameraTile
                  key={cam.did}
                  did={cam.did}
                  name={cam.name}
                  online={cam.online}
                  muted={muted}
                  onClick={() => navigate(`/?camera=${encodeURIComponent(cam.did)}`)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
