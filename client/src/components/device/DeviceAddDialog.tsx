import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Cloud,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Wifi,
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
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { system, type LanProbeDeviceDetail } from '../../lib/api';
import {
  DeviceCategory,
  DEVICE_CATEGORY_LABEL,
  inferDeviceCategory,
} from '../../types';

interface DeviceAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}

interface ScanRow {
  ip: string;
  mac: string | null;
  vendor: string | null;
  name: string | null;
  hostname: string | null;
  pingAlive?: boolean;
  fromArp?: boolean;
}

const CATEGORY_OPTIONS = Object.values(DeviceCategory);

export function DeviceAddDialog({ open, onOpenChange, onAdded }: DeviceAddDialogProps) {
  const queryClient = useQueryClient();
  const [subnet, setSubnet] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [probing, setProbing] = useState(false);
  const [probeMap, setProbeMap] = useState<Record<string, LanProbeDeviceDetail>>({});
  const [busy, setBusy] = useState(false);

  // 手动添加表单
  const [manual, setManual] = useState({
    name: '',
    ip: '',
    mac: '',
    category: DeviceCategory.SMART_APPLIANCE as string,
    vendor: '',
    model: '',
  });

  const { data: xiaomiStatus, isFetching: xiaomiStatusFetching, refetch: refetchXiaomiStatus } = useQuery({
    queryKey: ['xiaomi-status'],
    queryFn: () => system.xiaomiStatus(),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const selectedRows = useMemo(() => rows.filter((row) => selected[row.ip]), [rows, selected]);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const row of rows) next[row.ip] = true;
    setSelected(next);
  };

  const handleAutoSubnet = async () => {
    try {
      const result = await system.detectLanSubnets();
      if (result.subnets.length > 0) {
        setSubnet(result.subnets[0]);
        toast.success(`已检测到网段：${result.subnets[0]}`);
      } else {
        toast.warning('未检测到可用网段，请手动填写（例如 192.168.41.0/24）');
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '检测网段失败');
    }
  };

  /** 一键扫描：自动识别本机所在局域网网段 → 直接开始扫描 */
  const handleAutoScan = async () => {
    try {
      const result = await system.detectLanSubnets();
      const target = result.subnets?.[0] || subnet.trim();
      if (!target) {
        toast.warning('未检测到可用网段，请手动填写（例如 192.168.41.0/24）');
        return;
      }
      setSubnet(target);
      toast.info(`已自动识别本机局域网：${target}，开始扫描…`);
      await handleScan(target);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '自动检测网段失败');
    }
  };

  const handleScan = async (targetOverride?: string) => {
    const target = (targetOverride ?? subnet).trim();
    if (!target) {
      toast.error('请先填写扫描网段（或点「一键扫描本机网络」）');
      return;
    }
    setScanning(true);
    setRows([]);
    setSelected({});
    setProbeMap({});
    setScanStatus(`正在扫描 ${target}，通常需要 15~60 秒…`);
    try {
      const result = await system.lanScan(target, { withVendorRemoteApi: false });
      const sorted = [...(result.devices ?? [])].sort((a, b) =>
        a.ip.localeCompare(b.ip, 'en', { numeric: true }),
      );
      setRows(sorted);
      setScanStatus(
        `扫描完成：${sorted.length} 台设备（Ping 在线 ${result.aliveCount} 台，ARP 记录 ${result.arpCount} 台）`,
      );
      toast.success(`扫描完成，发现 ${sorted.length} 台设备`);
      void queryClient.invalidateQueries({ queryKey: ['lan-scan-history'] });
    } catch (error: any) {
      setScanStatus('');
      toast.error(error?.response?.data?.message || error?.message || '扫描失败');
    } finally {
      setScanning(false);
    }
  };

  const handleProbe = async () => {
    const targets = selectedRows.length > 0 ? selectedRows : rows;
    if (targets.length === 0) {
      toast.error('请先扫描设备');
      return;
    }
    const limited = targets.slice(0, 128);
    setProbing(true);
    setScanStatus(`正在探测 ${limited.length} 台设备的端口 / 品牌 / 能力…`);
    try {
      const result = await system.probeLanDevices(
        limited.map((row) => ({
          ip: row.ip,
          mac: row.mac,
          vendor: row.vendor,
          name: row.name,
          hostname: row.hostname,
        })),
      );
      const next: Record<string, LanProbeDeviceDetail> = { ...probeMap };
      for (const item of result.devices ?? []) next[item.ip] = item;
      setProbeMap(next);
      setScanStatus(`端口探测完成：${result.devices?.length ?? 0} 台`);
      toast.success('设备详情探测完成');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '端口探测失败');
    } finally {
      setProbing(false);
    }
  };

  const resolveCategory = (row: ScanRow): string => {
    const detail = probeMap[row.ip];
    if (detail?.suggestedCategory) return detail.suggestedCategory;
    return inferDeviceCategory({
      name: row.name,
      model: row.hostname,
      vendor: row.vendor,
      mac: row.mac,
      ip: row.ip,
    });
  };

  const handleAddSelected = async () => {
    if (selectedRows.length === 0) {
      toast.error('请勾选要添加的设备');
      return;
    }
    setBusy(true);
    let success = 0;
    let failed = 0;
    for (const row of selectedRows) {
      const detail = probeMap[row.ip];
      const category = resolveCategory(row);
      try {
        await system.manualAddDevice({
          name: row.name || row.hostname || detail?.roleLabel || `设备 ${row.ip}`,
          ip: row.ip,
          mac: row.mac,
          category,
          vendor: row.vendor ?? null,
          model: detail?.httpTitle ?? row.hostname ?? null,
        });
        success += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (success > 0) {
      toast.success(`已添加 ${success} 台设备${failed > 0 ? `，失败 ${failed} 台` : ''}`);
      setSelected({});
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onAdded();
    } else {
      toast.error('添加失败，请查看后端日志');
    }
  };

  const handleXiaomiSync = async () => {
    try {
      setBusy(true);
      await system.xiaomiSync();
      toast.success('米家云设备已同步');
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['xiaomi-status'] });
      onAdded();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '同步失败');
    } finally {
      setBusy(false);
    }
  };

  const handleManualAdd = async () => {
    if (!manual.name.trim() || !manual.ip.trim()) {
      toast.error('请填写设备名称和 IP');
      return;
    }
    try {
      setBusy(true);
      await system.manualAddDevice({
        name: manual.name.trim(),
        ip: manual.ip.trim(),
        mac: manual.mac.trim() || null,
        category: manual.category,
        vendor: manual.vendor.trim() || null,
        model: manual.model.trim() || null,
      });
      toast.success('设备已添加');
      setManual({ name: '', ip: '', mac: '', category: DeviceCategory.SMART_APPLIANCE, vendor: '', model: '' });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onAdded();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '添加失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            添加设备
          </DialogTitle>
          <DialogDescription>
            选择接入方式：扫描局域网自动识别，或从米家云同步，或手动填写设备信息。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="lan" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="lan" className="gap-1.5">
              <Radar className="h-3.5 w-3.5" />
              局域网扫描
            </TabsTrigger>
            <TabsTrigger value="xiaomi" className="gap-1.5">
              <Cloud className="h-3.5 w-3.5" />
              米家云同步
            </TabsTrigger>
            <TabsTrigger value="manual" className="gap-1.5">
              <Wifi className="h-3.5 w-3.5" />
              手动添加
            </TabsTrigger>
          </TabsList>

          {/* ───────── 局域网扫描 ───────── */}
          <TabsContent value="lan" className="mt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1 space-y-1.5">
                <Label htmlFor="scan-subnet">扫描网段</Label>
                <Input
                  id="scan-subnet"
                  value={subnet}
                  placeholder="例如 192.168.41.0/24"
                  onChange={(e) => setSubnet(e.target.value)}
                />
              </div>
              <Button type="button" variant="outline" onClick={handleAutoSubnet}>
                <Search className="mr-1.5 h-4 w-4" />
                自动检测
              </Button>
              <Button type="button" onClick={() => handleScan()} disabled={scanning}>
                {scanning ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Radar className="mr-1.5 h-4 w-4" />
                )}
                开始扫描
              </Button>
              <Button type="button" variant="secondary" onClick={handleAutoScan} disabled={scanning || probing}>
                {scanning ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Wifi className="mr-1.5 h-4 w-4" />
                )}
                一键扫描本机网络
              </Button>
              <Button type="button" variant="secondary" onClick={handleProbe} disabled={probing || rows.length === 0}>
                {probing ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                )}
                端口/能力探测
              </Button>
            </div>

            {scanStatus && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {scanStatus}
              </div>
            )}

            {rows.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={toggleAll}>
                    {allSelected ? '取消全选' : '全选'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAddSelected}
                    disabled={busy || selectedRows.length === 0}
                  >
                    {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                    添加选中（{selectedRows.length}）
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    共 {rows.length} 台；探测后可看到端口、品牌与设备类型
                  </span>
                </div>

                <div className="max-h-[46vh] overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/80 text-left">
                      <tr>
                        <th className="w-8 px-2 py-1.5" />
                        <th className="px-2 py-1.5">IP</th>
                        <th className="px-2 py-1.5">MAC</th>
                        <th className="px-2 py-1.5">厂商</th>
                        <th className="px-2 py-1.5">设备类型（自动识别）</th>
                        <th className="px-2 py-1.5">端口 / 能力</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const detail = probeMap[row.ip];
                        const category = resolveCategory(row);
                        return (
                          <tr key={row.ip} className="border-t hover:bg-muted/20">
                            <td className="px-2 py-1.5">
                              <input
                                type="checkbox"
                                checked={!!selected[row.ip]}
                                onChange={(e) =>
                                  setSelected((prev) => ({ ...prev, [row.ip]: e.target.checked }))
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5 font-mono">{row.ip}</td>
                            <td className="px-2 py-1.5 font-mono text-muted-foreground">{row.mac ?? '-'}</td>
                            <td className="px-2 py-1.5">{row.vendor ?? '-'}</td>
                            <td className="px-2 py-1.5">
                              {detail ? (
                                <div className="space-y-0.5">
                                  <Badge variant="secondary" className="text-[10px]">
                                    {detail.roleLabel}
                                  </Badge>
                                  {detail.miioSupported && (
                                    <Badge variant="success" className="ml-1 text-[10px]">
                                      支持小米本地控制
                                    </Badge>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">
                                  {(DEVICE_CATEGORY_LABEL as Record<string, string>)[category] ?? category}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              {detail ? (
                                <div className="space-y-0.5">
                                  {detail.openTcpPorts.length > 0 ? (
                                    <div className="font-mono text-[10.5px] text-muted-foreground">
                                      开放端口：{detail.openTcpPorts.join(', ')}
                                    </div>
                                  ) : (
                                    <div className="text-[10.5px] text-muted-foreground">
                                      {detail.miioSupported ? 'UDP 54321（小米本地协议）' : '未发现开放端口'}
                                    </div>
                                  )}
                                  {(detail.httpTitle || detail.httpDescription) && (
                                    <div className="truncate text-[10.5px] text-muted-foreground">
                                      页面：{detail.httpTitle || detail.httpDescription}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">点「端口/能力探测」</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10.5px] text-muted-foreground">
                  提示：摄像头建议到「监控墙 → 添加摄像头」接入（可自动识别 ONVIF 能力）；这里添加的设备会出现在仪表盘/设备总览。
                </p>
              </>
            )}
          </TabsContent>

          {/* ───────── 米家云同步 ───────── */}
          <TabsContent value="xiaomi" className="mt-3 space-y-3">
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">米家云账号</span>
                {xiaomiStatusFetching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : xiaomiStatus?.loggedIn ? (
                  <Badge variant="success" className="text-[10px]">
                    已登录 {(xiaomiStatus as any)?.region ? `(${(xiaomiStatus as any).region})` : ''}
                    {xiaomiStatus.username ? ` · ${xiaomiStatus.username}` : ''}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">未登录</Badge>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7"
                  onClick={() => refetchXiaomiStatus()}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  刷新状态
                </Button>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {xiaomiStatus?.loggedIn
                  ? '登录后会从米家云同步设备列表；具体设备数据仍优先走本地局域网，云端作为兜底。'
                  : '请先到「系统设置 → 设备接入 → 米家账号」完成登录（支持国内/欧洲区账号）。'}
              </div>
              <div className="mt-2 flex gap-2">
                <Button type="button" onClick={handleXiaomiSync} disabled={busy || !xiaomiStatus?.loggedIn}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
                  立即同步米家设备
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* ───────── 手动添加 ───────── */}
          <TabsContent value="manual" className="mt-3 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="manual-name">设备名称</Label>
                <Input
                  id="manual-name"
                  value={manual.name}
                  placeholder="例如：客厅路由器"
                  onChange={(e) => setManual((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-ip">IP 地址</Label>
                <Input
                  id="manual-ip"
                  value={manual.ip}
                  placeholder="192.168.41.xxx"
                  onChange={(e) => setManual((prev) => ({ ...prev, ip: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-category">设备类型</Label>
                <Select
                  value={manual.category}
                  onValueChange={(value) => setManual((prev) => ({ ...prev, category: value }))}
                >
                  <SelectTrigger id="manual-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((category) => (
                      <SelectItem key={category} value={category}>
                        {(DEVICE_CATEGORY_LABEL as Record<string, string>)[category] ?? category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-mac">MAC 地址（可选）</Label>
                <Input
                  id="manual-mac"
                  value={manual.mac}
                  placeholder="AA:BB:CC:DD:EE:FF"
                  onChange={(e) => setManual((prev) => ({ ...prev, mac: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-vendor">厂商（可选）</Label>
                <Input
                  id="manual-vendor"
                  value={manual.vendor}
                  placeholder="例如：华为 / Nokia"
                  onChange={(e) => setManual((prev) => ({ ...prev, vendor: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-model">型号（可选）</Label>
                <Input
                  id="manual-model"
                  value={manual.model}
                  placeholder="例如：H122-373"
                  onChange={(e) => setManual((prev) => ({ ...prev, model: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={handleManualAdd} disabled={busy}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                添加设备
              </Button>
              <span className="text-xs text-muted-foreground">
                手动添加不会自动探测设备；适合已知 IP 的路由器/网关/打印机等。
              </span>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
