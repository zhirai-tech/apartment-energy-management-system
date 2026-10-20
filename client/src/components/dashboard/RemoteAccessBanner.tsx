import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { system } from '../../lib/api';
import { copyTextToClipboard } from '../../lib/clipboard';

/**
 * 仪表盘顶部的外网访问地址条：
 * 局域网里打开系统时也能直接看到 cloudflared 外网地址，一键复制。
 * 「更新」= 重启 cloudflared 隧道并重新申请一条新地址（停电/服务器重启后地址失效时使用）。
 */
export function RemoteAccessBanner() {
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['system-remote-access'],
    queryFn: () => system.getRemoteAccessInfo(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const renew = useMutation({
    mutationFn: () => system.renewRemoteAccess(),
    onSuccess: (res) => {
      if (res?.url) {
        queryClient.setQueryData(['system-remote-access'], res);
        toast.success('已重新申请外网地址，请复制新地址使用');
      } else {
        toast.error(res?.hint || '更新失败，请稍后再试');
        queryClient.invalidateQueries({ queryKey: ['system-remote-access'] });
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || err?.message || '更新外网地址失败';
      toast.error(msg);
    },
  });

  const url = data?.url ?? '';
  if (!data?.enabled || !url) return null;

  const copy = async () => {
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopied(true);
      toast.success('外网地址已复制');
      setTimeout(() => setCopied(false), 2000);
    } else {
      // http 局域网页面可能禁用剪贴板：让用户直接手动复制显示出来的地址
      setCopied(false);
      toast.error('复制失败，请长按/选中上方地址手动复制');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-1.5 text-xs text-sky-900">
      <Globe className="h-3.5 w-3.5 shrink-0 text-sky-600" />
      <span className="shrink-0 font-medium">外网访问：</span>
      <code className="min-w-0 max-w-full truncate font-mono text-[11px] text-sky-800">{url}</code>
      <div className="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-sky-800 hover:bg-sky-100"
          onClick={copy}
          title="复制外网地址"
        >
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          复制
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-sky-800 hover:bg-sky-100"
          onClick={() => renew.mutate()}
          disabled={renew.isPending}
          title="重新申请一条新的外网地址（停电/重启后地址失效时使用）"
        >
          <RefreshCw className={`h-3 w-3 ${renew.isPending ? 'animate-spin' : ''}`} />
          {renew.isPending ? '更新中…' : '更新'}
        </Button>
      </div>
    </div>
  );
}

export default RemoteAccessBanner;
