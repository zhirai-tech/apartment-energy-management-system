import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Minus, Plus, Square } from 'lucide-react';
import { toast } from 'sonner';
import { system } from '../../lib/api';
import { cn } from '../../lib/utils';

type Dir = 'left' | 'right' | 'up' | 'down' | 'zoomIn' | 'zoomOut' | 'stop';

/**
 * 圆形云台摇杆（紧凑版）：中间是方向键，下面一行 ZOOM。
 * inline=true 时使用相对定位，便于放进底部水平控制条。
 */
export function CameraPtzJoystick({
  did,
  className,
  inline = false,
}: {
  did: string;
  className?: string;
  inline?: boolean;
}) {
  const ptz = useMutation({
    mutationFn: (action: Dir) => system.controlLanCameraPtz(did, { action, speed: 50, durationMs: 350 }),
    onError: (err: any) => toast.error(err?.response?.data?.message || err?.message || '云台指令失败'),
    onSuccess: (res) => {
      if (!res?.ok) toast.error(res?.message || '云台指令失败');
    },
  });

  const stopProp = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const btn = (action: Dir, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        stopProp(e);
        ptz.mutate(action);
      }}
      disabled={ptz.isPending}
      className={cn('flex items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/25 active:bg-white/35 disabled:opacity-40', inline ? 'h-6 w-6' : 'h-7 w-7')}
    >
      {icon}
    </button>
  );

  return (
    <div
      className={cn(
        inline ? 'relative' : 'absolute',
        'pointer-events-auto z-20 select-none rounded-full border border-white/20 bg-black/40 text-white shadow backdrop-blur-sm', inline ? 'p-0.5' : 'p-1',
        className,
      )}
      onClick={stopProp}
      onMouseDown={stopProp}
    >
      <div className="grid grid-cols-3 grid-rows-3 items-center justify-items-center">
        <span />
        {btn('up', <ChevronUp className="h-3.5 w-3.5" />, '云台向上')}
        <span />
        {btn('left', <ChevronLeft className="h-3.5 w-3.5" />, '云台向左')}
        {btn('stop', <Square className="h-2.5 w-2.5" />, '停止云台')}
        {btn('right', <ChevronRight className="h-3.5 w-3.5" />, '云台向右')}
        <span />
        {btn('down', <ChevronDown className="h-3.5 w-3.5" />, '云台向下')}
        <span />
      </div>
      {!inline ? (
        <div className="mt-0.5 flex items-center justify-center gap-0.5 border-t border-white/15 pt-0.5">
          {btn('zoomOut', <Minus className="h-3 w-3" />, '缩小')}
          <span className="px-0.5 text-[8px] leading-none text-white/60">ZOOM</span>
          {btn('zoomIn', <Plus className="h-3 w-3" />, '放大')}
        </div>
      ) : null}
    </div>
  );
}

export default CameraPtzJoystick;
