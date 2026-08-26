import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Camera,
  Download,
  Film,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
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
import { system } from '../lib/api';
import { formatBytes } from '../lib/format';
import { cn } from '../lib/utils';

type RecordingItem = { did: string; name: string; size: number; mtime: number; url: string };
type Segment = { start: number; end: number; items: RecordingItem[] };

const SPEEDS = [
  { value: '0.5', label: '0.5x' },
  { value: '1', label: '1x' },
  { value: '1.25', label: '1.25x' },
  { value: '1.5', label: '1.5x' },
  { value: '2', label: '2x' },
];

// 缩放档位：spanSec 为整条轨道显示的时间范围，tickSec 为刻度间隔
const ZOOM_LEVELS = [
  { spanSec: 86400, tickSec: 3600 }, // 24 小时，1 小时一格（默认）
  { spanSec: 21600, tickSec: 1800 }, // 6 小时，30 分钟一格
  { spanSec: 7200, tickSec: 600 }, // 2 小时，10 分钟一格
  { spanSec: 1800, tickSec: 60 }, // 30 分钟，1 分钟一格
  { spanSec: 300, tickSec: 15 }, // 5 分钟，15 秒一格（最大放大）
];

// 相邻片段间隔小于该值（秒）时视为同一段，合并成一个色块
const MERGE_GAP_SEC = 180;
const SEG_PAD_SEC = 20;

const pad = (n: number) => String(n).padStart(2, '0');

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function secOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}

function tickLabel(sec: number, tickSec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (tickSec >= 3600) return `${pad(h)}:00`;
  if (tickSec >= 60) return `${pad(h)}:${pad(m)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// 把一天内相邻的录像片段合并成连续的时间段
function buildSegments(items: RecordingItem[]): Segment[] {
  const sorted = [...items].sort((a, b) => a.mtime - b.mtime);
  const segs: Segment[] = [];
  for (const it of sorted) {
    const t = secOfDay(it.mtime);
    const start = Math.max(0, t - SEG_PAD_SEC);
    const end = t + SEG_PAD_SEC;
    const last = segs[segs.length - 1];
    if (last && start - last.end <= MERGE_GAP_SEC) {
      last.end = Math.max(last.end, end);
      last.items.push(it);
    } else {
      segs.push({ start, end, items: [it] });
    }
  }
  return segs;
}

export function RecordingsPage() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [selected, setSelected] = useState<RecordingItem | null>(null);
  const [speed, setSpeed] = useState('1');
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoomIdx, setZoomIdx] = useState(0);
  const [viewStartSec, setViewStartSec] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: RecordingItem[] } | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['camera-recordings'],
    queryFn: system.listAllCameraRecordings,
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
    staleTime: 2000,
  });

  const files = data?.files ?? [];
  const cameraDids = Array.from(new Set(files.map((f) => f.did)));
  const cameraDid = cameraDids[0] ?? null;

  // 连播顺序：按录制时间从早到晚
  const playlist = useMemo(() => [...files].sort((a, b) => a.mtime - b.mtime), [files]);

  // 按天分组，日期倒序（今天在上），组内时间升序，并合并出时间段色块
  const days = useMemo(() => {
    const map = new Map<string, RecordingItem[]>();
    for (const f of files) {
      const k = dayKey(f.mtime);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(f);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.mtime - b.mtime);
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, items]) => ({ key, items, segments: buildSegments(items) }));
  }, [files]);

  const selectedIdx = selected
    ? playlist.findIndex((p) => p.name === selected.name && p.did === selected.did)
    : -1;

  // 当前选中录像所属日期，以及它在“当天秒数”坐标下的起止
  const selectedDayKey = selected ? dayKey(selected.mtime) : null;
  const startSecOfDay = selected ? Math.max(0, secOfDay(selected.mtime) - duration) : 0;
  const playheadSec = startSecOfDay + currentTime;

  const level = ZOOM_LEVELS[zoomIdx];
  const ticks = useMemo(() => {
    const arr: number[] = [];
    const start = Math.floor(viewStartSec / level.tickSec) * level.tickSec;
    for (let t = start; t <= viewStartSec + level.spanSec + 0.001; t += level.tickSec) {
      if (t >= viewStartSec - 0.001) arr.push(t);
    }
    return arr;
  }, [level, viewStartSec]);

  // 默认选中最新一条（不自动播放，等用户点播放）
  useEffect(() => {
    if (!selected && files.length > 0) {
      setSelected(files[0]);
    }
  }, [files, selected]);

  // 切换录像时重置播放进度
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
  }, [selected]);

  const seekToClientX = (clientX: number) => {
    const el = trackRef.current;
    const v = videoRef.current;
    if (!el || !v) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const targetSec = viewStartSec + pct * level.spanSec;
    const t = targetSec - startSecOfDay;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, t));
  };

  // 拖动播放头（在活动时间轴上按下并移动）
  useEffect(() => {
    if (!isSeeking) return;
    const move = (e: MouseEvent) => seekToClientX(e.clientX);
    const up = () => setIsSeeking(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSeeking]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = Number(speed);
    }
  }, [speed, selected]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menu]);

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const handleEnded = () => {
    if (selectedIdx >= 0 && selectedIdx < playlist.length - 1) {
      setSelected(playlist[selectedIdx + 1]);
    }
  };

  const zoomTo = (nextIdx: number) => {
    const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIdx));
    const newSpan = ZOOM_LEVELS[clamped].spanSec;
    const center = selected ? secOfDay(selected.mtime) : viewStartSec + level.spanSec / 2;
    let newStart = Math.round(center - newSpan / 2);
    newStart = Math.max(0, Math.min(86400 - newSpan, newStart));
    setViewStartSec(newStart);
    setZoomIdx(clamped);
  };

  const handleSelect = (item: RecordingItem) => {
    setSelected(item);
    if (zoomIdx > 0) {
      const span = level.spanSec;
      let start = Math.round(secOfDay(item.mtime) - span / 2);
      start = Math.max(0, Math.min(86400 - span, start));
      setViewStartSec(start);
    }
  };

  const downloadItem = (item: RecordingItem) => {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const renderTrack = (key: string, segments: Segment[]) => {
    const isActiveDay = key === selectedDayKey;
    const playheadPct = ((playheadSec - viewStartSec) / level.spanSec) * 100;
    const playheadVisible =
      isActiveDay && playheadSec >= viewStartSec && playheadSec <= viewStartSec + level.spanSec;
    return (
      <div
        ref={isActiveDay ? trackRef : undefined}
        className="relative h-8 flex-1 overflow-hidden rounded bg-muted/70"
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.deltaY < 0) zoomTo(zoomIdx + 1);
          else zoomTo(zoomIdx - 1);
        }}
        onMouseDown={
          isActiveDay
            ? (e) => {
                e.preventDefault();
                setIsSeeking(true);
                seekToClientX(e.clientX);
              }
            : undefined
        }
      >
        {ticks.map((t) => (
          <div
            key={`tick-${t}`}
            className="absolute bottom-0 top-0 w-px bg-border/50"
            style={{ left: `${((t - viewStartSec) / level.spanSec) * 100}%` }}
          />
        ))}
        {segments.map((seg) => {
          const leftPct = ((seg.start - viewStartSec) / level.spanSec) * 100;
          const widthPct = ((seg.end - seg.start) / level.spanSec) * 100;
          if (seg.end < viewStartSec - 1 || seg.start > viewStartSec + level.spanSec + 1) {
            return null;
          }
          const isCurrent = seg.items.some(
            (it) => selected?.did === it.did && selected?.name === it.name,
          );
          const first = seg.items[0];
          const lastItem = seg.items[seg.items.length - 1];
          return (
            <div
              key={`${seg.items[0].did}/${seg.items[0].name}`}
              role="button"
              tabIndex={0}
              onClick={() => handleSelect(lastItem)}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: seg.items });
              }}
              className={cn(
                'absolute inset-y-0.5 cursor-pointer rounded-[3px]',
                isCurrent ? 'bg-red-500' : 'bg-red-500/70 hover:bg-red-500/90',
              )}
              style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.3)}%` }}
              title={`${seg.items.length} 段 · ${timeLabel(first.mtime)} ~ ${timeLabel(lastItem.mtime)}（右键导出）`}
            />
          );
        })}
        {playheadVisible && (
          <div
            className="pointer-events-none absolute inset-y-0 z-10"
            style={{ left: `${playheadPct}%` }}
          >
            <div className="absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/80" />
            <div className="absolute top-0 h-3 w-3 -translate-x-1/2 rounded-full bg-red-500 ring-2 ring-foreground" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-3">
      <div className="app-page-header shrink-0">
        <h1 className="text-2xl font-bold">
          <Film className="mr-2 inline-block h-7 w-7" />
          录像回放
        </h1>
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          className="h-9"
        >
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          刷新
        </Button>
        <Button
          onClick={() => cameraDid && navigate(`/?camera=${encodeURIComponent(cameraDid)}`)}
          disabled={!cameraDid}
          className="h-9"
          title="直接打开摄像头直播详情"
        >
          <Camera className="mr-2 h-4 w-4" />
          打开摄像头直播
        </Button>
      </div>

      <Card className="flex min-h-0 flex-[3] flex-col">
        <CardContent className="flex h-full min-h-0 flex-col p-3">
          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <video
                  key={selected.url}
                  ref={videoRef}
                  src={selected.url}
                  controls
                  autoPlay
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={handleEnded}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  className="max-h-full max-w-full rounded-md bg-black object-contain"
                />
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button variant="outline" size="icon" onClick={togglePlay} title={isPlaying ? '暂停' : '播放'}>
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={() => seekBy(-10)} title="后退 10 秒">
                  <SkipBack className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={() => seekBy(10)} title="前进 10 秒">
                  <SkipForward className="h-4 w-4" />
                </Button>
                <Select value={speed} onValueChange={setSpeed}>
                  <SelectTrigger className="h-8 w-[86px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SPEEDS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="ml-auto min-w-0 text-xs text-muted-foreground">
                  {dayLabel(dayKey(selected.mtime))} {timeLabel(selected.mtime)} ·{' '}
                  {formatBytes(selected.size)}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Film className="h-10 w-10" />
              <p className="text-sm">{isLoading ? '加载中…' : '暂无录像'}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-[2] flex-col">
        <CardContent className="flex h-full min-h-0 flex-col p-3">
          {files.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">暂无录像</div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              {/* 顶部时间刻度尺 */}
              <div className="flex shrink-0 items-start gap-2">
                <span className="w-28 shrink-0 pt-0.5 text-xs text-muted-foreground">时间</span>
                <div className="relative h-6 flex-1">
                  {ticks.map((t) => (
                    <div
                      key={`scale-${t}`}
                      className="absolute top-0 h-full -translate-x-1/2"
                      style={{ left: `${((t - viewStartSec) / level.spanSec) * 100}%` }}
                    >
                      <div className="mx-auto h-2.5 w-px bg-border" />
                      <span className="absolute left-0 top-3 -translate-x-1/2 text-[10px] leading-none text-muted-foreground">
                        {tickLabel(t, level.tickSec)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
                {days.map(({ key, segments }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-sm font-medium">
                      {dayLabel(key)}
                      {key === dayKey(Date.now()) && (
                        <span className="ml-1 text-xs text-primary">今日</span>
                      )}
                    </span>
                    {renderTrack(key, segments)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {menu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-md border bg-popover p-1 shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.items.map((it) => (
            <button
              key={`${it.did}/${it.name}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                downloadItem(it);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Download className="h-4 w-4" />
              导出 {timeLabel(it.mtime)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
