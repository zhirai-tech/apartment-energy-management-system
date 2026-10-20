import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Globe, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { dashboard } from '../lib/api';
import { cn } from '../lib/utils';

function statusBadge(status?: string) {
  if (status === 'online') return <Badge className="bg-emerald-600 hover:bg-emerald-600">在线</Badge>;
  return <Badge variant="destructive">离线</Badge>;
}

function formatTime(value?: string | null) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 网络设备总览：只显示"还没添加到系统"的局域网设备（已添加的空开/摄像头/路由/放大器不在这里重复出现）。
 * 未知状态不显示；页面每小时自动刷新。
 */
export function NetworkDevicesPage() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['network-devices-overview'],
    queryFn: () => dashboard.get(),
    refetchInterval: 60 * 60_000,
    refetchOnWindowFocus: true,
  });

  const devices = useMemo(() => (data?.devices ?? []) as any[], [data]);
  const discovered = useMemo(
    () =>
      devices.filter(
        (d) => d.category === 'other' && d.source === 'lan_discovery' && d.status !== 'unknown',
      ),
    [devices],
  );
  const onlineCount = discovered.filter((d) => d.status === 'online').length;
  const offlineCount = discovered.filter((d) => d.status === 'offline').length;

  return (
    <div className="space-y-4">
      <div className="app-page-header">
        <h1 className="text-2xl font-bold">
          <Globe className="mr-2 inline-block h-7 w-7" />
          网络设备总览
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary" className="h-6 px-2 text-xs">在线 {onlineCount}</Badge>
          <Badge variant="secondary" className="h-6 px-2 text-xs">离线 {offlineCount}</Badge>
          <Button variant="outline" className="h-9" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {onlineCount > 0 ? <Wifi className="h-4 w-4 text-emerald-600" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
            局域网发现的设备（{discovered.length} 台，不含已添加设备，未知状态不显示）
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">设备名称</th>
                <th className="px-3 py-2 text-left font-medium">厂商 / 型号</th>
                <th className="px-3 py-2 text-left font-medium">IP / MAC</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">最后在线</th>
              </tr>
            </thead>
            <tbody>
              {discovered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    暂无未添加的局域网设备（已添加的设备都在仪表盘/对应页面里）
                  </td>
                </tr>
              ) : (
                discovered.map((d) => (
                  <tr key={d.did || d.id} className="border-t">
                    <td className="max-w-[240px] truncate px-3 py-2">{d.name || d.did}</td>
                    <td className="max-w-[260px] truncate px-3 py-2 text-muted-foreground">{d.vendorName || d.model || '-'}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <div>{d.ipAddress || '-'}</div>
                      <div className="text-[11px]">{d.macAddress || ''}</div>
                    </td>
                    <td className="px-3 py-2">{statusBadge(d.status)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatTime(d.lastSyncAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

export default NetworkDevicesPage;
