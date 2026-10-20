import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { system, type LanScanHistoryDevice, type LanScanHistoryItem } from '../../lib/api';
import { formatShortDateTime } from '../../lib/format';
import {
  DEVICE_CATEGORY_LABEL,
  inferDeviceCategory,
} from '../../types';

function describeCategory(device: LanScanHistoryDevice): string {
  const category = inferDeviceCategory({
    name: device.name,
    model: device.hostname,
    vendor: device.vendor,
    mac: device.mac,
    ip: device.ip,
  });
  return (DEVICE_CATEGORY_LABEL as Record<string, string>)[category] ?? category;
}

export function LanScanHistoryCard({ onChanged }: { onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['lan-scan-history'],
    queryFn: () => system.listLanScanHistory(),
    refetchOnWindowFocus: false,
    staleTime: 3000,
  });

  const items = data?.items ?? [];
  const firstId = items[0]?.id;
  useEffect(() => {
    if (firstId) setExpanded((prev) => (Object.keys(prev).length > 0 ? prev : { [firstId]: true }));
  }, [firstId]);

  const addedKeys = useMemo(() => new Set<string>(), []);

  const addDevice = async (record: LanScanHistoryItem, device: LanScanHistoryDevice) => {
    const key = `${record.id}:${device.ip}`;
    if (addedKeys.has(key)) return;
    setAdding(key);
    try {
      await system.manualAddDevice({
        name: device.name || device.hostname || `设备 ${device.ip}`,
        ip: device.ip,
        mac: device.mac ?? null,
        category: inferDeviceCategory({
          name: device.name,
          model: device.hostname,
          vendor: device.vendor,
          mac: device.mac,
          ip: device.ip,
        }),
        vendor: device.vendor ?? null,
        model: device.hostname ?? null,
      });
      addedKeys.add(key);
      toast.success(`已添加 ${device.name || device.ip} 到设备总览`);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onChanged?.();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '添加设备失败');
    } finally {
      setAdding(null);
    }
  };

  const addAll = async (record: LanScanHistoryItem) => {
    const targets = record.devices ?? [];
    if (targets.length === 0) return;
    setAdding(`all:${record.id}`);
    let success = 0;
    let failed = 0;
    for (const device of targets) {
      const key = `${record.id}:${device.ip}`;
      if (addedKeys.has(key)) continue;
      try {
        await system.manualAddDevice({
          name: device.name || device.hostname || `设备 ${device.ip}`,
          ip: device.ip,
          mac: device.mac ?? null,
          category: inferDeviceCategory({
            name: device.name,
            model: device.hostname,
            vendor: device.vendor,
            mac: device.mac,
            ip: device.ip,
          }),
          vendor: device.vendor ?? null,
          model: device.hostname ?? null,
        });
        addedKeys.add(key);
        success += 1;
      } catch {
        failed += 1;
      }
    }
    setAdding(null);
    if (success > 0) {
      toast.success(`已添加 ${success} 台设备${failed > 0 ? `，${failed} 台失败` : ''}`);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onChanged?.();
    } else {
      toast.error('没有新增设备（可能都已添加过）');
    }
  };

  const clearHistory = async () => {
    if (!window.confirm('确定清空全部扫描记录吗？只删记录，不影响已添加的设备。')) return;
    setClearing(true);
    try {
      await system.clearLanScanHistory();
      await refetch();
      toast.success('扫描记录已清空');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '清空失败');
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <History className="h-5 w-5" />
          扫描记录
          <Badge variant="secondary" className="text-[10px]">
            最近 {items.length} 次
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            刷新
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground hover:text-rose-600"
            onClick={() => void clearHistory()}
            disabled={clearing || items.length === 0}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            清空记录
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            还没有扫描记录。点「添加设备 → 局域网扫描」扫描一次，这里会保留每一次的扫描结果（最近 20 次）。
          </div>
        ) : (
          items.map((record) => {
            const isOpen = !!expanded[record.id];
            const addingAll = adding === `all:${record.id}`;
            return (
              <div key={record.id} className="rounded-md border">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-muted/30"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [record.id]: !prev[record.id] }))
                  }
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium">{formatShortDateTime(record.scannedAt)}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {record.subnet}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    发现 <b className="text-foreground">{record.deviceCount}</b> 台 · Ping 在线{' '}
                    {record.aliveCount} 台 · ARP {record.arpCount} 条
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={!!adding || record.devices.length === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void addAll(record);
                      }}
                    >
                      {addingAll ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="mr-1 h-3 w-3" />
                      )}
                      全部添加
                    </Button>
                  </span>
                </button>
                {isOpen && (
                  <div className="max-h-64 overflow-auto border-t">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/70 text-left">
                        <tr>
                          <th className="px-3 py-1.5">IP</th>
                          <th className="px-3 py-1.5">MAC</th>
                          <th className="px-3 py-1.5">厂商</th>
                          <th className="px-3 py-1.5">自动识别类型</th>
                          <th className="px-3 py-1.5">状态</th>
                          <th className="px-3 py-1.5 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {record.devices.map((device) => {
                          const key = `${record.id}:${device.ip}`;
                          const isAdding = adding === key;
                          const isAdded = addedKeys.has(key);
                          return (
                            <tr key={`${record.id}-${device.ip}`} className="border-t hover:bg-muted/20">
                              <td className="px-3 py-1.5 font-mono">{device.ip}</td>
                              <td className="px-3 py-1.5 font-mono text-muted-foreground">
                                {device.mac ?? '-'}
                              </td>
                              <td className="px-3 py-1.5">{device.vendor ?? '-'}</td>
                              <td className="px-3 py-1.5">{describeCategory(device)}</td>
                              <td className="px-3 py-1.5">
                                {device.pingAlive ? (
                                  <Badge variant="success" className="text-[10px]">
                                    在线
                                  </Badge>
                                ) : device.fromArp ? (
                                  <Badge variant="secondary" className="text-[10px]">
                                    ARP
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-[11px]"
                                  disabled={isAdding || isAdded}
                                  onClick={() => void addDevice(record, device)}
                                >
                                  {isAdding ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Plus className="mr-1 h-3 w-3" />
                                  )}
                                  {isAdded ? '已添加' : '添加'}
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
        <p className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <Wifi className="h-3 w-3" />
          每次扫描自动记录（最多保留 20 次）；可随时把记录里的设备补加到系统，不影响已添加设备。
        </p>
      </CardContent>
    </Card>
  );
}
