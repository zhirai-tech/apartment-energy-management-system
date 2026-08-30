import { OperationType, DeviceStatus as PrismaDeviceStatus } from '@prisma/client';
import {
  SystemSettingsData,
  SiteSummary,
  SiteCreateRequest,
  SiteUpdateRequest,
  DeviceCategory,
  DEVICE_CATEGORY_LABEL,
  inferDeviceCategory,
  isManagedDeviceCategory,
  FiveGCpeRuntime,
  WifiApRuntime,
  MeshNodeRuntime,
  networkGroupKey,
  pickPrimaryPublicNetworkDevice,
  inferPublicNetworkRole,
  normalizeMac,
  inferShortDeviceName,
  mapPublicRoleToMeshRole,
} from '@shared/index';
import prisma from '../../lib/prisma';
import { probeLanDeviceReachability } from '../../lib/lan-scan';
import { writeOperation } from '../../lib/logger';
import { AppError } from '../../lib/errors';
import { xiaomiAdapter } from './xiaomi.adapter';
import { localDeviceAdapter } from './local-device.adapter';
import { HuaweiCpeAdapter } from './huawei-cpe.adapter';
import { NokiaBeaconAdapter } from './nokia-beacon.adapter';
import { broadcastDashboard } from '../../lib/socket';
import { DEFAULT_BUSINESS_TIMEZONE, normalizeBusinessTimeZone } from '../../lib/business-time';
import { OperationActorContext } from '../../lib/operation-log';
import { formatRoomDisplayName, normalizeRoomAnnotation } from '../../lib/room-display';
import { resolveOfflineSince } from '../../lib/device-runtime';
import { buildBasicAuthHeader, buildBasicAuthToken, buildDigestAuthHeader, normalizeAuthType } from '../../lib/http-auth';
import { CloudHlsProxyManager } from './lib/cloud-hls-proxy';
import crypto from 'crypto';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { spawn, spawnSync, ChildProcessByStdio } from 'child_process';
import { Readable as NodeReadable } from 'stream';
import {
  DEFAULT_SETTINGS,
  ALARM_RATIO_KEYS,
  BOOLEAN_SETTING_KEYS,
  STRING_SETTING_KEYS,
  PRICE_AUTO_REFRESH_INTERVAL_MS,
  ELECTRICITY_PRICE_REFERENCE_MAP,
  type SettingsKey,
  isAlarmRatioKey,
  normalizeAlarmRatioValue,
  normalizeRefreshIntervalValue,
  normalizeLookupText,
  loadSettingsFromDb,
  persistSettingsPartial,
  resolveReferenceElectricityPrice as resolveRefPrice,
} from './lib/system-settings.helper';
void ELECTRICITY_PRICE_REFERENCE_MAP;
void ALARM_RATIO_KEYS;

interface CameraArmState {
  rtspUrl: string;
  armedAt: number;
  motionState: 'idle' | 'recording';
  lastMotionAt: number;
  ringProc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null;
  detectProc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null;
  recProc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null;
  ringDir: string;
  stagingDir: string | null;
  liveDir: string | null;
  pollTimer: NodeJS.Timeout | null;
}

interface ContinuousRecordingState {
  rtspUrl: string;
  proc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null;
  startedAt: number;
  segmentMinutes: number;
}

// 录制计划规则：mode=motion 智能侦测录像 / continuous 连续录像；days 0=周日…6=周六
export interface CameraScheduleRule {
  id: string;
  did: string;
  enabled: boolean;
  mode: 'motion' | 'continuous';
  days: number[];
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

class SystemService {
  private cameraStreamProcesses = new Map<string, {
    proc: ChildProcessByStdio<null, NodeReadable, NodeReadable>;
    startedAt: number;
    rtspUrl: string;
    hlsDir: string;
  }>();

  // 云端 HLS 本地代理（自动续流）：逻辑已拆至 ./lib/cloud-hls-proxy.ts，
  // SystemService 仅保留对外委托接口（controller 调用不变）。
  private cloudHlsProxy = new CloudHlsProxyManager({
    getHlsDir: (did) => this.getHlsDir(did),
    isHlsReady: (out, maxAgeMs) => this.isHlsReady(out, maxAgeMs),
    waitForHlsReadyOrExit: (did, timeoutMs) => this.waitForHlsReadyOrExit(did, timeoutMs),
    buildInputArgs: (url) => this.buildInputArgs(url),
  });

  private cameraArmStates = new Map<string, CameraArmState>();

  private continuousRecordingStates = new Map<string, ContinuousRecordingState>();

  // ──── 摄像头录制设置（灵敏度 / 尾留秒数 / 预录秒数），存于 data/camera-settings.json ────
  private cameraSettingsFile = path.resolve(process.cwd(), 'data', 'camera-settings.json');
  private cameraMotionSettings = {
    threshold: Number(process.env.CAMERA_MOTION_THRESHOLD) || 0.04,
    tailSeconds: Number(process.env.CAMERA_TAIL_SECONDS) || 60,
    ringSeconds: 60,
  };

  // ──── 录制计划（自动布防），存于 data/camera-schedules.json ────
  private cameraSchedulesFile = path.resolve(process.cwd(), 'data', 'camera-schedules.json');
  private cameraSchedules: CameraScheduleRule[] = [];
  private scheduleEngineTimer: NodeJS.Timeout | null = null;
  // rule.id → 当前已启动的录制类型（motion | continuous），用于幂等启动/停止
  private scheduleActive = new Map<string, 'motion' | 'continuous'>();

  constructor() {
    this.loadCameraMotionSettings();
    this.loadCameraSchedules();
  }

  private safeStringifyModel(obj: unknown, maxLen = 1024): string {
    let current: unknown = obj;
    let result: string | null = null;
    for (let pass = 0; pass < 10; pass += 1) {
      try {
        result = JSON.stringify(current);
      } catch {
        result = null;
      }
      if (result == null) break;
      if (result.length <= maxLen) return result;
      const rc = current as Record<string, unknown> | null;
      if (!rc || typeof rc !== 'object' || Array.isArray(rc)) break;
      const cam = rc.camera as Record<string, unknown> | null | undefined;
      if (cam && typeof cam === 'object' && !Array.isArray(cam) && Array.isArray(cam.snapshotCandidates)) {
        const candidates = cam.snapshotCandidates as unknown[];
        if (candidates.length > 0) {
          const next = { ...rc, camera: { ...cam, snapshotCandidates: candidates.slice(0, Math.max(0, candidates.length - 2)) } };
          current = next;
          continue;
        }
      }
      if (cam && typeof cam === 'object' && !Array.isArray(cam)) {
        current = { ...rc, camera: undefined };
        continue;
      }
      if ('_raw' in rc && typeof rc._raw === 'string' && (rc._raw as string).length > 80) {
        current = { ...rc, _raw: (rc._raw as string).slice(0, 80) };
        continue;
      }
      if (typeof rc.hostname === 'string' && rc.hostname) {
        current = { ...rc, hostname: undefined };
        continue;
      }
      if (typeof rc.discoveryName === 'string' && rc.discoveryName) {
        current = { ...rc, discoveryName: undefined };
        continue;
      }
      break;
    }
    if (typeof result === 'string' && result.length > maxLen) {
      const marker = '…trunc';
      const head = result.slice(0, Math.max(0, maxLen - marker.length - 2));
      const guessQuoteMatch = head.match(/^".*"$/);
      if (guessQuoteMatch) return head.slice(1, -1).slice(0, maxLen - marker.length) + marker;
      return head + marker;
    }
    return typeof result === 'string' ? result : String(obj ?? '');
  }

  private async probeLanCameraSnapshotOnline(
    parsed: Record<string, unknown>,
    camObj: Record<string, unknown>,
  ): Promise<boolean> {
    const manualUrl =
      typeof camObj.manualSnapshotUrl === 'string' && camObj.manualSnapshotUrl.trim()
        ? camObj.manualSnapshotUrl.trim()
        : null;
    const manualUser =
      typeof camObj.manualAuthUsername === 'string' && camObj.manualAuthUsername.trim()
        ? camObj.manualAuthUsername.trim()
        : '';
    const manualPass =
      typeof camObj.manualAuthPassword === 'string' && camObj.manualAuthPassword.trim()
        ? camObj.manualAuthPassword.trim()
        : '';
    const manualAuthType = normalizeAuthType(camObj.manualAuthType);
    const hasManualAuth = !!(manualUser || manualPass);
    const parsedIp =
      typeof parsed.ipAddress === 'string' && parsed.ipAddress.trim()
        ? parsed.ipAddress.trim()
        : null;

    const candidates = Array.isArray(camObj.snapshotCandidates)
      ? (camObj.snapshotCandidates as Array<Record<string, unknown>>)
      : [];
    const httpCandidates = candidates
      .filter((entry) => typeof entry?.url === 'string' && /^https?:/i.test(String(entry.url)))
      .map((entry) => ({
        url: String(entry.url),
        auth: normalizeAuthType(entry.auth),
      }));

    const urls = [
      ...(manualUrl ? [{ url: manualUrl, auth: manualAuthType }] : []),
      ...httpCandidates,
      ...(parsedIp
        ? [
            { url: `http://${parsedIp}/ISAPI/Streaming/channels/101/picture`, auth: 'digest' as const },
            { url: `http://${parsedIp}/cgi-bin/snapshot.cgi?channel=1`, auth: 'digest' as const },
            { url: `http://${parsedIp}/stream/snapshot`, auth: 'digest' as const },
            { url: `http://${parsedIp}/tmpfs/auto.jpg`, auth: 'digest' as const },
          ]
        : []),
    ];

    const tried = new Set<string>();
    for (const entry of urls) {
      if (!entry.url || tried.has(entry.url)) continue;
      tried.add(entry.url);

      const headers: Record<string, string> = {};
      const authPreference = hasManualAuth ? manualAuthType : entry.auth;
      if (hasManualAuth && authPreference === 'basic' && manualUser) {
        headers.Authorization = buildBasicAuthHeader(manualUser, manualPass);
      }

      try {
        const resp = await axios.get(entry.url, {
          headers,
          timeout: 3500,
          responseType: 'arraybuffer',
          validateStatus: () => true,
        });

        if (resp.status === 401 && hasManualAuth && authPreference === 'digest' && manualUser) {
          const www = resp.headers['www-authenticate'] || resp.headers['WWW-Authenticate'];
          const wwwStr = Array.isArray(www) ? www[0] : www;
          if (typeof wwwStr === 'string' && /digest/i.test(wwwStr)) {
            const authz = buildDigestAuthHeader('GET', entry.url, manualUser, manualPass, wwwStr);
            const retry = await axios.get(entry.url, {
              headers: { ...headers, Authorization: authz },
              timeout: 4000,
              responseType: 'arraybuffer',
              validateStatus: () => true,
            });
            const ct = String(retry.headers['content-type'] || '').toLowerCase();
            if (retry.status >= 200 && retry.status < 300 && (/^image\//i.test(ct) || /\.jpe?g($|\?)/i.test(entry.url))) {
              return true;
            }
          }
          continue;
        }

        const ct = String(resp.headers['content-type'] || '').toLowerCase();
        if (resp.status >= 200 && resp.status < 300 && (/^image\//i.test(ct) || /\.jpe?g($|\?)/i.test(entry.url))) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  public getStreamRoot(): string {
    return path.resolve(process.cwd(), 'streams');
  }

  public getHlsDir(did: string): string {
    return path.join(this.getStreamRoot(), 'hls', did);
  }

  /**
   * HLS 是否就绪：m3u8 必须存在、非空且最近被刷新（实时流不断重写），
   * 防止把残留的旧录像文件误判为实时流（此前导致前端播放过期录像）。
   */
  public isHlsReady(hlsOutFile: string, maxAgeMs = 8000): boolean {
    try {
      if (!fs.existsSync(hlsOutFile)) return false;
      const st = fs.statSync(hlsOutFile);
      if (st.size <= 0) return false;
      return Date.now() - st.mtimeMs < maxAgeMs;
    } catch {
      return false;
    }
  }

  /** 轮询等待 ffmpeg 实际写出实时切片，超时返回 false */
  public async waitForHlsReady(did: string, timeoutMs = 15000): Promise<boolean> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const hlsOutFile = path.join(this.getHlsDir(safeDid), 'stream.m3u8');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isHlsReady(hlsOutFile)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /**
   * 等待 ffmpeg 出流；若 ffmpeg 进程提前崩溃/退出（例如云端 rtsps 连接失败），
   * 立即返回当前 hlsReady 状态，避免白白等待超时。用于“低延迟路径失败后快速
   * 回退云端 HLS”的场景。
   */
  public async waitForHlsReadyOrExit(did: string, timeoutMs = 6000): Promise<boolean> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const hlsOutFile = path.join(this.getHlsDir(safeDid), 'stream.m3u8');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isHlsReady(hlsOutFile)) return true;
      const existing = this.cameraStreamProcesses.get(safeDid);
      if (existing?.proc && existing.proc.exitCode !== null) {
        // ffmpeg 已退出：没有出流就是失败，马上返回
        return this.isHlsReady(hlsOutFile);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return this.isHlsReady(hlsOutFile);
  }

  /**
   * 局域网设备开关控制（不依赖厂商云，走本地适配器）。
   * 设备必须已配置 localip + controlProtocol + controlConfig。
   */
  public async getLocalControlDevice(did: string) {
    return prisma.device.findUnique({
      where: { did },
      select: { did: true, localip: true, controlProtocol: true, controlConfig: true },
    });
  }

  public async controlLocalLanDevice(
    did: string,
    action: 'on' | 'off',
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ mode: 'local'; ok: boolean }> {
    const device = await prisma.device.findUnique({
      where: { did },
      select: {
        did: true,
        name: true,
        model: true,
        localip: true,
        controlProtocol: true,
        controlConfig: true,
        roomId: true,
        room: { select: { roomNumber: true, name: true } },
      },
    });
    if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '设备不存在');
    if (!device.controlProtocol || !device.localip) {
      throw new AppError(400, 'DEVICE_NOT_LOCAL', '该设备未配置局域网控制，请在设备设置中填写控制参数');
    }
    let cfg: unknown = device.controlConfig;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = null;
      }
    }
    // 把协议类型合并进配置（适配器按 cfg.protocol 分派）
    const cfgWithProtocol = {
      ...((cfg && typeof cfg === 'object' ? cfg : {}) as object),
      protocol: device.controlProtocol,
    };
    try {
      await localDeviceAdapter.control(device.localip, cfgWithProtocol as any, action);
    } catch (e: any) {
      throw new AppError(502, 'LOCAL_CONTROL_FAILED', `局域网控制失败：${e?.message || String(e)}`);
    }
    await prisma.device.update({
      where: { did },
      data: {
        power: action === 'on',
        status: PrismaDeviceStatus.online,
        lastSyncAt: new Date(),
      },
    });
    await writeOperation(
      operatorUserId,
      OperationType.control_device,
      device.roomId,
      {
        action: action === 'on' ? 'turn_on' : 'turn_off',
        actionLabel: action === 'on' ? '局域网开电' : '局域网断电',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        roomNumber: device.room?.roomNumber,
        roomName: device.room?.name,
        deviceName: device.name,
        did,
        powerAction: action,
        mode: 'local',
      },
      true,
    );
    return { mode: 'local', ok: true };
  }

  /** 读取局域网设备的控制配置 */
  public async getDeviceControlConfig(did: string) {
    const device = await prisma.device.findUnique({
      where: { did },
      select: {
        did: true,
        name: true,
        localip: true,
        controlProtocol: true,
        controlConfig: true,
        controlUpdatedAt: true,
      },
    });
    if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '设备不存在');
    let cfg: unknown = device.controlConfig;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = null;
      }
    }
    return {
      did,
      name: device.name,
      localip: device.localip,
      controlProtocol: device.controlProtocol,
      controlConfig: cfg,
      controlUpdatedAt: device.controlUpdatedAt,
    };
  }

  /** 保存局域网设备的控制配置（协议 + 参数 + IP） */
  public async saveDeviceControlConfig(
    did: string,
    input: { localip?: string; controlProtocol?: string; controlConfig?: unknown },
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ) {
    const device = await prisma.device.findUnique({ where: { did } });
    if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '设备不存在');
    const localip = String(input.localip ?? '').trim() || null;
    const controlProtocol = input.controlProtocol ? String(input.controlProtocol) : null;
    const controlConfig = (input.controlConfig ?? null) as any;
    const updated = await prisma.device.update({
      where: { did },
      data: {
        localip,
        controlProtocol,
        controlConfig,
        controlUpdatedAt: new Date(),
      },
    });
    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      device.roomId,
      {
        action: 'update_local_control',
        actionLabel: '配置局域网设备控制',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        deviceName: device.name,
        did,
        protocol: controlProtocol,
        localip,
      },
      true,
    );
    return { ok: true, did, localip, controlProtocol, name: updated.name };
  }

  /** 测试局域网设备控制配置（不落库） */
  public async testDeviceControlConfig(input: {
    localip?: string;
    controlProtocol?: string;
    controlConfig?: unknown;
    action?: 'on' | 'off';
  }) {
    const localip = String(input.localip ?? '').trim();
    const protocol = input.controlProtocol ? String(input.controlProtocol) : '';
    if (!localip) throw new AppError(400, 'IP_REQUIRED', '请填写设备 IP 地址');
    if (!protocol) throw new AppError(400, 'PROTOCOL_REQUIRED', '请选择控制协议');
    const cfg = { ...((input.controlConfig ?? {}) as object), protocol };
    if (input.action === 'on' || input.action === 'off') {
      await localDeviceAdapter.control(localip, cfg as any, input.action);
      return { ok: true, action: input.action, mode: protocol };
    }
    const state = await localDeviceAdapter.readState(localip, cfg as any);
    return { ok: state.reachable, mode: protocol, state };
  }

  public prismaWrap<T>(fn: (prismaInstance: typeof prisma) => Promise<T>): Promise<T> {
    return fn(prisma);
  }

  public async ensureCameraStreamProxy(
    did: string,
    rtspUrl: string,
    meta?: { model?: string; name?: string; transcodeH264?: boolean },
  ): Promise<{
    hlsUrl: string | null;
    webrtcUrl: string | null;
    hlsReady: boolean;
    proxyMode: 'ffmpeg-hls' | 'mediamtx' | 'none';
    startedAt: number | null;
    processId: number | null;
    ffmpegAvailable: boolean;
    errorMessage?: string;
  }> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const hlsDir = this.getHlsDir(safeDid);
    const hlsOutFile = path.join(hlsDir, 'stream.m3u8');
    const publicBase = `/streams/hls/${encodeURIComponent(safeDid)}`;
    const hlsUrl = `${publicBase}/stream.m3u8`;

    let ffmpegAvailable = false;
    try {
      const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
      ffmpegAvailable = probe.status === 0 && !probe.error;
    } catch {
      ffmpegAvailable = false;
    }

    const existing = this.cameraStreamProcesses.get(safeDid);
    if (existing && existing.proc && !existing.proc.killed && existing.rtspUrl === rtspUrl) {
      const hlsReady = this.isHlsReady(hlsOutFile);
      return {
        hlsUrl,
        webrtcUrl: null,
        hlsReady,
        proxyMode: 'ffmpeg-hls',
        startedAt: existing.startedAt,
        processId: existing.proc.pid ?? null,
        ffmpegAvailable,
      };
    }

    if (existing && existing.proc) {
      try { existing.proc.kill('SIGKILL'); } catch { /* noop */ }
      this.cameraStreamProcesses.delete(safeDid);
    }

    try {
      fs.mkdirSync(hlsDir, { recursive: true });
    } catch (err: any) {
      return {
        hlsUrl: null,
        webrtcUrl: null,
        hlsReady: false,
        proxyMode: 'none',
        startedAt: null,
        processId: null,
        ffmpegAvailable,
        errorMessage: `创建 HLS 切片目录失败：${err?.message || String(err)}`,
      };
    }

    // 启动新进程前清空旧切片，避免前端播放残留录像（旧 m3u8/ts）
    try {
      for (const f of fs.readdirSync(hlsDir)) {
        if (/\.(m3u8|ts)$/i.test(f)) {
          try { fs.unlinkSync(path.join(hlsDir, f)); } catch { /* noop */ }
        }
      }
    } catch { /* noop */ }

    const ffmpegArgs = [
      ...this.buildInputArgs(rtspUrl),
      '-an',
      ...(meta?.transcodeH264
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-crf', '23', '-g', '12', '-sc_threshold', '0']
        : ['-c:v', 'copy']),
      '-hls_time', '0.5',
      '-hls_list_size', '4',
      '-hls_flags', 'delete_segments+append_list+independent_segments',
      '-hls_allow_cache', '0',
      '-y',
      hlsOutFile,
    ];
    let proc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null = null;
    let startedAt = 0;
    let spawnError: string | null = null;
    try {
      const spawned = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      proc = spawned as unknown as ChildProcessByStdio<null, NodeReadable, NodeReadable>;
      startedAt = Date.now();
      proc.on('error', (err) => {
        spawnError = err?.message || String(err);
        console.warn('[StreamProxy] ffmpeg spawn error did=', safeDid, 'err=', spawnError);
        this.cameraStreamProcesses.delete(safeDid);
      });
      proc.on('exit', (code, signal) => {
        console.warn('[StreamProxy] ffmpeg exit did=', safeDid, 'code=', code, 'signal=', signal);
        // 完整 stderr 落盘，便于排查 rtsps/转码类问题（不再只保留最后 2000 字符）
        try {
          fs.writeFileSync(path.join(hlsDir, 'ffmpeg-stderr.log'), stderrBuf || '(empty)', 'utf8');
        } catch { /* noop */ }
        console.warn('[StreamProxy] ffmpeg stderr did=', safeDid, '=>', (stderrBuf || '(empty)').slice(-3000));
        this.cameraStreamProcesses.delete(safeDid);
        // 流已结束：删除 m3u8，避免残留旧文件被误判为 hlsReady（防止前端播放旧录像）
        try {
          if (fs.existsSync(hlsOutFile)) fs.unlinkSync(hlsOutFile);
        } catch { /* noop */ }
      });
      let stderrBuf = '';
      proc.stderr.on('data', (chunk: unknown) => {
        stderrBuf += String(chunk || '');
        if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000);
      });
      proc.stdout.on('data', () => { /* consume */ });
      this.cameraStreamProcesses.set(safeDid, {
        proc,
        startedAt,
        rtspUrl,
        hlsDir,
      });
    } catch (err: any) {
      proc = null;
      spawnError = err?.message || String(err) || 'ffmpeg 不可用（请将 ffmpeg.exe 放到 PATH 或 server/ 目录）';
    }

    const hlsReady = this.isHlsReady(hlsOutFile);
    type StreamResult = {
      hlsUrl: string | null;
      webrtcUrl: string | null;
      hlsReady: boolean;
      proxyMode: 'ffmpeg-hls' | 'mediamtx' | 'none';
      startedAt: number | null;
      processId: number | null;
      ffmpegAvailable: boolean;
      errorMessage?: string;
    };
    const result: StreamResult = {
      hlsUrl,
      webrtcUrl: null,
      hlsReady,
      proxyMode: proc ? 'ffmpeg-hls' : 'none',
      startedAt: proc ? startedAt : null,
      processId: proc?.pid ?? null,
      ffmpegAvailable,
    };
    if (spawnError && !proc) {
      result.errorMessage = spawnError;
    }
    return result;
  }

  // ──── 云端 HLS 本地代理（自动续流）────────────────────────────
  // 服务端用 ffmpeg 持续拉取小米云端 HLS 并重切为本地 HLS（streams/hls/<did>/stream.m3u8）。
  // 云端会话因 CDN 间歇性失效/URL 时效而中断时，自动重建云端会话并重启 ffmpeg，
  // 浏览器只连本地稳定流，避免被云端 URL 间歇 404/时效问题反复打断。
  public async ensureCloudHlsProxy(
    did: string,
    scope: 'main' | 'camera' = 'camera',
  ): Promise<{ hlsUrl: string | null; hlsReady: boolean; proxyMode: string; errorMessage?: string }> {
    return this.cloudHlsProxy.ensure(did, scope);
  }

  public stopCloudHlsProxy(did: string): void {
    this.cloudHlsProxy.stop(did);
  }

  public stopAllCloudHlsProxies(): void {
    this.cloudHlsProxy.stopAll();
  }


  // 探测宿主机本地 go2rtc（小米 P2P → RTSP 桥）是否已注册指定 DID 的流；
  // 返回可用的本地 RTSP 地址，否则返回 null。
  public async resolveLocalGo2rtcRtsp(did: string): Promise<string | null> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const go2rtcApi = process.env.GO2RTC_API_URL || 'http://localhost:1984';
    try {
      const resp = await axios.get(`${go2rtcApi}/api/streams`, { timeout: 2500 });
      const streams: Record<string, unknown> = resp.data ?? {};
      if (streams[safeDid]) {
        const rtspBase = (process.env.GO2RTC_RTSP_URL || 'rtsp://localhost:8554').replace(/\/+$/, '');
        return `${rtspBase}/${safeDid}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  public getRecordingRoot(): string {
    return path.resolve(process.cwd(), 'recordings');
  }

  public getRecordingDir(did: string): string {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    return path.join(this.getRecordingRoot(), safeDid);
  }

  public isMotionRecording(did: string): boolean {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const state = this.cameraArmStates.get(safeDid);
    if (!state) return false;
    return this.isArmAlive(state);
  }

  public async startMotionRecording(
    did: string,
    rtspUrl: string,
  ): Promise<{ recording: boolean; errorMessage?: string; processId?: number | null; startedAt?: number }> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    if (!rtspUrl) {
      return { recording: false, errorMessage: '未获取到局域网 RTSP 地址，无法录制' };
    }

    const existing = this.cameraArmStates.get(safeDid);
    if (existing && this.isArmAlive(existing) && existing.rtspUrl === rtspUrl) {
      return { recording: true, processId: existing.ringProc?.pid ?? existing.detectProc?.pid ?? null, startedAt: existing.armedAt };
    }
    this.disarm(safeDid);

    const recDir = this.getRecordingDir(safeDid);
    const ringDir = path.join(recDir, '.ring');
    try {
      fs.mkdirSync(ringDir, { recursive: true });
    } catch (err: any) {
      return { recording: false, errorMessage: `创建录制目录失败：${err?.message || String(err)}` };
    }

    const threshold = this.motionThreshold();
    const state: CameraArmState = {
      rtspUrl,
      armedAt: Date.now(),
      motionState: 'idle',
      lastMotionAt: 0,
      ringProc: null,
      detectProc: null,
      recProc: null,
      ringDir,
      stagingDir: null,
      liveDir: null,
      pollTimer: null,
    };

    // 预录环形缓冲：流拷贝（保留源编码，成本最低），仅滚动保留最近约 60 秒（5s × 12 段）
    const ringArgs = [
      ...this.buildInputArgs(rtspUrl),
      '-an',
      '-c:v', 'copy',
      '-f', 'segment',
      '-segment_time', '5',
      '-segment_wrap', String(this.ringSegments()),
      '-segment_format', 'mpegts',
      '-y',
      path.join(ringDir, 'seg_%03d.ts'),
    ];
    state.ringProc = this.spawnFfmpeg(ringArgs, safeDid, 'ring');

    // 画面变动检测：低分辨率降采样后按 scene 分数判定，事件写入 stderr 由 Node 解析
    const detectArgs = [
      ...this.buildInputArgs(rtspUrl),
      '-an',
      '-vf', `scale=160:90,fps=2,select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      '-',
    ];
    state.detectProc = this.spawnFfmpeg(detectArgs, safeDid, 'detect', (line) => {
      // 只处理 scene 事件行（其他 stderr 行忽略），避免把进度/警告行误判为画面变动
      if (!/pts_time/.test(line)) return;
      if (state.motionState === 'idle') {
        this.startEvent(safeDid);
      }
      state.lastMotionAt = Date.now();
    });

    if (!state.ringProc && !state.detectProc) {
      this.disarm(safeDid);
      return { recording: false, errorMessage: 'ffmpeg 不可用（请将 ffmpeg.exe 放到 PATH 或 server/ 目录）' };
    }

    this.cameraArmStates.set(safeDid, state);

    // 轮询收尾：画面静止超过尾段时间则把「预录 + 之后画面」合并为正式 mp4
    state.pollTimer = setInterval(() => {
      const s = this.cameraArmStates.get(safeDid);
      if (!s || s !== state) return;
      if (s.motionState === 'recording' && Date.now() - s.lastMotionAt >= this.tailMs()) {
        this.finalizeEvent(safeDid);
      }
    }, 500);

    this.runRetentionCleanup(recDir);
    return { recording: true, processId: state.ringProc?.pid ?? state.detectProc?.pid ?? null, startedAt: state.armedAt };
  }

  public stopMotionRecording(did: string): { recording: boolean } {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    this.disarm(safeDid);
    return { recording: false };
  }

  // ──────────────── 智能录像内部状态机 ────────────────

  private motionThreshold(): number {
    const v = this.cameraMotionSettings.threshold;
    return Number.isFinite(v) && v > 0 ? v : 0.04;
  }

  private tailMs(): number {
    const v = this.cameraMotionSettings.tailSeconds;
    return (Number.isFinite(v) && v > 0 ? v : 60) * 1000;
  }

  // 预录环长度（秒），动态换算为 5s 一段的段数
  private ringSegments(): number {
    const v = this.cameraMotionSettings.ringSeconds;
    const seconds = Number.isFinite(v) && v > 0 ? v : 60;
    return Math.max(4, Math.round(seconds / 5));
  }

  // ──────── 摄像头录制设置（灵敏度/尾留/预录），JSON 持久化，运行时覆盖 env 默认值 ────────
  public getCameraMotionSettings(): { threshold: number; tailSeconds: number; ringSeconds: number } {
    return { ...this.cameraMotionSettings };
  }

  public updateCameraMotionSettings(partial: {
    threshold?: number;
    tailSeconds?: number;
    ringSeconds?: number;
  }): { threshold: number; tailSeconds: number; ringSeconds: number } {
    const num = (v: unknown, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const next = {
      threshold: num(partial.threshold ?? this.cameraMotionSettings.threshold, 0.04),
      tailSeconds: num(partial.tailSeconds ?? this.cameraMotionSettings.tailSeconds, 60),
      ringSeconds: num(partial.ringSeconds ?? this.cameraMotionSettings.ringSeconds, 60),
    };
    this.cameraMotionSettings = next;
    try {
      fs.mkdirSync(path.dirname(this.cameraSettingsFile), { recursive: true });
      fs.writeFileSync(this.cameraSettingsFile, JSON.stringify(next, null, 2), 'utf8');
    } catch { /* noop */ }
    return { ...next };
  }

  private loadCameraMotionSettings(): void {
    try {
      if (fs.existsSync(this.cameraSettingsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.cameraSettingsFile, 'utf8')) as Partial<typeof this.cameraMotionSettings>;
        const num = (v: unknown, d: number) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : d;
        };
        this.cameraMotionSettings = {
          threshold: num(raw.threshold, this.cameraMotionSettings.threshold),
          tailSeconds: num(raw.tailSeconds, this.cameraMotionSettings.tailSeconds),
          ringSeconds: num(raw.ringSeconds, this.cameraMotionSettings.ringSeconds),
        };
      }
    } catch { /* noop */ }
  }

  // ──────── 连续定时录制（全程录像，自动分片 mp4） ────────
  public isContinuousRecording(did: string): boolean {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const st = this.continuousRecordingStates.get(safeDid);
    return !!st && !!st.proc && !st.proc.killed;
  }

  public async startContinuousRecording(
    did: string,
    rtspUrl: string,
    opts?: { segmentMinutes?: number },
  ): Promise<{ recording: boolean; errorMessage?: string; processId?: number | null; startedAt?: number }> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    if (!rtspUrl) {
      return { recording: false, errorMessage: '未获取到局域网 RTSP 地址，无法录制' };
    }
    const existing = this.continuousRecordingStates.get(safeDid);
    if (existing && existing.proc && !existing.proc.killed && existing.rtspUrl === rtspUrl) {
      return { recording: true, processId: existing.proc.pid ?? null, startedAt: existing.startedAt };
    }
    this.stopContinuousRecording(did);

    const recDir = this.getRecordingDir(safeDid);
    try {
      fs.mkdirSync(recDir, { recursive: true });
    } catch (err: any) {
      return { recording: false, errorMessage: `创建录制目录失败：${err?.message || String(err)}` };
    }

    const segmentMinutes = Math.max(1, Math.min(120, Number(opts?.segmentMinutes) || 30));
    const stamp = () => this.tsName(new Date());
    const args = [
      ...this.buildInputArgs(rtspUrl),
      '-an',
      '-c:v', 'copy',
      '-f', 'segment',
      '-segment_time', String(segmentMinutes * 60),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-y',
      path.join(recDir, `cont_${stamp()}_%04d.mp4`),
    ];
    const proc = this.spawnFfmpeg(args, safeDid, 'continuous');
    if (!proc) {
      return { recording: false, errorMessage: 'ffmpeg 不可用（请将 ffmpeg.exe 放到 PATH 或 server/ 目录）' };
    }
    const state: ContinuousRecordingState = {
      rtspUrl,
      proc,
      startedAt: Date.now(),
      segmentMinutes,
    };
    this.continuousRecordingStates.set(safeDid, state);
    this.runRetentionCleanup(recDir);
    return { recording: true, processId: proc.pid ?? null, startedAt: state.startedAt };
  }

  public stopContinuousRecording(did: string): { recording: boolean } {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const st = this.continuousRecordingStates.get(safeDid);
    if (st) {
      this.killProc(st.proc);
      this.continuousRecordingStates.delete(safeDid);
    }
    return { recording: false };
  }

  // 摄像头当前录制状态汇总：motion 智能侦测 / continuous 连续
  public getCameraRecordingState(did: string): { did: string; recording: boolean; mode: 'motion' | 'continuous' | null } {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    if (this.isMotionRecording(safeDid)) return { did, recording: true, mode: 'motion' };
    if (this.isContinuousRecording(safeDid)) return { did, recording: true, mode: 'continuous' };
    return { did, recording: false, mode: null };
  }

  // ──────── 录制计划（自动布防引擎） ────────
  public listCameraSchedules(): CameraScheduleRule[] {
    return this.cameraSchedules.map((s) => ({ ...s }));
  }

  public upsertCameraSchedule(input: Partial<Omit<CameraScheduleRule, 'id'>> & { id?: string }): CameraScheduleRule {
    const existing = input.id ? this.cameraSchedules.find((s) => s.id === input.id) : undefined;
    const rule: CameraScheduleRule = {
      id: input.id || `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      did: input.did ?? existing?.did ?? '',
      enabled: input.enabled !== undefined ? input.enabled !== false : existing?.enabled ?? true,
      mode: input.mode === 'continuous' ? 'continuous' : (existing?.mode ?? 'motion'),
      days: Array.isArray(input.days) ? input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : (existing?.days ?? []),
      start: String(input.start || existing?.start || '00:00'),
      end: String(input.end || existing?.end || '23:59'),
    };
    const idx = this.cameraSchedules.findIndex((s) => s.id === rule.id);
    if (idx >= 0) this.cameraSchedules[idx] = rule;
    else this.cameraSchedules.push(rule);
    this.saveCameraSchedules();
    return { ...rule };
  }

  public deleteCameraSchedule(id: string): { deleted: boolean } {
    const before = this.cameraSchedules.length;
    this.cameraSchedules = this.cameraSchedules.filter((s) => s.id !== id);
    this.scheduleActive.delete(id);
    this.saveCameraSchedules();
    return { deleted: this.cameraSchedules.length < before };
  }

  private saveCameraSchedules(): void {
    try {
      fs.mkdirSync(path.dirname(this.cameraSchedulesFile), { recursive: true });
      fs.writeFileSync(this.cameraSchedulesFile, JSON.stringify(this.cameraSchedules, null, 2), 'utf8');
    } catch { /* noop */ }
  }

  private loadCameraSchedules(): void {
    try {
      if (fs.existsSync(this.cameraSchedulesFile)) {
        const raw = JSON.parse(fs.readFileSync(this.cameraSchedulesFile, 'utf8')) as CameraScheduleRule[];
        if (Array.isArray(raw)) this.cameraSchedules = raw;
      }
    } catch { /* noop */ }
  }

  // 启动定时布防引擎（服务器启动时调用一次），每 30s 检查一次计划
  public startScheduleEngine(): void {
    if (this.scheduleEngineTimer) return;
    this.scheduleEngineTimer = setInterval(() => {
      void this.scheduleTick();
    }, 30_000);
    void this.scheduleTick();
  }

  private async scheduleTick(): Promise<void> {
    for (const rule of this.cameraSchedules) {
      if (!rule.enabled) {
        if (this.scheduleActive.has(rule.id)) {
          const mode = this.scheduleActive.get(rule.id);
          if (mode === 'motion') this.stopMotionRecording(rule.did);
          else this.stopContinuousRecording(rule.did);
          this.scheduleActive.delete(rule.id);
        }
        continue;
      }
      const inWindow = this.scheduleInWindow(rule);
      const current = this.scheduleActive.get(rule.id);
      if (inWindow && !current) {
        // 到点启动对应模式录制
        const started = await this.scheduleStartRecording(rule);
        if (started) this.scheduleActive.set(rule.id, rule.mode);
      } else if (!inWindow && current) {
        if (current === 'motion') this.stopMotionRecording(rule.did);
        else this.stopContinuousRecording(rule.did);
        this.scheduleActive.delete(rule.id);
      }
    }
  }

  private scheduleInWindow(rule: CameraScheduleRule): boolean {
    const now = new Date();
    const day = now.getDay(); // 0=周日
    if (!rule.days.includes(day)) return false;
    const parse = (hhmm: string): number => {
      const [h = 0, m = 0] = String(hhmm || '').split(':').map((x) => Number(x) || 0);
      return h * 60 + m;
    };
    const start = parse(rule.start);
    const end = parse(rule.end);
    const cur = now.getHours() * 60 + now.getMinutes();
    if (start <= end) return cur >= start && cur < end;
    // 跨天窗口（如 22:00 - 06:00）
    return cur >= start || cur < end;
  }

  private async scheduleStartRecording(rule: CameraScheduleRule): Promise<boolean> {
    try {
      const device = await prisma.device.findUnique({ where: { did: rule.did }, select: { model: true } });
      const model = device?.model ?? '';
      const xiaomiDid = this.resolveXiaomiDid(model, rule.did);
      const scope = this.resolveXiaomiScope(model);
      let rtspUrl = await this.resolveLocalGo2rtcRtsp(xiaomiDid);
      if (!rtspUrl) {
        const rtspInfo = await xiaomiAdapter.startRTSPStream(xiaomiDid, model, scope);
        rtspUrl = rtspInfo.rtspUrl;
      }
      if (!rtspUrl) return false;
      if (rule.mode === 'continuous') {
        const res = await this.startContinuousRecording(rule.did, rtspUrl);
        return res.recording;
      }
      const res = await this.startMotionRecording(rule.did, rtspUrl);
      return res.recording;
    } catch {
      return false;
    }
  }

  private resolveXiaomiDid(model: string, fallbackDid: string): string {
    try {
      const parsed = model ? JSON.parse(model) : null;
      const did = parsed && typeof parsed.xiaomiDid === 'string' && parsed.xiaomiDid.trim()
        ? parsed.xiaomiDid.trim()
        : fallbackDid;
      return did;
    } catch {
      return fallbackDid;
    }
  }

  private resolveXiaomiScope(model: string): 'main' | 'camera' {
    try {
      const parsed = model ? JSON.parse(model) : null;
      return parsed && parsed.sourceScope === 'main' ? 'main' : 'camera';
    } catch {
      return 'camera';
    }
  }

  private isArmAlive(state: CameraArmState): boolean {
    return (!!state.ringProc && !state.ringProc.killed) || (!!state.detectProc && !state.detectProc.killed);
  }

  private killProc(proc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null | undefined): void {
    if (!proc) return;
    try { proc.kill('SIGKILL'); } catch { /* noop */ }
  }

  private rmrf(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // 依据源 URL 协议构造 ffmpeg 输入参数（rtsp 走 TCP；http 走自动重连，
  // 应对小米云端 CDN 间歇性 404/TCP/TLS 断连）
  // 注意：http 分支不能加 -fflags nobuffer —— 实测会与云端 HLS 输入不兼容，
  // 导致 ffmpeg 打开流后 frame=0 卡住、永远切不出分片。
  private buildInputArgs(url: string): string[] {
    if (/^https?:/i.test(url)) {
      return [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_on_http_error', '404,403',
        '-reconnect_delay_max', '5',
        '-analyzeduration', '0',
        '-i', url,
      ];
    }
    return ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-timeout', '5000000', '-i', url];
  }

  private spawnFfmpeg(
    args: string[],
    safeDid: string,
    tag: string,
    onStderrLine?: (line: string) => void,
  ): ChildProcessByStdio<null, NodeReadable, NodeReadable> | null {
    let proc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null = null;
    try {
      const spawned = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      proc = spawned as unknown as ChildProcessByStdio<null, NodeReadable, NodeReadable>;
      proc.on('error', (err) => {
        console.warn(`[Recording:${tag}] ffmpeg spawn error did=${safeDid} err=${err?.message || err}`);
      });
      proc.on('exit', (code, signal) => {
        console.warn(`[Recording:${tag}] ffmpeg exit did=${safeDid} code=${code} signal=${signal}`);
      });
      if (onStderrLine) {
        let buf = '';
        proc.stderr.on('data', (chunk: unknown) => {
          buf += String(chunk || '');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = String(line).trim();
            if (trimmed) onStderrLine(trimmed);
          }
        });
      }
      proc.stdout.on('data', () => { /* consume */ });
    } catch (err: any) {
      console.warn(`[Recording:${tag}] ffmpeg 启动异常 did=${safeDid} err=${err?.message || err}`);
      return null;
    }
    return proc;
  }

  private startEvent(safeDid: string): void {
    const state = this.cameraArmStates.get(safeDid);
    if (!state || state.motionState === 'recording') return;

    const stagingDir = path.join(this.getRecordingDir(safeDid), `.staging-${Date.now()}`);
    const liveDir = path.join(stagingDir, 'live');
    try {
      fs.mkdirSync(liveDir, { recursive: true });
    } catch {
      return;
    }

    // 快照当前环形缓冲作为预录（按 mtime 保持时间顺序，跳过正在写入的最后一段）
    try {
      const segs = fs.readdirSync(state.ringDir)
        .filter((f) => /\.ts$/i.test(f))
        .map((f) => {
          const full = path.join(state.ringDir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
      const complete = segs.slice(0, Math.max(0, segs.length - 1));
      complete.forEach((seg, i) => {
        fs.copyFileSync(seg.full, path.join(stagingDir, `pre_${String(i).padStart(3, '0')}.ts`));
      });
    } catch { /* noop */ }

    const liveArgs = [
      ...this.buildInputArgs(state.rtspUrl),
      '-an',
      '-c:v', 'copy',
      '-f', 'segment',
      '-segment_time', '3',
      '-segment_format', 'mpegts',
      '-y',
      path.join(liveDir, 'live_%03d.ts'),
    ];
    state.recProc = this.spawnFfmpeg(liveArgs, safeDid, 'live');
    state.stagingDir = stagingDir;
    state.liveDir = liveDir;
    state.motionState = 'recording';
    state.lastMotionAt = Date.now();
  }

  private finalizeEvent(safeDid: string): void {
    const state = this.cameraArmStates.get(safeDid);
    if (!state || state.motionState !== 'recording') return;

    const stagingDir = state.stagingDir;
    const liveDir = state.liveDir;
    state.motionState = 'idle';
    state.stagingDir = null;
    state.liveDir = null;
    this.killProc(state.recProc);
    state.recProc = null;

    if (!stagingDir || !liveDir) return;

    let segs: string[] = [];
    try {
      const all = fs.readdirSync(stagingDir).filter((f) => /\.ts$/i.test(f));
      const pre = all.filter((f) => /^pre_\d+\.ts$/i.test(f)).sort();
      const live = all.filter((f) => /^live_\d+\.ts$/i.test(f)).sort();
      // 跳过最后一段（可能因杀进程而截断），避免污染正式录像
      const safeLive = live.slice(0, Math.max(0, live.length - 1));
      segs = [...pre, ...safeLive].map((f) => path.join(stagingDir, f));
    } catch { /* noop */ }

    if (segs.length === 0) {
      this.rmrf(stagingDir);
      return;
    }

    const concatList = path.join(stagingDir, 'concat.txt');
    try {
      fs.writeFileSync(concatList, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    } catch {
      this.rmrf(stagingDir);
      return;
    }

    const recDir = this.getRecordingDir(safeDid);
    const finalName = `rec_${this.tsName(new Date())}.mp4`;
    const finalPath = path.join(recDir, finalName);
    const finalizeArgs = [
      '-y',
      '-fflags', '+genpts',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-crf', '26',
      finalPath,
    ];
    const proc = this.spawnFfmpeg(finalizeArgs, safeDid, 'finalize');
    if (!proc) {
      this.rmrf(stagingDir);
      return;
    }
    proc.on('exit', (code) => {
      let ok = false;
      try {
        ok = code === 0 && fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0;
      } catch { /* noop */ }
      if (!ok) {
        try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch { /* noop */ }
      }
      this.rmrf(stagingDir);
      this.runRetentionCleanup(recDir);
      console.info(`[Recording:finalize] did=${safeDid} ok=${ok} file=${ok ? finalName : 'N/A'}`);
    });
  }

  private tsName(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  private runRetentionCleanup(recDir: string): void {
    try {
      const maxDays = Number(process.env.CAMERA_RETENTION_DAYS ?? '7');
      const maxBytes = Number(process.env.CAMERA_RETENTION_BYTES ?? String(10 * 1024 * 1024 * 1024));
      const listMp4 = (): Array<{ full: string; mtime: number; size: number }> =>
        fs.readdirSync(recDir)
          .filter((f) => /\.mp4$/i.test(f))
          .map((f) => {
            const full = path.join(recDir, f);
            try {
              const st = fs.statSync(full);
              return { full, mtime: st.mtimeMs, size: st.size };
            } catch {
              return null;
            }
          })
          .filter((e): e is { full: string; mtime: number; size: number } => !!e);

      let entries = listMp4();
      if (Number.isFinite(maxDays) && maxDays > 0) {
        const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
        for (const e of entries) {
          if (e.mtime < cutoff) {
            try { fs.unlinkSync(e.full); } catch { /* noop */ }
          }
        }
      }
      if (Number.isFinite(maxBytes) && maxBytes > 0) {
        entries = listMp4().sort((a, b) => a.mtime - b.mtime);
        let total = entries.reduce((s, e) => s + e.size, 0);
        let i = 0;
        while (total > maxBytes && i < entries.length) {
          total -= entries[i].size;
          try { fs.unlinkSync(entries[i].full); } catch { /* noop */ }
          i += 1;
        }
      }
    } catch { /* noop */ }
  }

  private disarm(safeDid: string): void {
    const state = this.cameraArmStates.get(safeDid);
    if (!state) return;
    if (state.pollTimer) clearInterval(state.pollTimer);
    // 若有正在录制的事件，先收尾合并，避免停止布防时丢失未完成的片段
    if (state.motionState === 'recording') {
      this.finalizeEvent(safeDid);
    }
    this.killProc(state.recProc);
    this.killProc(state.detectProc);
    this.killProc(state.ringProc);
    if (state.stagingDir) this.rmrf(state.stagingDir);
    this.cameraArmStates.delete(safeDid);
  }

  public listMotionRecordings(did: string): Array<{ name: string; size: number; mtime: number; url: string }> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const recDir = this.getRecordingDir(safeDid);
    let files: string[] = [];
    try {
      files = fs.readdirSync(recDir);
    } catch {
      files = [];
    }
    const base = `/recordings/${encodeURIComponent(safeDid)}`;
    return files
      .filter((f) => /\.mp4$/i.test(f))
      .map((f) => {
        const full = path.join(recDir, f);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* noop */ }
        return { name: f, size, mtime, url: `${base}/${encodeURIComponent(f)}` };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  public listAllCameraRecordings(): Array<{ did: string; name: string; size: number; mtime: number; url: string }> {
    const root = this.getRecordingRoot();
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      dirs = [];
    }
    const result: Array<{ did: string; name: string; size: number; mtime: number; url: string }> = [];
    for (const dir of dirs) {
      for (const f of this.listMotionRecordings(dir)) {
        result.push({ did: dir, ...f });
      }
    }
    return result.sort((a, b) => b.mtime - a.mtime);
  }

  public deleteMotionRecording(did: string, name: string): { deleted: boolean; errorMessage?: string } {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const safeName = String(name || '').trim();
    // 仅允许删除指定 DID 目录下的 mp4 文件，杜绝路径穿越
    if (!safeName || !/^[\w.-]+\.mp4$/i.test(safeName) || safeName.includes('..')) {
      return { deleted: false, errorMessage: '非法文件名' };
    }
    const recDir = this.getRecordingDir(safeDid);
    const target = path.resolve(recDir, safeName);
    if (target !== path.join(recDir, safeName)) {
      return { deleted: false, errorMessage: '非法路径' };
    }
    try {
      if (!fs.existsSync(target)) {
        return { deleted: false, errorMessage: '文件不存在' };
      }
      fs.unlinkSync(target);
      return { deleted: true };
    } catch (err: any) {
      return { deleted: false, errorMessage: err?.message || String(err) };
    }
  }

  private async buildSiteSummary(siteIds?: string[]): Promise<SiteSummary[]> {
    const sites = await prisma.site.findMany({
      where: siteIds?.length ? { id: { in: siteIds } } : undefined,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      include: {
        nodes: {
          orderBy: [{ nodeType: 'asc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: {
            rooms: true,
            devices: true,
          },
        },
      },
    });

    const resolvedSiteIds = sites.map((site) => site.id);
    const [onlineDeviceGroups, cutoffRoomGroups, unresolvedAlarms] = await Promise.all([
      prisma.device.groupBy({
        by: ['siteId'],
        where: {
          siteId: { in: resolvedSiteIds },
          status: 'online',
        },
        _count: { _all: true },
      }),
      prisma.room.groupBy({
        by: ['siteId'],
        where: {
          siteId: { in: resolvedSiteIds },
          cutoff: true,
        },
        _count: { _all: true },
      }),
      prisma.alarmLog.findMany({
        where: {
          resolved: false,
          roomId: { not: null },
          room: {
            siteId: { in: resolvedSiteIds },
          },
        },
        select: {
          room: {
            select: {
              siteId: true,
            },
          },
        },
      }),
    ]);

    const onlineDeviceMap = new Map(
      onlineDeviceGroups.map((item) => [item.siteId, item._count._all]),
    );
    const cutoffRoomMap = new Map(
      cutoffRoomGroups.map((item) => [item.siteId, item._count._all]),
    );
    const unresolvedAlarmMap = new Map<string, number>();

    if (unresolvedAlarms.length > 0) {
      for (const alarm of unresolvedAlarms) {
        const groupedSiteId = alarm.room?.siteId;
        if (!groupedSiteId) continue;
        unresolvedAlarmMap.set(
          groupedSiteId,
          (unresolvedAlarmMap.get(groupedSiteId) ?? 0) + 1,
        );
      }
    }

    return sites.map((site) => ({
      id: site.id,
      code: site.code,
      name: site.name,
      description: site.description ?? null,
      adapterType: site.adapterType as SiteSummary['adapterType'],
      isPrimary: site.isPrimary,
      storageRetentionDays: site.storageRetentionDays,
      roomCount: site._count.rooms,
      deviceCount: site._count.devices,
      onlineDeviceCount: onlineDeviceMap.get(site.id) ?? 0,
      cutoffRoomCount: cutoffRoomMap.get(site.id) ?? 0,
      unresolvedAlarmCount: unresolvedAlarmMap.get(site.id) ?? 0,
      nodes: site.nodes.map((node) => ({
        id: node.id,
        siteId: node.siteId,
        code: node.code,
        name: node.name,
        nodeType: node.nodeType as SiteSummary['nodes'][number]['nodeType'],
        status: node.status as SiteSummary['nodes'][number]['status'],
        localApiBaseUrl: node.localApiBaseUrl ?? null,
        storageRetentionDays: node.storageRetentionDays,
        isLocalControlEnabled: node.isLocalControlEnabled,
        lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
        lastSyncAt: node.lastSyncAt?.toISOString() ?? null,
      })),
    }));
  }

  public async getSettings(): Promise<SystemSettingsData> {
    const loaded = await loadSettingsFromDb();
    (loaded as { businessTimezone: string }).businessTimezone = normalizeBusinessTimeZone(
      (loaded as { businessTimezone: string }).businessTimezone || DEFAULT_BUSINESS_TIMEZONE,
    );
    return loaded;
  }

  public resolveReferenceElectricityPrice(input?: {
    region?: string | null;
    businessTimezone?: string | null;
  }): {
    pricePerKwh: number;
    region: string;
    source: string;
  } {
    const res = resolveRefPrice(input);
    return {
      pricePerKwh: res.pricePerKwh,
      region: res.region,
      source: res.pricePerKwh === DEFAULT_SETTINGS.pricePerKwh ? '通用参考均价' : `${res.region}参考均价`,
    };
  }

  public async refreshReferenceElectricityPrice(options?: {
    region?: string | null;
    businessTimezone?: string | null;
    autoEnabled?: boolean;
    operatorUserId?: string | null;
    actorContext?: OperationActorContext;
    writeOperationLog?: boolean;
  }): Promise<{
    pricePerKwh: number;
    priceAutoRegion: string;
    priceAutoSource: string;
    priceAutoLastUpdatedAt: string;
    priceAutoEnabled: boolean;
  }> {
    const current = await this.getSettings();
    const resolved = this.resolveReferenceElectricityPrice({
      region: options?.region ?? current.priceAutoRegion,
      businessTimezone: options?.businessTimezone ?? current.businessTimezone,
    });
    const nowIso = new Date().toISOString();
    const nextPartial: Partial<SystemSettingsData> = {
      pricePerKwh: resolved.pricePerKwh,
      priceAutoRegion: String(options?.region ?? current.priceAutoRegion ?? resolved.region).trim() || resolved.region,
      priceAutoSource: resolved.source,
      priceAutoLastUpdatedAt: nowIso,
      priceAutoEnabled: options?.autoEnabled ?? current.priceAutoEnabled,
    };
    await persistSettingsPartial(nextPartial);

    if (options?.writeOperationLog) {
      await writeOperation(
        options.operatorUserId ?? null,
        OperationType.update_settings,
        null,
        {
          action: 'refresh_reference_price',
          actionLabel: '自动获取参考电价',
          source: options.actorContext?.source,
          sourceLabel: options.actorContext?.sourceLabel,
          settings: nextPartial as Record<string, unknown>,
        },
        true,
      );
    }

    return {
      pricePerKwh: resolved.pricePerKwh,
      priceAutoRegion: nextPartial.priceAutoRegion as string,
      priceAutoSource: nextPartial.priceAutoSource as string,
      priceAutoLastUpdatedAt: nowIso,
      priceAutoEnabled: Boolean(nextPartial.priceAutoEnabled),
    };
  }

  public async refreshReferenceElectricityPriceIfNeeded(): Promise<boolean> {
    const settings = await this.getSettings();
    if (!settings.priceAutoEnabled) return false;
    const lastUpdatedTs = settings.priceAutoLastUpdatedAt ? Date.parse(settings.priceAutoLastUpdatedAt) : 0;
    if (lastUpdatedTs > 0 && Date.now() - lastUpdatedTs < PRICE_AUTO_REFRESH_INTERVAL_MS) {
      return false;
    }
    await this.refreshReferenceElectricityPrice({
      region: settings.priceAutoRegion,
      businessTimezone: settings.businessTimezone,
      autoEnabled: true,
      writeOperationLog: false,
    });
    return true;
  }

  public async updateSettings(
    partial: Partial<SystemSettingsData>,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<SystemSettingsData> {
    await persistSettingsPartial(partial);

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'update_settings',
        actionLabel: '修改系统设置',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        settings: partial as Record<string, unknown>,
      },
      true,
    );

    const shouldRefreshReferencePrice =
      Boolean(partial.priceAutoEnabled) ||
      partial.businessTimezone !== undefined ||
      partial.priceAutoRegion !== undefined;
    if (shouldRefreshReferencePrice) {
      const merged = await this.getSettings();
      if (merged.priceAutoEnabled) {
        await this.refreshReferenceElectricityPrice({
          region: merged.priceAutoRegion,
          businessTimezone: merged.businessTimezone,
          autoEnabled: true,
          writeOperationLog: false,
        });
      }
    }

    return this.getSettings();
  }

  public async getSetting<K extends SettingsKey>(
    key: K,
    fallback?: SystemSettingsData[K],
  ): Promise<SystemSettingsData[K]> {
    const setting = await prisma.systemSettings.findUnique({
      where: { key: key as string },
    });

    if (!setting) {
      return fallback !== undefined ? fallback : DEFAULT_SETTINGS[key];
    }

    if (BOOLEAN_SETTING_KEYS.includes(key)) {
      return (setting.value === 'true') as SystemSettingsData[K];
    }
    if (key === 'businessTimezone') {
      return normalizeBusinessTimeZone(setting.value) as SystemSettingsData[K];
    }
    if (STRING_SETTING_KEYS.includes(key)) {
      return setting.value as SystemSettingsData[K];
    }

    if (isAlarmRatioKey(key)) {
      return normalizeAlarmRatioValue(setting.value) as SystemSettingsData[K];
    }

    const numValue = parseFloat(setting.value);
    if (isNaN(numValue)) {
      return fallback !== undefined ? fallback : DEFAULT_SETTINGS[key];
    }

    if (key === 'refreshInterval') {
      return normalizeRefreshIntervalValue(numValue) as SystemSettingsData[K];
    }

    return numValue as SystemSettingsData[K];
  }

  public async syncXiaomiDevices(
    operatorUserId: string,
    actorContext?: OperationActorContext,
  ): Promise<boolean> {
    await xiaomiAdapter.syncDevicesToDb(operatorUserId, actorContext);
    return true;
  }

  public async renameDevice(
    did: string,
    name: string,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ did: string; name: string }> {
    const nextName = name.trim();

    if (!did) {
      throw new Error('缺少设备 did');
    }

    if (!nextName) {
      throw new Error('设备名称不能为空');
    }

    const existing = await prisma.device.findUnique({
      where: { did },
      include: {
        room: {
          select: {
            id: true,
            roomNumber: true,
            name: true,
          },
        },
      },
    });

    if (!existing) {
      throw new Error('设备不存在');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextDevice = await tx.device.update({
        where: { did },
        data: { name: nextName },
        select: { did: true, name: true },
      });

      if (existing.room?.id) {
        await tx.room.update({
          where: { id: existing.room.id },
          data: { name: nextName },
        });
      }

      return nextDevice;
    });

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      existing.room?.id ?? null,
      {
        action: 'rename_device',
        actionLabel: '修改空间名称',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        roomNumber: existing.room?.roomNumber ?? null,
        roomName: nextName,
        displayName: nextName,
        did,
        deviceName: nextName,
      },
      true,
    );

    return updated;
  }

  public async updateRoomAnnotation(
    roomId: string,
    annotation: string,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ roomId: string; roomNumber: string; annotation: string | null; displayName: string }> {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        roomNumber: true,
        name: true,
      },
    });

    if (!room) {
      throw new Error('房间不存在');
    }

    const normalizedAnnotation = normalizeRoomAnnotation(room.roomNumber, annotation);
    const updated = await prisma.room.update({
      where: { id: roomId },
      data: {
        name: normalizedAnnotation ?? '',
      },
      select: {
        id: true,
        roomNumber: true,
        name: true,
      },
    });

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      roomId,
      {
        action: 'update_room_annotation',
        actionLabel: normalizedAnnotation ? '修改房间备注' : '清空房间备注',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        roomNumber: updated.roomNumber,
        roomName: updated.name,
        displayName: formatRoomDisplayName(updated.roomNumber, updated.name),
        note: normalizedAnnotation ? `房间备注已更新为 ${normalizedAnnotation}` : '房间备注已清空',
      },
      true,
    );

    return {
      roomId: updated.id,
      roomNumber: updated.roomNumber,
      annotation: normalizeRoomAnnotation(updated.roomNumber, updated.name),
      displayName: formatRoomDisplayName(updated.roomNumber, updated.name),
    };
  }

  public async updateRoomFloor(
    roomId: string,
    floor: number,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ roomId: string; roomNumber: string; floor: number }> {
    const rawNum = Number(floor);
    if (!Number.isFinite(rawNum)) {
      throw new Error('楼层格式不正确');
    }
    const normalizedFloor = Math.max(-10, Math.min(50, Math.round(rawNum)));
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        roomNumber: true,
        floor: true,
        name: true,
      },
    });
    if (!room) {
      throw new Error('房间不存在');
    }
    if (room.floor === normalizedFloor) {
      return { roomId: room.id, roomNumber: room.roomNumber, floor: room.floor };
    }
    const updated = await prisma.room.update({
      where: { id: roomId },
      data: { floor: normalizedFloor },
      select: { id: true, roomNumber: true, floor: true, name: true },
    });

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      roomId,
      {
        action: 'update_room_floor',
        actionLabel: '修改房间楼层',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        roomNumber: updated.roomNumber,
        roomName: updated.name,
        displayName: formatRoomDisplayName(updated.roomNumber, updated.name),
        previousFloor: room.floor,
        floor: updated.floor,
        note: `房间楼层从 ${room.floor} 调整为 ${updated.floor}（欧洲 EG/OG/UG 标注）`,
      },
      true,
    );

    return {
      roomId: updated.id,
      roomNumber: updated.roomNumber,
      floor: updated.floor,
    };
  }

  public async persistLanDevices(
    input: Array<{
      ip: string;
      mac: string | null;
      vendor?: string | null;
      name?: string | null;
      hostname?: string | null;
      status?: 'online' | 'offline' | 'unknown';
      siteId?: string | null;
      roomId?: string | null;
    }>,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{
    total: number;
    persisted: number;
    updated: number;
    skipped: number;
    failed: number;
    dids: string[];
    categorySummary: Record<string, number>;
    skippedSummary: Record<string, number>;
    dryRun: boolean;
    errors: Array<{ mac: string | null; ip: string; name?: string | null; message: string }>;
    demotedPublicSatelliteDids: string[];
    primaryPublicNetworkDeviceDids: string[];
  }> {
    if (!Array.isArray(input) || input.length === 0) {
      return {
        total: 0,
        persisted: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        dids: [],
        categorySummary: {},
        skippedSummary: {},
        dryRun: false,
        errors: [],
        demotedPublicSatelliteDids: [],
        primaryPublicNetworkDeviceDids: [],
      };
    }

    let defaultSiteId = (
      await prisma.site.findFirst({
        where: { isPrimary: true },
        select: { id: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      })
    )?.id;
    if (!defaultSiteId) {
      defaultSiteId = (
        await prisma.site.findFirst({
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }],
        })
      )?.id;
    }
    if (!defaultSiteId) {
      throw new Error('未找到可写入设备的默认区域');
    }

    const safeStringifyModel = (obj: unknown, maxLen = 1024): string =>
      this.safeStringifyModel(obj, maxLen);

    let skipped = 0;
    const categorySummary: Record<string, number> = {
      [DeviceCategory.CIRCUIT_BREAKER]: 0,
      [DeviceCategory.CAMERA]: 0,
      [DeviceCategory.WIFI_AP]: 0,
      [DeviceCategory.SMART_APPLIANCE]: 0,
      [DeviceCategory.FIVE_G_CPE]: 0,
      [DeviceCategory.OTHER]: 0,
    };
    const skippedSummary: Record<string, number> = {
      [DeviceCategory.CIRCUIT_BREAKER]: 0,
      [DeviceCategory.CAMERA]: 0,
      [DeviceCategory.WIFI_AP]: 0,
      [DeviceCategory.SMART_APPLIANCE]: 0,
      [DeviceCategory.FIVE_G_CPE]: 0,
      [DeviceCategory.OTHER]: 0,
    };

    type EnrichedItem = typeof input[number] & {
      rawMac: string;
      formattedMac: string;
      did: string;
      name: string;
      model: string;
      prismaStatus: PrismaDeviceStatus;
      category: DeviceCategory;
    };
    const enrichedInput: EnrichedItem[] = [];
    const errors: Array<{ mac: string | null; ip: string; name?: string | null; message: string }> = [];
    for (const item of input) {
      const rawMac = String(item.mac ?? '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
      if (rawMac.length !== 12) {
        skipped += 1;
        errors.push({
          mac: item.mac ?? null,
          ip: item.ip,
          name: item.name ?? item.hostname ?? null,
          message: 'MAC 地址格式异常，已跳过',
        });
        continue;
      }
      const formattedMac = rawMac.replace(/(.{2})(?=.)/g, '$1:');
      const did = `LAN_${rawMac}`;
      const name =
        [item.name, item.hostname, item.vendor]
          .map((s) => (s ? String(s).trim() : ''))
          .find(Boolean) ||
        `LAN Device ${formattedMac}`;
      const model =
        [item.vendor, item.hostname].map((s) => (s ? String(s).trim() : '')).find(Boolean) ||
        'LAN Discovered Device';
      const statusIn: string = (item.status ?? 'unknown').toLowerCase();
      const prismaStatus: PrismaDeviceStatus =
        statusIn === 'online'
          ? PrismaDeviceStatus.online
          : statusIn === 'offline'
            ? PrismaDeviceStatus.offline
            : PrismaDeviceStatus.unknown;
      const category = inferDeviceCategory({ name, model, vendor: item.vendor ?? null, mac: rawMac, ip: item.ip ?? null });
      categorySummary[category] = (categorySummary[category] ?? 0) + 1;
      const isPublicNetworkCategory =
        category === DeviceCategory.WIFI_AP || category === DeviceCategory.FIVE_G_CPE;
      const isPublicFacilityCategory = isPublicNetworkCategory || category === DeviceCategory.CAMERA;
      if (isPublicFacilityCategory) {
        const role =
          category === DeviceCategory.CAMERA
            ? 'camera'
            : category === DeviceCategory.FIVE_G_CPE
              ? 'cpe'
              : inferPublicNetworkRole({
                  category,
                  name,
                  model,
                  vendor: item.vendor ?? null,
                  ip: item.ip ?? null,
                  status: prismaStatus,
                });
        const { shortName } = inferShortDeviceName(
          category,
          item.vendor ?? null,
          model,
          name,
          role,
        );
        enrichedInput.push({
          ...item,
          rawMac,
          formattedMac,
          did,
          name: shortName,
          model,
          prismaStatus,
          category,
        });
        continue;
      }
      enrichedInput.push({ ...item, rawMac, formattedMac, did, name, model, prismaStatus, category });
    }

    const publicNetworkGroups = new Map<string, EnrichedItem[]>();
    for (const it of enrichedInput) {
      if (it.category !== DeviceCategory.WIFI_AP && it.category !== DeviceCategory.FIVE_G_CPE) continue;
      const anyIt = it as any;
      const g = networkGroupKey({
        category: it.category,
        ip: it.ip ?? null,
        mac: it.rawMac ?? it.mac ?? null,
        vendor: it.vendor ?? null,
        name: it.name,
        model: it.model ?? null,
        hostname: it.hostname ?? null,
        ssid: anyIt.ssid ?? null,
      });
      if (!g) continue;
      const list = publicNetworkGroups.get(g) ?? [];
      list.push(it);
      publicNetworkGroups.set(g, list);
    }
    const publicPrimaryDids = new Set<string>();
    const publicNetworkSatellites = new Map<string, EnrichedItem[]>();
    const demotedExistingSatelliteDids = new Set<string>();
    for (const [groupKey, list] of publicNetworkGroups) {
      const scoredList = list.map((it) => {
        const anyIt = it as any;
        return {
          it,
          ctx: {
            category: it.category,
            ip: it.ip ?? null,
            mac: it.rawMac ?? it.mac ?? null,
            vendor: it.vendor ?? null,
            name: it.name,
            model: it.model ?? null,
            hostname: it.hostname ?? null,
            status: it.prismaStatus ?? (it as any).status ?? 'unknown',
            uptimeSeconds: Number((it as any).uptimeSeconds ?? 0) || null,
            clientCount: Number(anyIt.clientCount ?? 0) || null,
            meshNodeCount: Number(anyIt.meshNodeCount ?? 0) || null,
            roll: (anyIt.roll ?? null) as 'master' | 'satellite' | null,
          },
        };
      });
      const primaryCtx = pickPrimaryPublicNetworkDevice(scoredList.map((s) => s.ctx)) as any;
      const primary = primaryCtx
        ? scoredList.find((s) => s.ctx === primaryCtx)?.it ?? null
        : pickPrimaryPublicNetworkDevice(list);
      if (!primary || list.length === 1) {
        continue;
      }
      publicPrimaryDids.add(primary.did);
      const satellites = list.filter((it) => it.did !== primary.did);
      if (satellites.length > 0) publicNetworkSatellites.set(primary.did, satellites);
      void groupKey;
    }

    const dids: string[] = [];
    let persisted = 0;
    let updated = 0;
    let failed = 0;

    for (const item of enrichedInput) {
      const { rawMac, formattedMac, did, name, model, prismaStatus, category } = item;
      const siteId = item.siteId || defaultSiteId;

      const managed = isManagedDeviceCategory(category);
      const existingDevice = !managed
        ? null
        : await prisma.device.findUnique({
            where: { did },
            select: { id: true, did: true, name: true, model: true, siteId: true, roomId: true, status: true, offlineSince: true },
          });
      if (!managed && !existingDevice) {
        skipped += 1;
        skippedSummary[category] = (skippedSummary[category] ?? 0) + 1;
        const catLabel =
          (DEVICE_CATEGORY_LABEL as Record<string, string>)[category] ?? '未分类';
        errors.push({
          mac: formattedMac,
          ip: item.ip,
          name: name,
          message: `默认未管理设备（${catLabel}）。已在 WiFi/AP 的「挂载设备」中统一查看；如需作为独立设备加入，请在识别预览列表中手动勾选。`,
        });
        continue;
      }
      const existing = existingDevice;
      const isPublicNetworkCategory =
        category === DeviceCategory.WIFI_AP || category === DeviceCategory.FIVE_G_CPE;

      if (isPublicNetworkCategory && !existing && !publicPrimaryDids.has(did)) {
        const satellitesOfSomePrimary = Array.from(publicNetworkSatellites.values()).some((s) =>
          s.some((x) => x.did === did),
        );
        if (satellitesOfSomePrimary) {
          skipped += 1;
          skippedSummary[category] = (skippedSummary[category] ?? 0) + 1;
          errors.push({
            mac: formattedMac,
            ip: item.ip,
            name,
            message: `同品牌公共网络设备组内仅保留 1 台主控设备独立显示，其余卫星/分机已折叠到主控的 Mesh 拓扑与挂载设备列表中；如需单独管理可在识别预览列表中手动勾选。`,
          });
          continue;
        }
      }

      if (isPublicNetworkCategory && existing && demotedExistingSatelliteDids.has(existing.did)) {
        skipped += 1;
        skippedSummary[category] = (skippedSummary[category] ?? 0) + 1;
        const primaryDid = Array.from(publicPrimaryDids.values()).find((pdid) =>
          (publicNetworkSatellites.get(pdid) ?? []).some((sat) => sat.did === existing.did),
        );
        errors.push({
          mac: formattedMac,
          ip: item.ip,
          name,
          message: primaryDid
            ? `公共网络设备组已重新选择主控 ${primaryDid}；本设备已判定为卫星/分机，折叠进主控的 Mesh 拓扑与挂载设备列表，不再单独入库/更新，避免重复卡片。`
            : `公共网络设备组已选择新主控；本设备已判定为卫星/分机，不再单独入库/更新。`,
        });
        continue;
      }

      try {
        const enrichedPayload: Record<string, unknown> = {
          macAddress: formattedMac,
          ipAddress: item.ip,
          vendorName: item.vendor ?? null,
          hostname: item.hostname ?? null,
          discoveryName: item.name ?? null,
        };
        let storedModel = model;
        try {
          const parsed = JSON.parse(storedModel);
          if (parsed && typeof parsed === 'object') {
            storedModel = safeStringifyModel({ ...parsed, ...enrichedPayload });
          } else {
            storedModel = safeStringifyModel({ _raw: storedModel, ...enrichedPayload });
          }
        } catch {
          storedModel = safeStringifyModel({ _raw: storedModel, ...enrichedPayload });
        }
        let parsedRuntimeBase: Record<string, unknown> = {};
        try {
          const obj = JSON.parse(storedModel);
          if (obj && typeof obj === 'object') parsedRuntimeBase = obj as Record<string, unknown>;
        } catch {
          parsedRuntimeBase = { _raw: storedModel };
        }

        if (isPublicNetworkCategory) {
          const satellites = publicNetworkSatellites.get(did) ?? [];
          const currentMesh: MeshNodeRuntime[] = [];
          const primaryNode: MeshNodeRuntime = {
            nodeId: normalizeMac(rawMac) ?? did,
            nodeName: name,
            role: mapPublicRoleToMeshRole(
              inferPublicNetworkRole({
                category,
                ip: item.ip,
                mac: rawMac,
                vendor: item.vendor ?? null,
                name,
                model,
                hostname: item.hostname ?? null,
                status: prismaStatus as 'online' | 'offline' | 'unknown',
              }),
            ),
            online: prismaStatus === PrismaDeviceStatus.online,
            ip: item.ip,
            mac: formattedMac,
            vendor: item.vendor ?? null,
            model,
          };
          currentMesh.push(primaryNode);
          for (const sat of satellites) {
            currentMesh.push({
              nodeId: normalizeMac(sat.rawMac) ?? sat.did,
              nodeName: sat.name,
              role: mapPublicRoleToMeshRole(
                inferPublicNetworkRole({
                  category: sat.category,
                  ip: sat.ip,
                  mac: sat.rawMac,
                  vendor: sat.vendor ?? null,
                  name: sat.name,
                  model: sat.model,
                  hostname: sat.hostname ?? null,
                  status: sat.prismaStatus as 'online' | 'offline' | 'unknown',
                }),
              ),
              online: sat.prismaStatus === PrismaDeviceStatus.online,
              ip: sat.ip,
              mac: sat.formattedMac,
              vendor: sat.vendor ?? null,
              model: sat.model,
              parentNodeId: primaryNode.nodeId,
            });
          }
          if (category === DeviceCategory.WIFI_AP) {
            const existingWifi =
              parsedRuntimeBase.wifiAp &&
              typeof parsedRuntimeBase.wifiAp === 'object' &&
              !Array.isArray(parsedRuntimeBase.wifiAp)
                ? (parsedRuntimeBase.wifiAp as Record<string, unknown>)
                : {};
            const mergedClients: unknown[] = Array.isArray((existingWifi as any).clients)
              ? ((existingWifi as any).clients as unknown[])
              : [];
            for (const sat of satellites) {
              mergedClients.push({
                mac: sat.formattedMac,
                name: sat.name,
                hostname: sat.hostname ?? null,
                ip: sat.ip,
                vendor: sat.vendor ?? null,
                status: sat.prismaStatus,
                deviceKind: 'mesh-satellite',
              });
            }
            const mergedWifi: WifiApRuntime = {
              ssid: String((existingWifi as any).ssid ?? 'Mesh Wi-Fi'),
              clients: mergedClients as any[],
              clientCount: mergedClients.length,
              meshTopology: currentMesh,
              meshBackhaulState:
                currentMesh.filter((n) => !n.online).length === 0 ? 'up' : 'degraded',
              bands: Array.isArray((existingWifi as any).bands) ? ((existingWifi as any).bands as any) : null,
              wanIp: String((existingWifi as any).wanIp ?? item.ip ?? null),
              dns: Array.isArray((existingWifi as any).dns) ? ((existingWifi as any).dns as any) : null,
              band:
                (existingWifi as any).band === '2.4G' ||
                (existingWifi as any).band === '5G' ||
                (existingWifi as any).band === '2.4G+5G'
                  ? ((existingWifi as any).band as any)
                  : null,
              channel: Number((existingWifi as any).channel) || null,
              txRateMbps: Number((existingWifi as any).txRateMbps) || null,
              rxRateMbps: Number((existingWifi as any).rxRateMbps) || null,
              uploadMbps: Number((existingWifi as any).uploadMbps) || null,
              downloadMbps: Number((existingWifi as any).downloadMbps) || null,
              signalDbm: Number((existingWifi as any).signalDbm) || null,
              uptimeSeconds: Number((existingWifi as any).uptimeSeconds) || null,
              lastSeenAt: String((existingWifi as any).lastSeenAt ?? null) || null,
              totalRxBytes: Number((existingWifi as any).totalRxBytes) || null,
              totalTxBytes: Number((existingWifi as any).totalTxBytes) || null,
            };
            parsedRuntimeBase.wifiAp = mergedWifi as any;
          } else if (category === DeviceCategory.FIVE_G_CPE) {
            const existingCpe =
              parsedRuntimeBase.cpe &&
              typeof parsedRuntimeBase.cpe === 'object' &&
              !Array.isArray(parsedRuntimeBase.cpe)
                ? (parsedRuntimeBase.cpe as Record<string, unknown>)
                : {};
            const mergedClients: unknown[] = Array.isArray((existingCpe as any).clients)
              ? ((existingCpe as any).clients as unknown[])
              : [];
            for (const sat of satellites) {
              mergedClients.push({
                mac: sat.formattedMac,
                name: sat.name,
                hostname: sat.hostname ?? null,
                ip: sat.ip,
                vendor: sat.vendor ?? null,
                status: sat.prismaStatus,
                deviceKind: 'mesh-satellite',
              });
            }
            const mergedCpe: FiveGCpeRuntime = {
              online: prismaStatus === PrismaDeviceStatus.online,
              clients: mergedClients as any[],
              routerName: String((existingCpe as any).routerName ?? name),
              model: String((existingCpe as any).model ?? model),
              firmwareVersion: String((existingCpe as any).firmwareVersion ?? null) || null,
              imei: String((existingCpe as any).imei ?? null) || null,
              imsi: String((existingCpe as any).imsi ?? null) || null,
              iccid: String((existingCpe as any).iccid ?? null) || null,
              simReady:
                typeof (existingCpe as any).simReady === 'boolean'
                  ? ((existingCpe as any).simReady as boolean)
                  : null,
            };
            parsedRuntimeBase.cpe = mergedCpe as any;
            parsedRuntimeBase.meshTopology = currentMesh as any;
          }
          storedModel = safeStringifyModel(parsedRuntimeBase);
        }

        const forcePublicFacility =
          category === DeviceCategory.WIFI_AP ||
          category === DeviceCategory.FIVE_G_CPE ||
          category === DeviceCategory.CAMERA;

        const data = {
          siteId,
          name: name.slice(0, 180),
          model: storedModel,
          roomId: forcePublicFacility ? null : item.roomId || existing?.roomId || null,
          status: prismaStatus,
          offlineSince: resolveOfflineSince(existing?.status, existing?.offlineSince, prismaStatus === PrismaDeviceStatus.online),
          lastSyncAt: new Date(),
        };

        const operationNote = existing
          ? `已更新本地识别设备 ${name}（${formattedMac}，分类：${category}）`
          : `已新增本地识别设备 ${name}（${formattedMac}，IP ${item.ip}，分类：${category}）`;

        if (existing) {
          await prisma.device.update({
            where: { did },
            data: {
              ...data,
              roomId: forcePublicFacility ? null : data.roomId || existing.roomId || null,
            },
          });
          updated += 1;
        } else {
          await prisma.device.create({
            data: {
              did,
              ...data,
              power: null,
              powerW: null,
              currentA: null,
              voltageV: null,
              totalKwh: null,
            },
          });
          persisted += 1;
        }
        dids.push(did);

        await writeOperation(
          operatorUserId,
          OperationType.update_settings,
          null,
          {
            action: 'persist_lan_device',
            actionLabel: '本地识别设备加入管理',
            source: actorContext?.source,
            sourceLabel: actorContext?.sourceLabel,
            did,
            mac: formattedMac,
            ip: item.ip,
            vendor: item.vendor ?? null,
            hostname: item.hostname ?? null,
            siteId,
            roomId: data.roomId ?? null,
            previousDeviceId: existing?.id ?? null,
            category,
            note: operationNote,
          },
          true,
        );
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : '未知错误';
        console.error('[persistLanDevices] single device failed', {
          did,
          mac: formattedMac,
          ip: item.ip,
          name,
          vendor: item.vendor ?? null,
          error: err instanceof Error ? err.stack : err,
        });
        errors.push({
          mac: formattedMac,
          ip: item.ip,
          name,
          message,
        });
      }
    }

    try {
      await broadcastDashboard();
    } catch {
      /* ignore broadcast errors */
    }

    return {
      total: input.length,
      persisted,
      updated,
      skipped,
      failed,
      dids,
      categorySummary,
      skippedSummary,
      dryRun: false,
      errors,
      demotedPublicSatelliteDids: Array.from(demotedExistingSatelliteDids),
      primaryPublicNetworkDeviceDids: Array.from(publicPrimaryDids),
    };
  }

  public async refreshLanCameraStatuses(): Promise<number> {
    const devices = await prisma.device.findMany({
      where: {
        did: { startsWith: 'LAN_' },
      },
      select: {
        did: true,
        model: true,
        status: true,
        offlineSince: true,
      },
    });

    let refreshed = 0;
    for (const device of devices) {
      let parsed: Record<string, unknown> | null = null;
      try {
        const obj = JSON.parse(device.model || '{}');
        if (obj && typeof obj === 'object') parsed = obj as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (!parsed) continue;

      // 米家云设备（局域网发现后被米家 API 关联合并）的状态由米家 API 决定，
      // 不再用 ping/端口/快照探测，避免覆盖真实的米家在线状态。
      const ownership = typeof parsed.ownership === 'string' ? parsed.ownership : '';
      const source = typeof parsed.source === 'string' ? parsed.source : '';
      if (ownership === 'xiaomi' || source === 'account_sync') {
        continue;
      }

      const camObj =
        parsed.camera && typeof parsed.camera === 'object' && !Array.isArray(parsed.camera)
          ? (parsed.camera as Record<string, unknown>)
          : null;
      const hasManualSnapshotUrl =
        !!(camObj && typeof camObj.manualSnapshotUrl === 'string' && camObj.manualSnapshotUrl.trim());
      const previousOnline =
        device.status === PrismaDeviceStatus.online || !!(camObj && camObj.online === true);
      const ipAddress =
        typeof parsed.ipAddress === 'string' && parsed.ipAddress.trim()
          ? parsed.ipAddress.trim()
          : null;
      if (!camObj || !ipAddress) continue;

      const probe = await probeLanDeviceReachability({
        ip: ipAddress,
        pingTimeoutMs: 900,
        tcpTimeoutMs: 900,
        tcpPorts: [80, 554, 8000, 8554],
      }).catch(() => ({
        pingAlive: false,
        openTcpPorts: [] as number[],
      }));

      const probeOnline = probe.pingAlive || probe.openTcpPorts.length > 0;
      const snapshotOnline = probeOnline
        ? false
        : await this.probeLanCameraSnapshotOnline(parsed, camObj).catch(() => false);
      const online =
        probeOnline ||
        snapshotOnline ||
        (!probeOnline && !snapshotOnline && hasManualSnapshotUrl ? previousOnline : false);
      const nextModel = this.safeStringifyModel(
        {
          ...parsed,
          camera: {
            ...camObj,
            online,
            lastProbeAt: new Date().toISOString(),
            lastProbePingAlive: probe.pingAlive,
            lastProbePorts: probe.openTcpPorts,
            lastSnapshotProbeOk: snapshotOnline,
          },
        },
        4096,
      );

      await prisma.device.update({
        where: { did: device.did },
        data: {
          model: nextModel,
          status: online ? PrismaDeviceStatus.online : PrismaDeviceStatus.offline,
          offlineSince: resolveOfflineSince(device.status, device.offlineSince, online),
          lastSyncAt: new Date(),
        },
      });
      refreshed += 1;
    }

    return refreshed;
  }

  public async updateDeviceCamera(
    did: string,
    payload: {
      manualSnapshotUrl?: string | null;
      manualAuthUsername?: string | null;
      manualAuthPassword?: string | null;
      manualAuthType?: 'digest' | 'basic' | 'none' | null;
      manualBrand?: string | null;
      manualModel?: string | null;
    },
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ did: string; name?: string | null }> {
    if (!did) throw new Error('缺少设备 DID');
    const existing = await prisma.device.findUnique({ where: { did }, select: { id: true, did: true, model: true, name: true, status: true } });
    if (!existing) throw new Error('未找到该设备');
    let parsed: Record<string, unknown> = { _raw: existing.name ?? 'Camera Device' };
    try {
      const obj = JSON.parse(existing.model || '{}');
      if (obj && typeof obj === 'object') parsed = obj as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const existingCam = (parsed.camera && typeof parsed.camera === 'object' && !Array.isArray(parsed.camera))
      ? (parsed.camera as Record<string, unknown>)
      : {};
    const sanitize = (v: unknown): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return s ? s : null;
    };
    const mergedCam: Record<string, unknown> = {
      ...existingCam,
      manualSnapshotUrl: sanitize(payload.manualSnapshotUrl),
      manualAuthUsername: sanitize(payload.manualAuthUsername),
      manualAuthPassword: sanitize(payload.manualAuthPassword),
      manualAuthType: (() => {
        const v = payload.manualAuthType;
        if (v === 'digest' || v === 'basic' || v === 'none') return v;
        return null;
      })(),
      manualBrand: sanitize(payload.manualBrand),
      manualModel: sanitize(payload.manualModel),
    };
    const nextModel = this.safeStringifyModel({
      ...parsed,
      camera: mergedCam,
    });
    const updated = await prisma.device.update({
      where: { did },
      data: { model: nextModel, updatedAt: new Date(), lastSyncAt: new Date() },
      select: { did: true, name: true },
    });
    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'update_device_camera_manual',
        actionLabel: '修改摄像头快照手动配置',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        did,
        fields: Object.keys(payload),
      },
      true,
    );
    await broadcastDashboard().catch(() => {});
    return updated;
  }

  public async updateDeviceCategory(
    did: string,
    category: string,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ did: string; category: string }> {
    if (!did) throw new Error('缺少设备 DID');
    if (!category || !Object.values(DeviceCategory).includes(category as DeviceCategory)) {
      throw new Error('无效的设备分类');
    }
    const existing = await prisma.device.findUnique({ where: { did }, select: { id: true, did: true, model: true, name: true } });
    if (!existing) throw new Error('未找到该设备');
    let parsed: Record<string, unknown> = { _raw: existing.name ?? 'Device' };
    try {
      const obj = JSON.parse(existing.model || '{}');
      if (obj && typeof obj === 'object') parsed = obj as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const nextModel = this.safeStringifyModel({
      ...parsed,
      manualCategory: category,
    });
    const updated = await prisma.device.update({
      where: { did },
      data: { model: nextModel, updatedAt: new Date(), lastSyncAt: new Date() },
      select: { did: true, name: true },
    });
    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'update_device_category',
        actionLabel: '手动调整设备分类',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        did,
        category,
        deviceName: existing.name,
      },
      true,
    );
    await broadcastDashboard().catch(() => {});
    return { did, category };
  }

  public async deleteDevice(
    did: string,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ did: string }> {
    if (!did) throw new Error('缺少设备 DID');
    const existing = await prisma.device.findUnique({
      where: { did },
      select: { id: true, did: true, name: true },
    });
    if (!existing) throw new AppError(404, 'DEVICE_NOT_FOUND', '未找到该设备');
    await prisma.$transaction([
      prisma.dailyNetworkTraffic.deleteMany({ where: { deviceId: existing.id } }),
      prisma.device.delete({ where: { did } }),
    ]);
    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'delete_device',
        actionLabel: '删除设备',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        did,
        deviceName: existing.name,
      },
      true,
    );
    await broadcastDashboard().catch(() => {});
    return { did };
  }

  // 米家云摄像头无法通过 ONVIF/ISAPI HTTP 接口抓图，需先调用 MiOT start_rtsp_stream
  // 拿到带 token 的 RTSP 地址，再用 ffmpeg 抓一帧 JPEG。
  private async grabXiaomiSnapshotFrame(
    did: string,
    parsed: Record<string, unknown>,
    rawModel: string,
  ): Promise<Buffer | null> {
    const xiaomiDid =
      typeof parsed.xiaomiDid === 'string' && parsed.xiaomiDid.trim()
        ? parsed.xiaomiDid.trim()
        : did;
    const model =
      typeof parsed.model === 'string' && parsed.model.trim()
        ? parsed.model.trim()
        : rawModel;
    const scope = parsed.sourceScope === 'main' ? 'main' : 'camera';

    let rtspUrl = '';
    let snapshotUrl = '';
    // 优先本地 go2rtc 桥 RTSP，拿不到再退回云端 startRTSPStream
    try {
      const localRtsp = await this.resolveLocalGo2rtcRtsp(xiaomiDid);
      if (localRtsp) {
        rtspUrl = localRtsp;
      } else {
        const info = await xiaomiAdapter.startRTSPStream(xiaomiDid, model, scope);
        rtspUrl = info.rtspUrl;
        snapshotUrl = info.snapshotUrl || '';
      }
    } catch (err: any) {
      console.warn('[CameraSnapshot] startRTSPStream failed did=', did, 'err=', err?.message || err);
      return null;
    }

    // 优先用 ffmpeg 从 RTSP 流抓真实帧：米家 start-rtsp-stream 返回的快照 URL 可能是
    // 设备 logo/占位图而非实时画面，直接抓取会导致前端显示米家 logo。
    if (rtspUrl) {
      const frame = await new Promise<Buffer | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let proc: ReturnType<typeof spawn> | null = null;
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (buf: Buffer | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(buf);
        };
        timer = setTimeout(() => {
          try { proc?.kill('SIGKILL'); } catch { /* noop */ }
          finish(null);
        }, 15000);
        try {
          proc = spawn('ffmpeg', [
            ...this.buildInputArgs(rtspUrl),
            '-frames:v', '1',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-q:v', '2',
            'pipe:1',
          ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err: any) {
          console.warn('[CameraSnapshot] ffmpeg spawn failed did=', did, 'err=', err?.message || err);
          finish(null);
          return;
        }
        proc.stdout?.on('data', (chunk: unknown) => {
          chunks.push(Buffer.from(chunk as any));
        });
        proc.stderr?.on('data', () => { /* consume */ });
        proc.on('error', () => finish(null));
        proc.on('exit', () => {
          const buf = Buffer.concat(chunks);
          finish(buf.length > 0 ? buf : null);
        });
      });
      if (frame) return frame;
    }

    // fallback：直接抓米家返回的快照 URL（可能仍是占位图，但作为兜底）
    if (snapshotUrl) {
      try {
        const resp = await axios.get(snapshotUrl, {
          responseType: 'arraybuffer',
          timeout: 8000,
          validateStatus: (s: number) => s >= 200 && s < 300,
        });
        if (resp?.data) {
          const buf = Buffer.from(resp.data as ArrayBuffer);
          if (buf.length > 0) return buf;
        }
      } catch (err: any) {
        console.warn('[CameraSnapshot] snapshotUrl fetch failed did=', did, 'err=', err?.message || err);
      }
    }

    return null;
  }

  public async getDeviceSnapshot(did: string): Promise<{
    contentType: string;
    buffer: Buffer;
    tried: string[];
    lastErrorMessage?: string | null;
  } | null> {
    const device = await prisma.device.findUnique({
      where: { did },
      select: { did: true, name: true, model: true, status: true },
    });
    if (!device) return null;
    let parsed: Record<string, unknown> | null = null;
    try {
      const obj = JSON.parse(device.model || '{}');
      if (obj && typeof obj === 'object') parsed = obj;
    } catch {
      parsed = null;
    }
    // 米家云摄像头：走 RTSP 抓帧生成快照，避免用无效的 ONVIF/ISAPI HTTP 地址
    const isXiaomiCamera =
      parsed?.ownership === 'xiaomi' ||
      (typeof parsed?.xiaomiDid === 'string' && (parsed.xiaomiDid as string).trim().length > 0);
    if (isXiaomiCamera) {
      const frame = await this.grabXiaomiSnapshotFrame(did, parsed!, device.model || '');
      if (frame) {
        return {
          contentType: 'image/jpeg',
          buffer: frame,
          tried: ['xiaomi-rtsp-frame'],
          lastErrorMessage: null,
        };
      }
    }
    const camObj =
      parsed && parsed.camera && typeof parsed.camera === 'object'
        ? (parsed.camera as Record<string, unknown>)
        : null;
    const manualUrl = camObj && typeof camObj.manualSnapshotUrl === 'string' && camObj.manualSnapshotUrl.trim()
      ? camObj.manualSnapshotUrl.trim()
      : null;
    const manualUser = camObj && typeof camObj.manualAuthUsername === 'string' ? camObj.manualAuthUsername : null;
    const manualPass = camObj && typeof camObj.manualAuthPassword === 'string' ? camObj.manualAuthPassword : null;
    const manualAuthType: 'digest' | 'basic' | 'none' = normalizeAuthType(camObj?.manualAuthType);
    const hasManualAuth = !!(manualUser || manualPass);

    const fetchWithAuth = async (url: string, entryAuthPreference: 'digest' | 'basic' | 'none'): Promise<{ ok: boolean; status: number; statusText: string; ct: string; buffer: Buffer } | { error: string }> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), 5000);
        const headers: Record<string, string> = {};
        let usedAuthType: 'digest' | 'basic' | 'none' = entryAuthPreference;
        if (hasManualAuth) {
          usedAuthType = manualAuthType === 'none' ? 'none' : manualAuthType;
        }
        if (hasManualAuth && usedAuthType === 'basic' && manualUser) {
          headers['Authorization'] = buildBasicAuthHeader(manualUser, manualPass || '');
        }
        const resp = await axios.get(url, {
          headers,
          signal: ctrl.signal as any,
          timeout: 5000,
          responseType: 'arraybuffer',
          validateStatus: () => true,
        });
        clearTimeout(timer);
        if (resp.status === 401 && hasManualAuth && usedAuthType === 'digest' && manualUser) {
          const www = resp.headers && (resp.headers['www-authenticate'] || resp.headers['WWW-Authenticate']);
          const wwwStr = Array.isArray(www) ? www[0] : (www as any);
          if (typeof wwwStr === 'string' && /digest/i.test(wwwStr)) {
            const ctrl2 = new AbortController();
            const timer2 = setTimeout(() => ctrl2.abort(), 6000);
            try {
              const authz = buildDigestAuthHeader('GET', url, manualUser, manualPass || '', wwwStr);
              const resp2 = await axios.get(url, {
                headers: { ...headers, Authorization: authz },
                signal: ctrl2.signal as any,
                timeout: 6000,
                responseType: 'arraybuffer',
                validateStatus: () => true,
              });
              clearTimeout(timer2);
              const ct = String(((resp2.headers && (resp2.headers['content-type'] || resp2.headers['Content-Type'])) as any) || '').toLowerCase();
              const buf = Buffer.from((resp2.data as any) ?? new Uint8Array(0));
              return { ok: resp2.status >= 200 && resp2.status < 300, status: resp2.status, statusText: String(resp2.statusText || ''), ct, buffer: buf };
            } catch (err: any) {
              clearTimeout(timer2);
              if (err && err.code && err.code === 'ERR_CANCELED') {
                return { ok: false, status: 504, statusText: 'Gateway Timeout (digest retry)', ct: '', buffer: Buffer.alloc(0) };
              }
              if (err && err.response && typeof err.response.status === 'number') {
                const ct2 = String(((err.response.headers && (err.response.headers['content-type'] || err.response.headers['Content-Type'])) as any) || '').toLowerCase();
                const buf2 = Buffer.from((err.response.data as any) ?? new Uint8Array(0));
                return { ok: false, status: Number(err.response.status), statusText: String(err.response.statusText || err.message || ''), ct: ct2, buffer: buf2 };
              }
              return { error: err instanceof Error ? err.message : String(err ?? '') };
            }
          }
          if (typeof wwwStr === 'string' && /basic/i.test(wwwStr)) {
            const ctrl2 = new AbortController();
            const timer2 = setTimeout(() => ctrl2.abort(), 6000);
            try {
              const basic = `Basic ${buildBasicAuthToken(manualUser, manualPass || '')}`;
              const resp2 = await axios.get(url, {
                headers: { ...headers, Authorization: basic },
                signal: ctrl2.signal as any,
                timeout: 6000,
                responseType: 'arraybuffer',
                validateStatus: () => true,
              });
              clearTimeout(timer2);
              const ct = String(((resp2.headers && (resp2.headers['content-type'] || resp2.headers['Content-Type'])) as any) || '').toLowerCase();
              const buf = Buffer.from((resp2.data as any) ?? new Uint8Array(0));
              return { ok: resp2.status >= 200 && resp2.status < 300, status: resp2.status, statusText: String(resp2.statusText || ''), ct, buffer: buf };
            } catch (err: any) {
              clearTimeout(timer2);
              if (err && err.code && err.code === 'ERR_CANCELED') {
                return { ok: false, status: 504, statusText: 'Gateway Timeout (basic retry)', ct: '', buffer: Buffer.alloc(0) };
              }
              if (err && err.response && typeof err.response.status === 'number') {
                const ct2 = String(((err.response.headers && (err.response.headers['content-type'] || err.response.headers['Content-Type'])) as any) || '').toLowerCase();
                const buf2 = Buffer.from((err.response.data as any) ?? new Uint8Array(0));
                return { ok: false, status: Number(err.response.status), statusText: String(err.response.statusText || err.message || ''), ct: ct2, buffer: buf2 };
              }
              return { error: err instanceof Error ? err.message : String(err ?? '') };
            }
          }
        }
        const ct = String(((resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])) as any) || '').toLowerCase();
        const buf = Buffer.from((resp.data as any) ?? new Uint8Array(0));
        return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, statusText: String(resp.statusText || ''), ct, buffer: buf };
      } catch (err: any) {
        if (timer) clearTimeout(timer);
        if (err && err.code && err.code === 'ERR_CANCELED') {
          return { ok: false, status: 504, statusText: 'Gateway Timeout', ct: '', buffer: Buffer.alloc(0) };
        }
        if (err && err.response && typeof err.response.status === 'number') {
          const ct2 = String(((err.response.headers && (err.response.headers['content-type'] || err.response.headers['Content-Type'])) as any) || '').toLowerCase();
          const buf2 = Buffer.from((err.response.data as any) ?? new Uint8Array(0));
          return { ok: false, status: Number(err.response.status), statusText: String(err.response.statusText || err.message || ''), ct: ct2, buffer: buf2 };
        }
        return { error: err instanceof Error ? err.message : String(err ?? '') };
      }
    };

    const candidates = Array.isArray(camObj?.snapshotCandidates) ? camObj!.snapshotCandidates! : [];
    const httpCandidates = (candidates as Array<Record<string, unknown>>)
      .filter((x) => x && typeof x.url === 'string' && /^https?:/i.test(x.url as string))
      .map((x) => ({ url: x.url as string, auth: ((x.auth as any) ?? 'digest') as 'digest' | 'basic' | 'none' }));
    const defaultIpFromParsed = parsed && typeof parsed.ipAddress === 'string' ? (parsed.ipAddress as string) : null;
    const extraDefaults: Array<{ url: string; auth: 'digest' | 'basic' | 'none' }> = [];
    if (defaultIpFromParsed) {
      extraDefaults.push({ url: `http://${defaultIpFromParsed}/ISAPI/Streaming/channels/101/picture`, auth: 'digest' });
      extraDefaults.push({ url: `http://${defaultIpFromParsed}/cgi-bin/snapshot.cgi?channel=1`, auth: 'digest' });
      extraDefaults.push({ url: `http://${defaultIpFromParsed}/stream/snapshot`, auth: 'digest' });
      extraDefaults.push({ url: `http://${defaultIpFromParsed}/tmpfs/auto.jpg`, auth: 'digest' });
    }
    const urls = [
      ...(manualUrl ? [{ url: manualUrl, auth: manualAuthType === 'none' ? 'none' as const : manualAuthType }] : []),
      ...httpCandidates,
      ...extraDefaults,
    ];
    const tried: string[] = [];
    let lastErrorMessage: string | null = null;
    for (const entry of urls) {
      tried.push(entry.url);
      const r = await fetchWithAuth(entry.url, entry.auth);
      if ('error' in r) {
        lastErrorMessage = r.error;
        continue;
      }
      if (!r.ok) {
        lastErrorMessage = `${r.status} ${r.statusText || ''}`;
        continue;
      }
      if (!r.ct || !/^image\//i.test(r.ct)) {
        lastErrorMessage = `non-image content-type: ${r.ct || 'empty'}`;
        continue;
      }
      // #region debug-point D:camera-snapshot-success
      try { const fs=require('fs'); let u='http://127.0.0.1:7778/event', s='camera-status-sync'; try { const e=fs.readFileSync(path.resolve(process.cwd(),'..','.dbg','camera-status-sync.env'),'utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch { try { const e2=fs.readFileSync(path.resolve(process.cwd(),'.dbg','camera-status-sync.env'),'utf8'); u=e2.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e2.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} } fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'D',location:'system.service.ts:getDeviceSnapshot:success',msg:'[DEBUG] camera snapshot fetched',data:{did,deviceStatus:device.status,manualUrl,triedCount:tried.length,usedUrl:entry.url,contentType:r.ct,bufferSize:r.buffer?.length??0}})}).catch(()=>{}); } catch {}
      // #endregion
      return {
        contentType: r.ct || 'image/jpeg',
        buffer: r.buffer,
        tried,
        lastErrorMessage: null,
      };
    }
    const escapedTried = tried.slice(0, 8).map(u => String(u).replace(/[<>&"]/g, '')).join('&#10;');
    const svgEscapedError = String(lastErrorMessage ?? '').replace(/[<>&"]/g, '');
    // #region debug-point D:camera-snapshot-failed
    try { const fs=require('fs'); let u='http://127.0.0.1:7778/event', s='camera-status-sync'; try { const e=fs.readFileSync(path.resolve(process.cwd(),'..','.dbg','camera-status-sync.env'),'utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch { try { const e2=fs.readFileSync(path.resolve(process.cwd(),'.dbg','camera-status-sync.env'),'utf8'); u=e2.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e2.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} } fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'D',location:'system.service.ts:getDeviceSnapshot:failed',msg:'[DEBUG] camera snapshot failed',data:{did,deviceStatus:device.status,manualUrl,tried,lastErrorMessage}})}).catch(()=>{}); } catch {}
    // #endregion
    return {
      contentType: 'image/svg+xml',
      buffer: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e293b"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><g fill="#94a3b8" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial" text-anchor="middle"><text x="640" y="230" font-size="54" font-weight="600" fill="#cbd5e1">摄像头画面暂不可用</text><text x="640" y="280" font-size="26" fill="#e2e8f0">解决：打开详情抽屉 → 「手动填写快照 URL / 账号密码」→ 保存并刷新</text>${manualUrl ? `<text x="640" y="320" font-size="22" fill="#93c5fd">你已填手动快照地址，当前尝试 ${tried.length} 个地址</text>` : `<text x="640" y="320" font-size="22">默认候选快照地址：</text>`}<text x="640" y="360" font-size="18" fill="#64748b" text-anchor="middle"><tspan x="640" dy="0">${escapedTried.split('&#10;').slice(0, 1).join('') || '（未找到候选地址，先去系统设置-本地识别写入摄像头 IP/MAC）'}</tspan></text>${svgEscapedError ? `<text x="640" y="520" font-size="22" fill="#f87171">最近错误：${svgEscapedError}</text>` : ''}<text x="640" y="580" font-size="18" fill="#64748b">常见默认账号：admin / admin，admin / 空，admin / 123456</text><text x="640" y="610" font-size="18" fill="#64748b">如仍抓不到：在浏览器打开摄像头 Web 后台，把显示画面的那张 jpg 链接复制到「快照 URL」</text></g></svg>`,
        'utf-8',
      ),
      tried,
      lastErrorMessage,
    };
  }

  public async bulkControlDevices(
    action: 'on' | 'off',
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
    siteId?: string,
  ): Promise<{ ok: boolean; action: 'on' | 'off'; total: number; success: number; failed: number }> {
    const devices = await prisma.device.findMany({
      where: siteId ? { siteId } : undefined,
      select: { did: true },
    });

    let success = 0;
    let failed = 0;

    for (const device of devices) {
      try {
        if (action === 'on') {
          await xiaomiAdapter.turnOn(device.did, operatorUserId, actorContext);
        } else {
          await xiaomiAdapter.turnOff(device.did, operatorUserId, actorContext);
        }
        success += 1;
      } catch {
        failed += 1;
      }
    }

    await xiaomiAdapter.refreshAllRoomsRealtime().catch(() => {});
    await broadcastDashboard().catch(() => {});

    await writeOperation(
      operatorUserId,
      OperationType.control_device,
      null,
      {
        action: 'bulk_device_control',
        actionLabel: action === 'on' ? '批量开启设备电源' : '批量关闭设备电源',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        siteId: siteId ?? null,
        powerAction: action,
        totalCount: devices.length,
        successCount: success,
        failedCount: failed,
      },
      failed === 0,
    );

    return {
      ok: failed === 0,
      action,
      total: devices.length,
      success,
      failed,
    };
  }

  public async listSites(): Promise<SiteSummary[]> {
    return this.buildSiteSummary();
  }

  public async createSite(
    input: SiteCreateRequest,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<SiteSummary> {
    const name = input.name.trim();
    const description = input.description?.trim() || null;

    if (!name) {
      throw new Error('区域名称不能为空');
    }

    const latestCount = await prisma.site.count();
    const code = `region-${latestCount + 1}`;

    const site = await prisma.site.create({
      data: {
        code,
        name,
        description,
        isPrimary: false,
        adapterType: 'custom_api',
        storageRetentionDays: 365,
        nodes: {
          create: {
            code: `edge-${latestCount + 1}`,
            name: `${name}节点`,
            nodeType: 'edge',
            status: 'unknown',
            storageRetentionDays: 90,
            isLocalControlEnabled: true,
          },
        },
      },
      select: { id: true },
    });

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'create_site',
        actionLabel: '新增区域',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        siteId: site.id,
        siteName: name,
      },
      true,
    );

    const [summary] = await this.buildSiteSummary([site.id]);
    return summary;
  }

  public async updateSite(
    siteId: string,
    input: SiteUpdateRequest,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<SiteSummary> {
    const existing = await prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true },
    });

    if (!existing) {
      throw new Error('区域不存在');
    }

    const name = input.name?.trim();
    const description =
      typeof input.description === 'string' ? input.description.trim() || null : undefined;

    if (input.name !== undefined && !name) {
      throw new Error('区域名称不能为空');
    }

    await prisma.site.update({
      where: { id: siteId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    });

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'update_site',
        actionLabel: '修改区域信息',
        source: actorContext?.source,
        sourceLabel: actorContext?.sourceLabel,
        siteId,
        siteName: name ?? existing.name,
      },
      true,
    );

    const [summary] = await this.buildSiteSummary([siteId]);
    return summary;
  }

  private static readonly ADAPTER_KIND_HUAWEI_CPE = 'huawei_cpe' as const;
  private static readonly ADAPTER_KIND_NOKIA_BEACON = 'nokia_beacon' as const;

  public async getDeviceAdapterConfig(did: string): Promise<{
    kind: 'huawei_cpe' | 'nokia_beacon' | null;
    baseUrl: string | null;
    username: string | null;
    password: string | null;
    sessionSid: string | null;
    hasPersistedPassword: boolean;
  }> {
    const empty = {
      kind: null,
      baseUrl: null,
      username: null,
      password: null,
      sessionSid: null,
      hasPersistedPassword: false,
    } as const;
    const device = await prisma.device.findUnique({
      where: { did },
      select: { did: true, name: true, model: true, status: true },
    });
    if (!device) return { ...empty };

    let parsed: Record<string, any> | null = null;
    try {
      const obj = JSON.parse(device.model || '{}');
      if (obj && typeof obj === 'object') parsed = obj;
    } catch { parsed = null; }

    const cfg = parsed?.adapterConfig && typeof parsed.adapterConfig === 'object'
      ? (parsed.adapterConfig as Record<string, any>)
      : null;

    const wifiAp = parsed && typeof parsed.wifiAp === 'object' && parsed.wifiAp !== null
      ? (parsed.wifiAp as Record<string, any>)
      : null;
    const cpe = parsed && typeof parsed.fiveGCpe === 'object' && parsed.fiveGCpe !== null
      ? (parsed.fiveGCpe as Record<string, any>)
      : null;
    const runtime = parsed && typeof parsed.runtime === 'object' && parsed.runtime !== null
      ? (parsed.runtime as Record<string, any>)
      : null;
    const runtimeWifiAp = runtime && typeof runtime.wifiAp === 'object' && runtime.wifiAp !== null
      ? (runtime.wifiAp as Record<string, any>)
      : null;
    const runtimeCpe = runtime && (typeof runtime.fiveGCpe === 'object' || typeof runtime.cpe === 'object')
      ? ((runtime.fiveGCpe ?? runtime.cpe) as Record<string, any>)
      : null;

    const vendorName =
      (parsed && typeof parsed.vendorName === 'string' && parsed.vendorName.trim()) ? parsed.vendorName.trim() :
      (parsed && typeof parsed.brand === 'string' && parsed.brand.trim()) ? parsed.brand.trim() :
      null;
    const modelName =
      (parsed && typeof parsed.modelName === 'string' && parsed.modelName.trim()) ? parsed.modelName.trim() :
      (parsed && typeof parsed.model === 'string' && parsed.model.trim()) ? parsed.model.trim() :
      (parsed && typeof parsed._raw === 'string' && parsed._raw.trim()) ? parsed._raw.trim() :
      '';
    const ssidRaw = String(
      ((wifiAp ?? runtimeWifiAp)?.ssid ?? (cpe ?? runtimeCpe)?.ssid ?? parsed?.ssid ?? '')
    ).trim();
    const meshTop = (Array.isArray((wifiAp ?? runtimeWifiAp)?.meshTopology)
      ? (wifiAp ?? runtimeWifiAp)!.meshTopology
      : Array.isArray((cpe ?? runtimeCpe)?.meshTopology)
        ? (cpe ?? runtimeCpe)!.meshTopology
        : []) as any[];
    const hasMeshNodes = meshTop.length >= 2 || meshTop.some((n) => String(n.role ?? '').toLowerCase() === 'master');

    const haystack = `${device.name || ''} ${vendorName || ''} ${modelName || ''} ${ssidRaw || ''}`.toLowerCase();
    const categoryGuess = inferDeviceCategory({
      name: device.name,
      model: modelName || vendorName || (cfg && typeof cfg.model === 'string' ? cfg.model : ''),
      vendor: (cfg && typeof cfg.vendor === 'string' ? cfg.vendor : vendorName),
      mac: null,
      ip: parsed && typeof parsed.ipAddress === 'string' ? parsed.ipAddress : null,
    });

    let kind: 'huawei_cpe' | 'nokia_beacon' | null = null;
    if (cfg && cfg.kind === SystemService.ADAPTER_KIND_HUAWEI_CPE) kind = SystemService.ADAPTER_KIND_HUAWEI_CPE;
    else if (cfg && cfg.kind === SystemService.ADAPTER_KIND_NOKIA_BEACON) kind = SystemService.ADAPTER_KIND_NOKIA_BEACON;
    else if (categoryGuess === DeviceCategory.FIVE_G_CPE) kind = SystemService.ADAPTER_KIND_HUAWEI_CPE;
    else if (categoryGuess === DeviceCategory.WIFI_AP && /(beacon\s*1|ha[-_]?020w|nokia\s*mesh|nokia\s*wifi)/i.test(haystack)) {
      kind = SystemService.ADAPTER_KIND_NOKIA_BEACON;
    } else if (categoryGuess === DeviceCategory.WIFI_AP && hasMeshNodes && /(nokia|beacon|ha-020)/i.test(haystack)) {
      kind = SystemService.ADAPTER_KIND_NOKIA_BEACON;
    } else if (categoryGuess === DeviceCategory.WIFI_AP && vendorName && /nokia/i.test(vendorName)) {
      kind = SystemService.ADAPTER_KIND_NOKIA_BEACON;
    } else if (
      categoryGuess === DeviceCategory.WIFI_AP &&
      parsed &&
      typeof parsed.ipAddress === 'string' &&
      /\.1$/.test(parsed.ipAddress) &&
      !/(nokia|beacon|ha-020)/i.test(haystack)
    ) {
      kind = SystemService.ADAPTER_KIND_HUAWEI_CPE;
    }

    const envBase = (() => {
      if (kind === SystemService.ADAPTER_KIND_HUAWEI_CPE) return process.env.HUAWEI_CPE_BASE_URL || null;
      if (kind === SystemService.ADAPTER_KIND_NOKIA_BEACON) return process.env.NOKIA_BEACON_BASE_URL || null;
      return null;
    })();
    const envUser = (() => {
      if (kind === SystemService.ADAPTER_KIND_HUAWEI_CPE) return process.env.HUAWEI_CPE_USER || process.env.HUAWEI_CPE_USERNAME || null;
      if (kind === SystemService.ADAPTER_KIND_NOKIA_BEACON) return process.env.NOKIA_BEACON_USER || process.env.NOKIA_BEACON_USERNAME || null;
      return null;
    })();
    const envPwd = (() => {
      if (kind === SystemService.ADAPTER_KIND_HUAWEI_CPE) return process.env.HUAWEI_CPE_PASSWORD || process.env.HUAWEI_CPE_PWD || null;
      if (kind === SystemService.ADAPTER_KIND_NOKIA_BEACON) return process.env.NOKIA_BEACON_PASSWORD || process.env.NOKIA_BEACON_PWD || null;
      return null;
    })();
    const envSessionSid = (() => {
      if (kind === SystemService.ADAPTER_KIND_NOKIA_BEACON) return process.env.NOKIA_SESSION_SID || process.env.NOKIA_BEACON_SESSION_SID || null;
      return null;
    })();

    const cfgBase = cfg && typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : null;
    const cfgUser = cfg && typeof cfg.username === 'string' && cfg.username.trim() ? cfg.username.trim() : null;
    const cfgPwd = cfg && typeof cfg.password === 'string' ? cfg.password : null;
    const cfgSessionSid = cfg && typeof (cfg as any).sessionSid === 'string' && (cfg as any).sessionSid.trim() ? (cfg as any).sessionSid.trim() : null;
    const hasPersistedPassword = Boolean(cfgPwd && cfgPwd.length > 0);

    const ipFromModel = parsed && typeof parsed.ipAddress === 'string' && parsed.ipAddress.trim()
      ? `http://${parsed.ipAddress.trim()}`
      : null;

    return {
      kind,
      baseUrl: cfgBase || envBase || ipFromModel,
      username: cfgUser || envUser || (kind ? 'admin' : null),
      password: cfgPwd || envPwd || null,
      sessionSid: cfgSessionSid || envSessionSid || null,
      hasPersistedPassword,
    };
  }

  public async saveDeviceAdapterConfig(
    did: string,
    config: {
      kind?: 'huawei_cpe' | 'nokia_beacon' | null;
      baseUrl?: string | null;
      username?: string | null;
      password?: string | null;
      sessionSid?: string | null;
    },
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<{ ok: boolean; kind: 'huawei_cpe' | 'nokia_beacon' | null; message?: string; hasPersistedPassword?: boolean }> {
    const device = await prisma.device.findUnique({ where: { did }, select: { did: true, name: true, model: true } });
    if (!device) return { ok: false, kind: null, message: '设备不存在' };

    let parsed: Record<string, any> = {};
    try {
      const obj = JSON.parse(device.model || '{}');
      if (obj && typeof obj === 'object') parsed = obj;
    } catch { parsed = {}; }
    const auditDeviceName =
      (typeof device.name === 'string' && device.name.trim() && !/^\*?\s*no company\s*\*?$/i.test(device.name)
        ? device.name.trim()
        : null) ||
      (parsed.fiveGCpe && typeof parsed.fiveGCpe === 'object' && typeof (parsed.fiveGCpe as any).model === 'string'
        ? String((parsed.fiveGCpe as any).model).trim()
        : null) ||
      (parsed.wifiAp && typeof parsed.wifiAp === 'object' && typeof (parsed.wifiAp as any).model === 'string'
        ? String((parsed.wifiAp as any).model).trim()
        : null) ||
      (typeof parsed.ipAddress === 'string' && parsed.ipAddress.trim() ? String(parsed.ipAddress).trim() : null) ||
      did;

    const existing = parsed.adapterConfig && typeof parsed.adapterConfig === 'object'
      ? { ...(parsed.adapterConfig as Record<string, any>) }
      : {};

    if (config.kind !== undefined) existing.kind = config.kind || null;
    if (config.baseUrl !== undefined) {
      existing.baseUrl = config.baseUrl && config.baseUrl.trim()
        ? config.baseUrl.trim().replace(/\/+$/, '')
        : null;
    }
    if (config.username !== undefined) existing.username = config.username && config.username.trim() ? config.username.trim() : null;
    if (config.password !== undefined) {
      const pw = typeof config.password === 'string' ? config.password : '';
      if (pw && pw.trim().length > 0) {
        existing.password = pw;
      } else if (Object.prototype.hasOwnProperty.call(config, 'password') && pw === '') {
        existing.password = null;
      }
    }
    if (config.sessionSid !== undefined) {
      const v = typeof config.sessionSid === 'string' ? config.sessionSid : '';
      existing.sessionSid = v && v.trim().length > 0 ? v.trim() : null;
    }

    parsed.adapterConfig = existing;

    const safeStringify = (obj: unknown, maxLen = 2048): string => {
      let s = '';
      try { s = JSON.stringify(obj); } catch { s = String(obj); }
      if (s.length <= maxLen) return s;
      const shallow: Record<string, any> = {};
      for (const k of Object.keys(obj as any)) {
        const v = (obj as any)[k];
        if (typeof v === 'string' && v.length > 180) { shallow[k] = v.slice(0, 180) + '…'; continue; }
        if (Array.isArray(v) && v.length > 8) { shallow[k] = v.slice(0, 8); continue; }
        shallow[k] = v;
      }
      try { s = JSON.stringify(shallow); } catch { s = String(shallow); }
      if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
      return s;
    };

    await prisma.device.update({ where: { did }, data: { model: safeStringify(parsed), lastSyncAt: new Date() } });

    const hasPersistedPassword = Boolean(existing.password && typeof existing.password === 'string' && existing.password.length > 0);

    await writeOperation(
      operatorUserId,
      OperationType.update_settings,
      null,
      {
        action: 'save_device_adapter_config',
        actionLabel: `保存本地适配器配置：${device.name || did}`,
        source: 'api_client',
        sourceLabel: actorContext?.sourceLabel || '局域网本地 API',
        did,
        deviceDid: did,
        deviceName: auditDeviceName,
        adapterKind: existing.kind || null,
        adapterBaseUrl: existing.baseUrl || null,
        adapterUserSet: Boolean(existing.username),
        adapterPasswordSet: hasPersistedPassword,
      },
      true,
    );
    await broadcastDashboard().catch(() => {});

    return { ok: true, kind: (existing.kind as any) ?? null, message: '本地适配器配置已保存', hasPersistedPassword };
  }

  public async refreshDeviceRuntime(
    did: string,
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
    options?: { silent?: boolean },
  ): Promise<{
    ok: boolean;
    kind: string;
    runtime?: FiveGCpeRuntime | WifiApRuntime | null;
    errorMessage?: string;
  }> {
    const cfg = await this.getDeviceAdapterConfig(did);
    if (!cfg.kind) return { ok: false, kind: 'unknown', errorMessage: '设备未识别为支持的本地适配器类型（5G CPE 或 Nokia Beacon Mesh）' };
    if (!cfg.baseUrl) return { ok: false, kind: cfg.kind, errorMessage: '缺少设备局域网 baseUrl，请在详情抽屉填入 WebUI IP' };

    const device = await prisma.device.findUnique({ where: { did }, select: { did: true, name: true, model: true, status: true, offlineSince: true } });
    if (!device) return { ok: false, kind: cfg.kind, errorMessage: '设备不存在' };

    let parsed: Record<string, any> = {};
    try {
      const obj = JSON.parse(device.model || '{}');
      if (obj && typeof obj === 'object') parsed = obj;
    } catch { parsed = {}; }
    const auditDeviceName =
      (typeof device.name === 'string' && device.name.trim() && !/^\*?\s*no company\s*\*?$/i.test(device.name)
        ? device.name.trim()
        : null) ||
      (parsed.fiveGCpe && typeof parsed.fiveGCpe === 'object' && typeof (parsed.fiveGCpe as any).model === 'string'
        ? String((parsed.fiveGCpe as any).model).trim()
        : null) ||
      (parsed.wifiAp && typeof parsed.wifiAp === 'object' && typeof (parsed.wifiAp as any).model === 'string'
        ? String((parsed.wifiAp as any).model).trim()
        : null) ||
      (typeof parsed.ipAddress === 'string' && parsed.ipAddress.trim() ? String(parsed.ipAddress).trim() : null) ||
      did;

    let runtime: FiveGCpeRuntime | WifiApRuntime | null = null;
    let errorMessage: string | undefined;
    const startedAt = Date.now();

    try {
      if (cfg.kind === SystemService.ADAPTER_KIND_HUAWEI_CPE) {
        if (!cfg.username || !cfg.password) {
          throw new Error('缺少华为 5G CPE WebUI 管理员用户名或密码，请在详情抽屉填入后再刷新');
        }
        // #region debug-point A:refresh-runtime-start
        try { const fs=require('fs'); const path=require('path'); let u='http://127.0.0.1:7777/event', s='cpe-rate-stuck'; try { const e=fs.readFileSync(path.resolve(process.cwd(),'..','.dbg','cpe-rate-stuck.env'),'utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch { try { const e2=fs.readFileSync(path.resolve(process.cwd(),'.dbg','cpe-rate-stuck.env'),'utf8'); u=e2.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e2.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} } fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'A',location:'system.service.ts:refreshDeviceRuntime:start',msg:'[DEBUG] refresh device runtime started',data:{did,kind:cfg.kind,baseUrl:cfg.baseUrl,storedLastSyncAt:typeof parsed?.fiveGCpe?.lastSyncAt === 'string' ? parsed.fiveGCpe.lastSyncAt : null,storedDownloadMbps:Number(parsed?.fiveGCpe?.downloadMbps ?? NaN),storedUploadMbps:Number(parsed?.fiveGCpe?.uploadMbps ?? NaN)}})}).catch(()=>{}); } catch {}
        // #endregion
        const adapter = new HuaweiCpeAdapter({
          baseUrl: cfg.baseUrl,
          username: cfg.username || undefined,
          password: cfg.password || '',
        });
        const fetched = await adapter.fetchStatus();
        if (!fetched || typeof fetched !== 'object') {
          throw new Error('华为 CPE 返回空响应，请确认 baseUrl / 账号密码正确且设备在线');
        }
        // #region debug-point A:refresh-runtime-fetched
        try { const fs=require('fs'); const path=require('path'); let u='http://127.0.0.1:7777/event', s='cpe-rate-stuck'; try { const e=fs.readFileSync(path.resolve(process.cwd(),'..','.dbg','cpe-rate-stuck.env'),'utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch { try { const e2=fs.readFileSync(path.resolve(process.cwd(),'.dbg','cpe-rate-stuck.env'),'utf8'); u=e2.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e2.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} } fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'A',location:'system.service.ts:refreshDeviceRuntime:fetched',msg:'[DEBUG] refresh device runtime fetched',data:{did,kind:cfg.kind,fetchedLastSyncAt:typeof (fetched as any)?.lastSyncAt === 'string' ? (fetched as any).lastSyncAt : null,fetchedDownloadMbps:Number((fetched as any)?.downloadMbps ?? NaN),fetchedUploadMbps:Number((fetched as any)?.uploadMbps ?? NaN),connectedDevices:Number((fetched as any)?.connectedDevices ?? NaN)}})}).catch(()=>{}); } catch {}
        // #endregion
        const existingCpe =
          parsed.fiveGCpe && typeof parsed.fiveGCpe === 'object'
            ? (parsed.fiveGCpe as Record<string, any>)
            : null;
        const toPositiveNumber = (value: unknown): number | null => {
          const n = Number(value);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const currentSessionSeconds = toPositiveNumber(fetched.sessionTimeSeconds);
        const previousSessionSeconds = toPositiveNumber(existingCpe?.sessionTimeSeconds);
        const sessionRestarted =
          currentSessionSeconds != null &&
          previousSessionSeconds != null &&
          currentSessionSeconds + 30 < previousSessionSeconds;
        const normalizeStoredPeak = (value: unknown): number | null => {
          const n = toPositiveNumber(value);
          if (n == null) return null;
          // Drop abnormal peaks written by the previous version so traffic/wrong-unit values are not treated as rate peaks.
          if (n > 1000) return null;
          return n;
        };
        const nextPeak = (current: unknown, storedPeak: unknown, previousRate: unknown): number | null => {
          const currentValue = toPositiveNumber(current);
          const candidates = [currentValue];
          if (!sessionRestarted) {
            candidates.push(normalizeStoredPeak(storedPeak));
            candidates.push(normalizeStoredPeak(previousRate));
          }
          const valid = candidates.filter((value): value is number => value != null);
          return valid.length > 0 ? Math.max(...valid) : null;
        };
        runtime = {
          ...fetched,
          peakDownloadMbps: nextPeak(fetched.downloadMbps, existingCpe?.peakDownloadMbps, existingCpe?.downloadMbps),
          peakUploadMbps: nextPeak(fetched.uploadMbps, existingCpe?.peakUploadMbps, existingCpe?.uploadMbps),
        };
        parsed.fiveGCpe = runtime;
      } else if (cfg.kind === SystemService.ADAPTER_KIND_NOKIA_BEACON) {
        if (!cfg.sessionSid && (!cfg.username || !cfg.password)) {
          throw new Error(
            '缺少 Nokia Beacon 登录凭据：请在详情抽屉填入「sessionSid」（浏览器 WebUI 成功登录后复制），或填写管理员用户名 + 密码后再刷新',
          );
        }
        const adapter = new NokiaBeaconAdapter({
          baseUrl: cfg.baseUrl,
          username: cfg.username || undefined,
          password: cfg.password || '',
          sessionSid: cfg.sessionSid || undefined,
        });
        const fetched = await adapter.fetchMeshStatus();
        if (!fetched || typeof fetched !== 'object') {
          throw new Error('Nokia Beacon 返回空响应，请确认主控 baseUrl / 账号密码正确且主节点在线');
        }
        runtime = fetched;
        parsed.wifiAp = runtime;
      } else {
        return { ok: false, kind: cfg.kind, errorMessage: '未知适配器类型' };
      }
    } catch (err: any) {
      errorMessage = err instanceof Error ? err.message : String(err ?? '未知错误');
    }

    const safeStringify = (obj: unknown, maxLen = 4096): string => {
      let s = '';
      try { s = JSON.stringify(obj); } catch { s = String(obj); }
      if (s.length <= maxLen) return s;
      const shallow: Record<string, any> = {};
      for (const k of Object.keys(obj as any)) {
        const v = (obj as any)[k];
        if (k === 'snapshotCandidates' || k === '_raw') continue;
        if (typeof v === 'string' && v.length > 220) { shallow[k] = v.slice(0, 220) + '…'; continue; }
        if (Array.isArray(v) && v.length > 24) { shallow[k] = v.slice(0, 24); continue; }
        shallow[k] = v;
      }
      try { s = JSON.stringify(shallow); } catch { s = String(shallow); }
      if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
      return s;
    };

    if (!runtime) {
      if (!options?.silent) {
        await writeOperation(
          operatorUserId,
          OperationType.sync_devices,
          null,
          {
            action: 'refresh_device_runtime',
            actionLabel: `刷新本地设备运行时：${device.name}`,
            source: 'api_client',
            sourceLabel: actorContext?.sourceLabel || '局域网本地 API',
            did,
            deviceDid: did,
            deviceName: auditDeviceName,
            adapterKind: cfg.kind,
            adapterBaseUrl: cfg.baseUrl,
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: errorMessage || '刷新失败，无运行时返回',
          },
          false,
        );
      }
      return {
        ok: false,
        kind: cfg.kind,
        runtime: null,
        errorMessage: errorMessage || '刷新失败，无运行时返回',
      };
    }

    const statusUpdate: any = { model: safeStringify(parsed) };
    const onlineAny = (runtime as any).online;
    if (typeof onlineAny === 'boolean') {
      statusUpdate.status = onlineAny ? PrismaDeviceStatus.online : PrismaDeviceStatus.offline;
      statusUpdate.offlineSince = resolveOfflineSince(device.status, device.offlineSince, onlineAny);
    }
    statusUpdate.lastSyncAt = new Date();

    await prisma.device.update({ where: { did }, data: statusUpdate });
    // #region debug-point A:refresh-runtime-persisted
    try { const fs=require('fs'); const path=require('path'); let u='http://127.0.0.1:7777/event', s='cpe-rate-stuck'; try { const e=fs.readFileSync(path.resolve(process.cwd(),'..','.dbg','cpe-rate-stuck.env'),'utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch { try { const e2=fs.readFileSync(path.resolve(process.cwd(),'.dbg','cpe-rate-stuck.env'),'utf8'); u=e2.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e2.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} } fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'A',location:'system.service.ts:refreshDeviceRuntime:persisted',msg:'[DEBUG] refresh device runtime persisted',data:{did,kind:cfg.kind,persistedStatus:statusUpdate.status ?? null,persistedLastSyncAt:statusUpdate.lastSyncAt instanceof Date ? statusUpdate.lastSyncAt.toISOString() : null,persistedDownloadMbps:Number((parsed as any)?.fiveGCpe?.downloadMbps ?? (parsed as any)?.wifiAp?.downloadMbps ?? NaN),persistedUploadMbps:Number((parsed as any)?.fiveGCpe?.uploadMbps ?? (parsed as any)?.wifiAp?.uploadMbps ?? NaN),durationMs:Date.now()-startedAt,errorMessage:errorMessage ?? null}})}).catch(()=>{}); } catch {}
    // #endregion

    if (!options?.silent) {
      await writeOperation(
        operatorUserId,
        OperationType.sync_devices,
        null,
        {
          action: 'refresh_device_runtime',
          actionLabel: `刷新本地设备运行时：${device.name}`,
          source: 'api_client',
          sourceLabel: actorContext?.sourceLabel || '局域网本地 API',
          did,
          deviceDid: did,
          deviceName: auditDeviceName,
          adapterKind: cfg.kind,
          adapterBaseUrl: cfg.baseUrl,
          durationMs: Date.now() - startedAt,
          success: !errorMessage,
          errorMessage: errorMessage || null,
        },
        !errorMessage,
      );
      await broadcastDashboard().catch(() => {});
    }

    return {
      ok: !errorMessage,
      kind: cfg.kind,
      runtime,
      errorMessage,
    };
  }

  public async refreshDashboardNetworkRuntimes(maxAgeMs = 15_000): Promise<number> {
    const devices = await prisma.device.findMany({
      where: {
        did: { startsWith: 'LAN_' },
      },
      select: {
        did: true,
        lastSyncAt: true,
        model: true,
      },
    });

    let refreshed = 0;
    for (const device of devices) {
      let parsed: Record<string, any> | null = null;
      try {
        const obj = JSON.parse(device.model || '{}');
        if (obj && typeof obj === 'object') parsed = obj as Record<string, any>;
      } catch {
        parsed = null;
      }
      const kind = parsed?.adapterConfig?.kind;
      if (kind !== SystemService.ADAPTER_KIND_HUAWEI_CPE && kind !== SystemService.ADAPTER_KIND_NOKIA_BEACON) {
        continue;
      }
      const lastSyncTs = device.lastSyncAt ? new Date(device.lastSyncAt).getTime() : 0;
      if (lastSyncTs > 0 && (Date.now() - lastSyncTs) < maxAgeMs) {
        continue;
      }
      const result = await this.refreshDeviceRuntime(device.did, null, undefined, { silent: true }).catch(() => null);
      if (result?.ok) refreshed += 1;
    }
    return refreshed;
  }
}

export const systemService = new SystemService();
export default SystemService;
