import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileDown, FileSpreadsheet, FileClock, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { useAuthStore } from '../store/auth';
import { UserRole } from '../types';
import * as api from '../lib/api';

const CATEGORY_OPTIONS = [
  { value: 'all', label: '全部分类' },
  { value: 'auth', label: '账号登录' },
  { value: 'room_power', label: '房间电力' },
  { value: 'network', label: '网络设备' },
  { value: 'camera', label: '摄像头' },
  { value: 'room', label: '房间信息' },
  { value: 'alarm', label: '报警处理' },
  { value: 'device_sync', label: '设备同步' },
  { value: 'system', label: '系统设置' },
  { value: 'other', label: '其他' },
];

export function ExportPage() {
  const { hasPermission } = useAuthStore();
  const canExport = hasPermission([UserRole.ADMIN, UserRole.BOSS]);

  const { data: sites = [] } = useQuery({
    queryKey: ['system-sites'],
    queryFn: api.system.getSites,
    enabled: canExport,
  });

  const [siteId, setSiteId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('all');
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const runExport = async (key: string, fn: () => Promise<void>) => {
    if (!canExport) {
      toast.error('当前账号无导出权限');
      return;
    }
    setLoadingKey(key);
    try {
      await fn();
      toast.success('导出成功，文件已开始下载');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败，请稍后重试');
    } finally {
      setLoadingKey(null);
    }
  };

  const selectedSiteId = siteId === 'all' ? undefined : siteId;
  const selectedCategory = category === 'all' ? undefined : category;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">数据导出</h1>
          <p className="text-xs text-muted-foreground">
            导出 CSV 表格（可用 Excel / WPS 打开并打印），数据与仪表盘、图表、操作日志一致。
          </p>
        </div>
      </div>

      {/* 筛选条件 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">筛选条件</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">区域</Label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="全部区域" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部区域</SelectItem>
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id}>
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">开始日期</Label>
            <Input type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">结束日期</Label>
            <Input type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">操作分类（仅操作记录）</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="全部分类" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 导出项 */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-emerald-500" />
              用电汇总
            </CardTitle>
            <CardDescription className="text-xs">
              每个房间一行：累计电量、今日/昨日/本周/上周/本月/本年用电、费用、限额
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              size="sm"
              disabled={!!loadingKey}
              onClick={() =>
                runExport('summary', () =>
                  api.exportData.energySummary({ siteId: selectedSiteId }),
                )
              }
            >
              {loadingKey === 'summary' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1 h-3.5 w-3.5" />}
              导出用电汇总
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-sky-500" />
              逐日用电明细
            </CardTitle>
            <CardDescription className="text-xs">
              每个房间每天一行：日用电、费用、峰值功率。按所选日期范围导出（默认最近 30 天）
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              size="sm"
              disabled={!!loadingKey}
              onClick={() =>
                runExport('daily', () =>
                  api.exportData.energyDaily({
                    siteId: selectedSiteId,
                    from: from || undefined,
                    to: to || undefined,
                  }),
                )
              }
            >
              {loadingKey === 'daily' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1 h-3.5 w-3.5" />}
              导出逐日用电
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-violet-500" />
              每周用电汇总
            </CardTitle>
            <CardDescription className="text-xs">
              每个房间每周一行（按周一到周日）：周用电、周费用。按所选日期范围导出（默认最近 8 周）
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              size="sm"
              disabled={!!loadingKey}
              onClick={() =>
                runExport('weekly', () =>
                  api.exportData.energyWeekly({
                    siteId: selectedSiteId,
                    from: from || undefined,
                    to: to || undefined,
                  }),
                )
              }
            >
              {loadingKey === 'weekly' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1 h-3.5 w-3.5" />}
              导出每周用电
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileClock className="h-4 w-4 text-amber-500" />
              操作记录
            </CardTitle>
            <CardDescription className="text-xs">
              设备开关、限额调整、账号、摄像头、网络等操作日志。可按分类与日期范围筛选
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              size="sm"
              disabled={!!loadingKey}
              onClick={() =>
                runExport('ops', () =>
                  api.exportData.operations({
                    siteId: selectedSiteId,
                    from: from || undefined,
                    to: to || undefined,
                    category: selectedCategory,
                  }),
                )
              }
            >
              {loadingKey === 'ops' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1 h-3.5 w-3.5" />}
              导出操作记录
            </Button>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        提示：CSV 为 UTF-8 编码，可直接用 Excel / WPS 打开；如需打印，可在表格软件中直接打印。
      </p>
    </div>
  );
}
