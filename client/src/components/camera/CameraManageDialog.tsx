import { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  RadarIcon,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
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
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';
import {
  system,
  type CameraListItem,
  type LanCameraProbeResult,
  type OnvifDiscoveredCamera,
} from '../../lib/api';
import { cn } from '../../lib/utils';

interface CameraManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lanCameras: CameraListItem[];
  onChanged: () => void;
}

interface CameraFormState {
  name: string;
  ip: string;
  port: string;
  username: string;
  password: string;
  brand: string;
  model: string;
  rtspUrl: string;
  snapshotUrl: string;
  subRtspUrl: string;
  hasPTZ: boolean;
  transcodeH264: boolean;
  preferSubStream: boolean;
}

const EMPTY_FORM: CameraFormState = {
  name: '',
  ip: '',
  port: '80',
  username: 'admin',
  password: '',
  brand: '',
  model: '',
  rtspUrl: '',
  snapshotUrl: '',
  subRtspUrl: '',
  hasPTZ: false,
  transcodeH264: false,
  preferSubStream: true,
};

/** 把 ONVIF 自动识别到的能力翻译成中文标签（只显示支持的功能） */
function describeCapabilities(caps: {
  ptz?: boolean;
  motion?: boolean;
  human?: boolean;
  face?: boolean;
  line?: boolean;
  intrusion?: boolean;
  tamper?: boolean;
  audio?: boolean;
  analytics?: boolean;
} | null | undefined): string[] {
  if (!caps) return [];
  const labels: Array<[boolean | undefined, string]> = [
    [caps.human, '人形侦测'],
    [caps.motion, '移动侦测'],
    [caps.face, '人脸侦测'],
    [caps.line, '越界侦测'],
    [caps.intrusion, '区域入侵'],
    [caps.tamper, '遮挡报警'],
    [caps.audio, '录音'],
    [caps.ptz, '云台'],
  ];
  return labels.filter(([enabled]) => enabled === true).map(([, label]) => label);
}

export function CameraManageDialog({
  open,
  onOpenChange,
  lanCameras,
  onChanged,
}: CameraManageDialogProps) {
  const [form, setForm] = useState<CameraFormState>({ ...EMPTY_FORM });
  const [editingDid, setEditingDid] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyDid, setBusyDid] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<OnvifDiscoveredCamera[]>([]);
  const [probe, setProbe] = useState<LanCameraProbeResult | null>(null);

  const update = <K extends keyof CameraFormState>(key: K, value: CameraFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingDid(null);
    setProbe(null);
    setAdvanced(false);
  };

  useEffect(() => {
    if (!open) {
      resetForm();
      setDiscovered([]);
    }
  }, [open]);

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const result = await system.discoverLanCameras();
      setDiscovered(result.devices ?? []);
      if ((result.devices ?? []).length === 0) {
        toast.info(
          result.errorMessage ||
            '没有发现 ONVIF 设备：请确认摄像头已通电、已开启 ONVIF、与本机在同一局域网，也可以直接手动填写 IP。',
        );
      } else {
        toast.success(`发现 ${result.devices.length} 台 ONVIF 设备`);
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '发现设备失败');
    } finally {
      setDiscovering(false);
    }
  };

  const handleProbe = async () => {
    if (!form.ip.trim()) {
      toast.error('请先填写摄像头 IP');
      return;
    }
    setProbing(true);
    setProbe(null);
    try {
      const result = await system.probeLanCamera({
        ip: form.ip.trim(),
        port: Number(form.port) || 80,
        username: form.username.trim(),
        password: form.password,
        brand: form.brand.trim() || null,
        rtspUrl: form.rtspUrl.trim() || null,
      });
      setProbe(result);
      setForm((prev) => ({
        ...prev,
        brand: prev.brand || result.manufacturer || '',
        model: prev.model || result.model || '',
        rtspUrl: prev.rtspUrl || result.rtspUrl || '',
        subRtspUrl: prev.subRtspUrl || result.subRtspUrl || '',
        snapshotUrl: prev.snapshotUrl || result.snapshotUrl || '',
        hasPTZ: prev.hasPTZ || result.hasPTZ,
        name:
          prev.name ||
          [result.manufacturer, result.model].filter(Boolean).join(' ').trim() ||
          `摄像头 ${result.ip}`,
      }));
      if (result.ok) {
        toast.success(
          result.mode === 'onvif'
            ? 'ONVIF 连接成功，已获取直播地址'
            : 'RTSP 连接成功',
        );
      } else {
        toast.error(result.errorMessage || '连接失败，请检查 IP / 端口 / 账号密码');
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '测试连接失败');
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async () => {
    if (!form.ip.trim()) {
      toast.error('请填写摄像头 IP');
      return;
    }
    const rtspUrl = (form.rtspUrl.trim() || probe?.rtspUrl || '').trim();
    if (!rtspUrl) {
      toast.error('请先点击「测试连接」获取直播地址，或在高级选项里手动填写 RTSP 地址');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim() || undefined,
        ip: form.ip.trim(),
        port: Number(form.port) || 80,
        username: form.username.trim(),
        password: form.password,
        brand: form.brand.trim() || probe?.brand || null,
        model: form.model.trim() || probe?.model || null,
        source: probe?.mode ?? 'onvif',
        rtspUrl,
        subRtspUrl: form.subRtspUrl.trim() || null,
        snapshotUrl: form.snapshotUrl.trim() || null,
        hasPTZ: form.hasPTZ,
        transcodeH264: form.transcodeH264,
        preferSubStream: form.preferSubStream,
        capabilities: probe?.capabilities ?? null,
      } as const;
      if (editingDid) {
        await system.updateLanCamera(editingDid, payload);
        toast.success('摄像头已更新');
      } else {
        await system.createLanCamera(payload);
        toast.success('摄像头已添加，正在打开监控画面…');
      }
      resetForm();
      onChanged();
    } catch (error: any) {
      toast.error(
        error?.response?.data?.message || error?.message || (editingDid ? '更新失败' : '添加失败'),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (cam: CameraListItem) => {
    setBusyDid(cam.did);
    try {
      const result = await system.getLanCameraConfig(cam.did);
      const cfg = result.config;
      setEditingDid(cam.did);
      setProbe(null);
      setAdvanced(true);
      setForm({
        name: cam.name,
        ip: cfg.ip,
        port: String(cfg.port || 80),
        username: cfg.username,
        password: cfg.password,
        brand: cfg.brand ?? '',
        model: cfg.model ?? '',
        rtspUrl: cfg.rtspUrl,
        snapshotUrl: cfg.snapshotUrl ?? '',
        subRtspUrl: cfg.subRtspUrl ?? '',
        hasPTZ: cfg.hasPTZ,
        transcodeH264: cfg.transcodeH264,
        preferSubStream: cfg.preferSubStream !== false,
      });
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '读取摄像头配置失败');
    } finally {
      setBusyDid(null);
    }
  };

  const handleTestSaved = async (cam: CameraListItem) => {
    setBusyDid(cam.did);
    try {
      const result = await system.testLanCamera(cam.did);
      if (result.rtspTest?.ok) {
        toast.success(
          `「${cam.name}」RTSP 连接正常${result.rtspTest.videoInfo ? `（${result.rtspTest.videoInfo}）` : ''}`,
        );
      } else {
        toast.error(result.rtspTest?.errorMessage || 'RTSP 连接失败');
      }
      if (result.stream?.hlsReady) {
        toast.success('HLS 直播流已就绪');
      } else if (result.stream?.errorMessage) {
        toast.warning(result.stream.errorMessage);
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '测试失败');
    } finally {
      setBusyDid(null);
    }
  };

  const handleDelete = async (cam: CameraListItem) => {
    if (!window.confirm(`确定删除摄像头「${cam.name}」吗？录像文件不会被删除。`)) return;
    setBusyDid(cam.did);
    try {
      await system.deleteLanCamera(cam.did);
      toast.success('摄像头已删除');
      if (editingDid === cam.did) resetForm();
      onChanged();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || error?.message || '删除失败');
    } finally {
      setBusyDid(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            摄像头接入管理
          </DialogTitle>
          <DialogDescription>
            接入局域网 ONVIF / RTSP 摄像头（完全本地，不依赖小米云）。支持先「发现设备」或直接填 IP 测试。
          </DialogDescription>
        </DialogHeader>

        {/* 已接入列表 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              已接入的局域网摄像头
              <span className="ml-1 text-xs text-muted-foreground">({lanCameras.length})</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDiscover}
              disabled={discovering}
            >
              {discovering ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RadarIcon className="mr-1.5 h-3.5 w-3.5" />
              )}
              发现 ONVIF 设备
            </Button>
          </div>

          {lanCameras.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              还没有接入局域网摄像头。把摄像头通电、连到同一局域网后，用下方表单添加即可。
            </div>
          ) : (
            <div className="space-y-1.5">
              {lanCameras.map((cam) => (
                <div
                  key={cam.did}
                  className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2"
                >
                  <Badge variant={cam.online ? 'success' : 'secondary'} className="text-[10px]">
                    {cam.online ? '在线' : '离线'}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{cam.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {cam.localIp ?? '-'} · {cam.model || 'ONVIF/RTSP'}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => handleTestSaved(cam)}
                      disabled={busyDid === cam.did}
                      title="测试连接"
                    >
                      {busyDid === cam.did ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => handleEdit(cam)}
                      disabled={busyDid === cam.did}
                      title="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(cam)}
                      disabled={busyDid === cam.did}
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {discovered.length > 0 && (
            <div className="rounded-md border border-emerald-300/40 bg-emerald-50/50 p-2 dark:bg-emerald-950/20">
              <div className="mb-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                发现 {discovered.length} 台 ONVIF 设备（点击使用）
              </div>
              <div className="flex flex-wrap gap-1.5">
                {discovered.map((device) => (
                  <Button
                    key={device.ip}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 font-mono text-xs"
                    onClick={() => {
                      update('ip', device.ip);
                      if (!form.name) update('name', device.name || `摄像头 ${device.ip}`);
                      toast.info(`已填入 ${device.ip}，请补全账号密码后测试连接`);
                    }}
                  >
                    {device.ip}
                    {device.hardware ? ` · ${device.hardware}` : ''}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* 添加/编辑表单 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              {editingDid ? '编辑摄像头' : '添加摄像头'}
              {editingDid && (
                <button
                  type="button"
                  className="ml-2 text-xs text-muted-foreground underline"
                  onClick={resetForm}
                >
                  取消编辑
                </button>
              )}
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced ? '收起高级选项' : '高级选项 / 手动 RTSP'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cam-name">名称</Label>
              <Input
                id="cam-name"
                value={form.name}
                placeholder="例如：门口摄像头"
                onChange={(e) => update('name', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-ip">摄像头 IP</Label>
              <Input
                id="cam-ip"
                value={form.ip}
                placeholder="192.168.41.xxx"
                onChange={(e) => update('ip', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-port">ONVIF 端口</Label>
              <Input
                id="cam-port"
                value={form.port}
                inputMode="numeric"
                placeholder="80"
                onChange={(e) => update('port', e.target.value)}
              />
              <p className="text-[10.5px] text-muted-foreground">
                常见：80 / 8000 / 2020 / 8899（在摄像头 App 的 ONVIF 设置里可查）
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-user">ONVIF 账号</Label>
              <Input
                id="cam-user"
                value={form.username}
                placeholder="admin"
                onChange={(e) => update('username', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-pass">ONVIF 密码</Label>
              <Input
                id="cam-pass"
                type="password"
                value={form.password}
                placeholder="摄像头 ONVIF 密码"
                onChange={(e) => update('password', e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="button" variant="secondary" onClick={handleProbe} disabled={probing}>
                {probing ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-1.5 h-4 w-4" />
                )}
                测试连接
              </Button>
              <Button type="button" onClick={handleSave} disabled={saving || probing}>
                {saving ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1.5 h-4 w-4" />
                )}
                {editingDid ? '保存修改' : '添加摄像头'}
              </Button>
            </div>
          </div>

          {probe && (
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-xs',
                probe.ok
                  ? 'border-emerald-300/50 bg-emerald-50/50 dark:bg-emerald-950/20'
                  : 'border-destructive/40 bg-destructive/5',
              )}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {probe.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                )}
                {probe.ok
                  ? `${probe.mode === 'onvif' ? 'ONVIF' : 'RTSP'} 连接成功`
                  : '连接失败'}
                {probe.rtspTest?.videoInfo ? ` · ${probe.rtspTest.videoInfo}` : ''}
              </div>
              <div className="mt-1 space-y-0.5 text-muted-foreground">
                <div>
                  品牌/型号：{probe.manufacturer || probe.brand || '-'} / {probe.model || '-'}
                </div>
                {probe.rtspTest?.videoInfo && <div>主码流：{probe.rtspTest.videoInfo}</div>}
                {probe.subRtspTest?.videoInfo && <div>子码流：{probe.subRtspTest.videoInfo}</div>}
                <div className="break-all">直播地址：{probe.rtspUrl || '-'}</div>
                {probe.snapshotUrl && (
                  <div className="break-all">快照地址：{probe.snapshotUrl}</div>
                )}
                {probe.ok && (
                  <div>
                    自动识别功能：
                    {describeCapabilities(probe.capabilities).length > 0
                      ? describeCapabilities(probe.capabilities).join(' / ')
                      : '未识别到智能侦测（仅基础监看 + 录像）'}
                  </div>
                )}
                {probe.profiles.length > 0 && (
                  <div>
                    档位：
                    {probe.profiles
                      .map((p) => `${p.name}${p.width ? ` ${p.width}x${p.height}` : ''}${p.encoding ? ` ${p.encoding}` : ''}`)
                      .join(' | ')}
                  </div>
                )}
                {probe.errorMessage && (
                  <div className="text-destructive">{probe.errorMessage}</div>
                )}
                {probe.warnings.map((warning) => (
                  <div key={warning} className="text-amber-600 dark:text-amber-400">
                    {warning}
                  </div>
                ))}
              </div>
            </div>
          )}

          {advanced && (
            <div className="grid grid-cols-1 gap-2.5 rounded-md border bg-muted/20 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="cam-rtsp">直播地址（RTSP，留空则用测试连接的结果）</Label>
                <Input
                  id="cam-rtsp"
                  value={form.rtspUrl}
                  placeholder="rtsp://admin:密码@192.168.41.xxx:554/..."
                  onChange={(e) => update('rtspUrl', e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cam-sub-rtsp">子码流地址（可选）</Label>
                  <Input
                    id="cam-sub-rtsp"
                    value={form.subRtspUrl}
                    onChange={(e) => update('subRtspUrl', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cam-snapshot">快照地址（可选）</Label>
                  <Input
                    id="cam-snapshot"
                    value={form.snapshotUrl}
                    onChange={(e) => update('snapshotUrl', e.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-5 pt-1">
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={form.preferSubStream}
                    onCheckedChange={(checked) => update('preferSubStream', checked)}
                  />
                  直播/录像使用子码流（推荐：H.264 兼容好、省 CPU）
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={form.transcodeH264}
                    onCheckedChange={(checked) => update('transcodeH264', checked)}
                  />
                  强制转码为 H.264（画面无法播放时再打开，4K 转码很吃 CPU）
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={form.hasPTZ}
                    onCheckedChange={(checked) => update('hasPTZ', checked)}
                  />
                  支持云台 PTZ
                </label>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
