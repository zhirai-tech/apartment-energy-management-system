import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { system } from '../../lib/api';
import { copyTextToClipboard } from '../../lib/clipboard';

/**
 * 远程访问（外网）卡片：展示 cloudflared 隧道当前公网地址，
 * 支持复制，以及「更新」= 重新申请一条新地址（停电/服务器重启后地址失效时使用）。
 */
export function RemoteAccessCard() {
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['system-remote-access'],
    queryFn: () => system.getRemoteAccessInfo(),
    staleTime: 30_000,
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
  const enabled = !!(data?.enabled && url);

  const handleCopy = async () => {
    if (!url) return;
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopied(true);
      toast.success('外网地址已复制');
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopied(false);
      toast.error('复制失败，请选中上方地址手动复制');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Globe className="h-4 w-4 text-sky-500" />
          远程访问（外网地址）
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Badge variant={enabled ? 'default' : 'secondary'}>
              {enabled ? '隧道运行中' : '未启用'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {enabled ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                readOnly
                value={url}
                aria-label="外网访问地址"
                className="min-w-0 flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  {copied ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                  复制
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => renew.mutate()}
                  disabled={renew.isPending}
                  title="重新申请一条新的外网地址（停电/重启后地址失效时使用）"
                >
                  <RefreshCw className={`mr-1 h-3.5 w-3.5 ${renew.isPending ? 'animate-spin' : ''}`} />
                  {renew.isPending ? '更新中…' : '更新'}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              在外网（手机流量或其它网络）打开此地址即可访问本系统；遇到停电/服务器重启导致地址失效时，点「更新」会重新申请一条新地址，再复制分发即可。
            </p>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {isLoading ? '读取中…' : (data?.hint || '当前未检测到外网访问地址（cloudflared 隧道未运行）。')}
            </p>
            <Button size="sm" onClick={() => renew.mutate()} disabled={renew.isPending}>
              <RefreshCw className={`mr-1 h-4 w-4 ${renew.isPending ? 'animate-spin' : ''}`} />
              {renew.isPending ? '正在申请…' : '重新申请外网地址'}
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching || renew.isPending}>
            {isFetching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
            刷新
          </Button>
          {data?.checkedAt && (
            <span className="text-[11px] text-muted-foreground">
              检查时间：{new Date(data.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default RemoteAccessCard;
