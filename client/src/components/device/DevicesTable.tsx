import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { toast } from 'sonner';
import { Cpu, Pencil } from 'lucide-react';
import * as api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { UserRole, DeviceStatus as DS } from '@/types';
import type { DeviceItem, DeviceStatus } from '@/types';
import { formatPower as formatPowerShared, formatEnergy as formatEnergyShared } from '@/lib/format';

const statusVariant: Record<DeviceStatus, 'success' | 'danger' | 'default'> = {
  [DS.ONLINE]: 'success',
  [DS.OFFLINE]: 'danger',
  [DS.UNKNOWN]: 'default',
};

const statusText: Record<DeviceStatus, string> = {
  [DS.ONLINE]: '在线',
  [DS.OFFLINE]: '离线',
  [DS.UNKNOWN]: '未知',
};

const OWNERSHIP_LABEL: Record<NonNullable<DeviceItem['ownership']>, string> = {
  xiaomi: '米家',
  tuya: '涂鸦',
  huawei: '华为云',
  baidu: '百度云',
  tencent: '腾讯云',
  aliyun: '阿里云',
  custom: '自定义',
  other: '其他',
}

const SOURCE_LABEL: Record<NonNullable<DeviceItem['source']>, string> = {
  account_sync: '账号识别设备',
  cloud_api: 'API同步设备',
  custom_api: '自定义API设备',
  lan_discovery: '本地识别设备',
  manual: '手动录入设备',
}

function getDeviceOwnershipLabel(device: DeviceItem) {
  if (device.ownership) return OWNERSHIP_LABEL[device.ownership] ?? '其他'
  return '其他'
}

function getDeviceSourceLabel(device: DeviceItem) {
  if (device.source) return SOURCE_LABEL[device.source] ?? '手动录入设备'
  return '账号识别设备'
}

interface DevicesTableProps {
  devices: DeviceItem[];
  invalidateOnChange?: () => Promise<void> | void;
  compact?: boolean;
}

function formatPower(value: number) {
  return formatPowerShared(value, { valueClassName: 'font-mono font-semibold' });
}

function formatEnergy(value: number) {
  return formatEnergyShared(value, 2, { valueClassName: 'font-mono font-semibold' });
}

export function DevicesTable({ devices, invalidateOnChange, compact = false }: DevicesTableProps) {
  const role = useAuthStore((s) => s.role);
  const canControl = role === UserRole.ADMIN || role === UserRole.BOSS;
  const canRename = canControl;
  const [editingDid, setEditingDid] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [savingName, setSavingName] = useState(false);

  const onControl = async (d: DeviceItem, action: 'on' | 'off') => {
    if (!canControl) {
      toast.error('当前用户没有设备操作权限');
      return;
    }
    try {
      await api.system.controlDevice(d.did, action);
      toast.success(action === 'on' ? '设备已开启' : '设备已关闭');
      if (invalidateOnChange) await invalidateOnChange();
    } catch (e) {
      toast.error(action === 'on' ? '开启设备失败' : '关闭设备失败');
    }
  };

  const startRename = (device: DeviceItem) => {
    setEditingDid(device.did);
    setDraftName(device.name);
  };

  const cancelRename = () => {
    setEditingDid(null);
    setDraftName('');
  };

  const submitRename = async (device: DeviceItem) => {
    const nextName = draftName.trim();
    if (!nextName) {
      toast.error('名称不能为空');
      return;
    }

    try {
      setSavingName(true);
      await api.system.renameDevice(device.did, nextName);
      toast.success('名称已更新');
      cancelRename();
      if (invalidateOnChange) await invalidateOnChange();
    } catch {
      toast.error('修改名称失败');
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div>
      {devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground text-sm gap-2">
          <Cpu className="w-8 h-8 opacity-40" />
          <div>暂无设备数据，请到 系统设置 → 设备同步 → 立即执行同步</div>
        </div>
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {devices.map((d) => (
              <div key={d.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {editingDid === d.did ? (
                      <div className="space-y-2">
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          className="h-8"
                          placeholder="输入设备名称"
                          disabled={savingName}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="h-8 flex-1 text-xs"
                            onClick={() => submitRename(d)}
                            disabled={savingName}
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 flex-1 text-xs"
                            onClick={cancelRename}
                            disabled={savingName}
                          >
                            取消
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{d.name}</span>
                        {canRename && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0"
                            onClick={() => startRename(d)}
                            title="修改设备名称"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={statusVariant[d.status]}>{statusText[d.status]}</Badge>
                      <Badge variant="secondary">{getDeviceOwnershipLabel(d)}</Badge>
                      <span>来源：{getDeviceSourceLabel(d)}</span>
                    </div>
                  </div>
                  {canControl ? (
                    <div className="flex flex-col items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onControl(d, 'on')}
                        disabled={d.status !== 'online'}
                        title="开启"
                        className={
                          'h-8 w-8 shrink-0 rounded-full border transition-colors ' +
                          (d.status === 'online'
                            ? 'border-green-600 bg-green-600 text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50'
                            : 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed')
                        }
                      >
                        <span className="sr-only">开启</span>
                        <div className="mx-auto h-2 w-2 rounded-full bg-white/80" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onControl(d, 'off')}
                        disabled={d.status !== 'online'}
                        title="关闭"
                        className={
                          'h-8 w-8 shrink-0 rounded-full border transition-colors ' +
                          (d.status === 'online'
                            ? 'border-red-600 bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50'
                            : 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed')
                        }
                      >
                        <span className="sr-only">关闭</span>
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="text-xs text-muted-foreground">实时功率</div>
                    <div className="mt-1 font-mono">{d.powerW != null ? formatPower(d.powerW) : '-'}</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="text-xs text-muted-foreground">累计电量</div>
                    <div className="mt-1 font-mono">{d.totalKwh != null ? formatEnergy(d.totalKwh) : '-'}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className={compact ? 'hidden md:block' : 'hidden rounded-md border md:block'}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备名称</TableHead>
                  <TableHead>设备归属</TableHead>
                  <TableHead>识别来源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>DID</TableHead>
                  <TableHead className="text-right">实时功率</TableHead>
                  <TableHead className="text-right">累计电量</TableHead>
                  {canControl && <TableHead className="text-right">操作</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {editingDid === d.did ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            className="h-8 max-w-[220px]"
                          placeholder="输入设备名称"
                            disabled={savingName}
                          />
                          <Button
                            size="sm"
                            variant="default"
                            className="h-8 px-3 text-xs"
                            onClick={() => submitRename(d)}
                            disabled={savingName}
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-3 text-xs"
                            onClick={cancelRename}
                            disabled={savingName}
                          >
                            取消
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span>{d.name}</span>
                          {canRename && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => startRename(d)}
                              title="修改设备名称"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{getDeviceOwnershipLabel(d)}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {getDeviceSourceLabel(d)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant[d.status]}>{statusText[d.status]}</Badge>
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs text-muted-foreground max-w-[180px] truncate"
                      title={d.did}
                    >
                      {d.did}
                    </TableCell>
                    <TableCell className="text-right font-mono">{d.powerW != null ? formatPower(d.powerW) : '-'}</TableCell>
                    <TableCell className="text-right font-mono">{d.totalKwh != null ? formatEnergy(d.totalKwh) : '-'}</TableCell>
                    {canControl && (
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1.5 justify-end">
                          <button
                            type="button"
                            onClick={() => onControl(d, 'on')}
                            disabled={d.status !== 'online'}
                            title="开启"
                            className={
                              'h-8 w-8 shrink-0 rounded-full border transition-colors ' +
                              (d.status === 'online'
                                ? 'border-green-600 bg-green-600 text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50'
                                : 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed')
                            }
                          >
                            <span className="sr-only">开启</span>
                            <div className="mx-auto h-2 w-2 rounded-full bg-white/80" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onControl(d, 'off')}
                            disabled={d.status !== 'online'}
                            title="关闭"
                            className={
                              'h-8 w-8 shrink-0 rounded-full border transition-colors ' +
                              (d.status === 'online'
                                ? 'border-red-600 bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50'
                                : 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed')
                            }
                          >
                            <span className="sr-only">关闭</span>
                          </button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

export default DevicesTable;
