import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { spawn, ChildProcessByStdio } from 'child_process';
import { Readable as NodeReadable } from 'stream';
import { xiaomiAdapter } from '../xiaomi.adapter';

// 云端 HLS 本地代理的进程状态（自动续流 + 后台自愈）
export interface CloudHlsProxyState {
  proc: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null;
  safeDid: string;
  did: string;
  scope: 'main' | 'camera';
  outDir: string;
  startedAt: number;
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  lastCloudUrl: string;
  restarts: number;
  /** 当前 HLS URL 因临时网络断连（chunklist EOF/ECONNRESET/TLS reset）已连续同 URL 恢复的次数 */
  recoverAttempts: number;
  /** 提前预热好的下一个云端会话 URL（会话到期时无缝切换） */
  pendingUrl: string | null;
  /** pendingUrl 的创建/验证时间（切换前检查是否已过期，避免用失效 URL） */
  pendingCreatedAt: number;
  /** 提前续流定时器（streaming 期间周期触发 prewarm，保持 pending 新鲜） */
  renewTimer: NodeJS.Timeout | null;
  /** 预热备用会话的连续失败次数（受限重试，避免无限申请触发账号限流） */
  prewarmFailures: number;
  /** 后台恢复循环定时器（cooldown 只限频、不停止恢复） */
  recoveryTimer: NodeJS.Timeout | null;
  /** 当前恢复退避值（失败按阶梯增长，成功清零） */
  recoveryBackoffMs: number;
  /** 连续恢复失败次数（用于阶梯退避与日志） */
  recoveryFailures: number;
  /** 最近一次恢复失败的原因（playlist_http_403 / segment_http_403 / session_not_ready / timeout / dns_failure 等） */
  lastRecoveryReason: string;
  /** 最近一次 URL 预热的验证结果原因（临时字段，供 recoverOnce 读取） */
  lastVerifyReason: string;
}

/** CloudHlsProxyManager 对宿主 SystemService 的最小依赖集 */
export interface CloudHlsProxyDeps {
  getHlsDir(did: string): string;
  isHlsReady(out: string, maxAgeMs?: number): boolean;
  waitForHlsReadyOrExit(did: string, timeoutMs?: number): Promise<boolean>;
  buildInputArgs(url: string): string[];
  /** camera 区会话最近一次成功写入 Redis 的时间戳（自动重登成功后用于清除冷却/失败计数） */
  cameraSessionUpdatedAt?(): number;
}

// ── 参数 ──
const CLOUD_HLS_MAX_RECOVER = 3;
const CLOUD_HLS_RECOVER_BACKOFF_MS = 3000;
// pending 超过此年龄视为失效：切换前丢弃并重新申请（pending 必须足够"晚创建"，不能闲置 30s）
const CLOUD_HLS_PENDING_MAX_AGE_MS = 15_000;
// 预热失败后的受限重试间隔与最大次数
const CLOUD_HLS_PREWARM_RETRY_MS = 8_000;
const CLOUD_HLS_PREWARM_MAX_FAILURES = 3;
// 后台恢复退避阶梯：0(立即) → 5s → 10s → 20s → 30s → 60s → 120s → 300s(上限)。
// 连续失败时逐步降低对 Xiaomi 的会话申请频率，避免"越失败越创建、越创建越被限流"的自维持循环；
// 单次短暂抖动仍是立即重试，只有持续坏窗口才拉长间隔，给 CDN/账号限流留出恢复时间。
const CLOUD_HLS_RECOVERY_BACKOFF_LADDER = [0, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000];
// 分级冷却参数：仅用于信息展示与"会话刷新后清零"，不再作为恢复机制的阻塞闸门
const CLOUD_HLS_COOLDOWN_BASE_MS = 20_000;
const CLOUD_HLS_COOLDOWN_MAX_MS = 120_000;
const CLOUD_HLS_FAIL_LIMIT = 5;
// 停滞判定：playlist 超过 15s 未更新，或最新分片超过 20s 未更新；首片宽限 25s
const CLOUD_HLS_STALL_PLAYLIST_MS = 15_000;
const CLOUD_HLS_STALL_TS_MS = 20_000;
const CLOUD_HLS_FIRST_SEGMENT_GRACE_MS = 25_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 删除 playlist 中未被引用的陈旧分片（只在新流 ready 之后调用，避免磁盘泄漏）。 */
export function pruneStaleHlsSegments(outDir: string, playlistFile: string): void {
  try {
    if (!fs.existsSync(playlistFile)) return;
    const content = fs.readFileSync(playlistFile, 'utf8');
    const referenced = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#') && /\.(ts|m4s)$/i.test(t)) referenced.add(path.basename(t));
    }
    if (referenced.size === 0) return;
    for (const f of fs.readdirSync(outDir)) {
      if (/\.(ts|m4s)$/i.test(f) && !referenced.has(f)) {
        try { fs.unlinkSync(path.join(outDir, f)); } catch { /* noop */ }
      }
    }
  } catch { /* noop */ }
}

/** 返回 playlist 中被引用的最新分片的 mtime 年龄（ms）；无分片或无 playlist 返回 Infinity。 */
export function latestReferencedSegmentAgeMs(outDir: string, playlistFile: string): number {
  try {
    if (!fs.existsSync(playlistFile)) return Number.POSITIVE_INFINITY;
    const content = fs.readFileSync(playlistFile, 'utf8');
    let latest = Number.POSITIVE_INFINITY;
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !/\.(ts|m4s)$/i.test(t)) continue;
      const p = path.join(outDir, path.basename(t));
      if (fs.existsSync(p)) {
        const age = Date.now() - fs.statSync(p).mtimeMs;
        if (age < latest) latest = age;
      }
    }
    return latest;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// 云端 HLS 本地代理（自动续流 + 后台自愈）：
// 服务端用 ffmpeg 持续拉取小米云端 HLS 并重切为本地 HLS（streams/hls/<did>/stream.m3u8）。
// 云端会话因 CDN 间歇性失效/URL 时效而中断时，由 exit/watchdog 触发**后台恢复循环**，
// 不依赖浏览器请求。cooldown 只限制"疯狂创建 session"，绝不放弃恢复。
export class CloudHlsProxyManager {
  private states = new Map<string, CloudHlsProxyState>();

  // 启动中的代理（避免前端重连与内部恢复并发触发多次 startHLSStream）
  private starting = new Map<string, Promise<void>>();

  // 连续启动失败时间戳/计数（仅用于信息展示与会话刷新后清零）
  private cooldown = new Map<string, number>();
  private failCount = new Map<string, number>();

  // 每摄像头 HLS 会话创建互斥（start / prewarm / recovery 不并发创建会话）
  private creating = new Set<string>();

  constructor(private readonly deps: CloudHlsProxyDeps) {}

  /**
   * 状态报告 + 冷启动触发：
   * - 有活进程 → 报告 hlsReady
   * - 已有 state（死亡/恢复中）→ 确保后台恢复循环在跑，报告"恢复中"
   * - 无 state → 冷启动
   * 不再用 cooldown 短路恢复：恢复由后台循环驱动，浏览器刷新只是被动的状态读取。
   */
  public async ensure(
    did: string,
    scope: 'main' | 'camera' = 'camera',
  ): Promise<{ hlsUrl: string | null; hlsReady: boolean; proxyMode: string; errorMessage?: string }> {
    const safeDid = String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const hlsOutFile = path.join(this.deps.getHlsDir(safeDid), 'stream.m3u8');
    const hlsUrl = `/streams/hls/${encodeURIComponent(safeDid)}/stream.m3u8`;

    const existing = this.states.get(safeDid);
    if (existing && existing.proc && !existing.proc.killed) {
      return { hlsUrl, hlsReady: this.deps.isHlsReady(hlsOutFile), proxyMode: 'cloud-hls-proxy' };
    }
    // 并发去重：已有启动任务在跑则等待
    const inFlight = this.starting.get(safeDid);
    if (inFlight) {
      try { await inFlight; } catch { /* noop */ }
      const st = this.states.get(safeDid);
      if (st && st.proc && !st.proc.killed) {
        return { hlsUrl, hlsReady: this.deps.isHlsReady(hlsOutFile), proxyMode: 'cloud-hls-proxy' };
      }
      return { hlsUrl, hlsReady: false, proxyMode: 'none', errorMessage: '云端 HLS 会话启动中，请稍候' };
    }
    if (existing) {
      // camera 会话刚被自动/手动重登刷新 → 清零失败计数与退避，立即恢复
      const sessionUpdatedAt = this.deps.cameraSessionUpdatedAt ? this.deps.cameraSessionUpdatedAt() : 0;
      if (sessionUpdatedAt > (this.cooldown.get(safeDid) ?? 0)) {
        this.cooldown.delete(safeDid);
        this.failCount.delete(safeDid);
        existing.recoveryBackoffMs = 0;
        console.info(`[CloudHlsProxy][${safeDid}] camera session refreshed, reset recovery state`);
      }
      // 确保后台恢复循环在跑（若没有，立即触发一次；有则按退避继续，不跳过退避）
      if (!existing.stopping && !existing.recoveryTimer && !existing.restartTimer) {
        this.scheduleRecovery(existing, 0);
      }
      return {
        hlsUrl,
        hlsReady: false,
        proxyMode: 'none',
        errorMessage: existing.recoveryBackoffMs > 0
          ? `云端 HLS 正在恢复（约 ${Math.ceil(existing.recoveryBackoffMs / 1000)}s 后重试${existing.lastRecoveryReason ? `，原因：${this.reasonText(existing.lastRecoveryReason)}` : ''}）`
          : '云端 HLS 会话恢复中，请稍候',
      };
    }
    // 冷启动：首次为这台摄像头建立代理
    const startTask = this.start(safeDid, did, scope, 0);
    this.starting.set(safeDid, startTask);
    try {
      await startTask;
    } catch (err: any) {
      console.warn('[CloudHlsProxy] cold start failed did=', safeDid, 'err=', err?.message || err);
      const st = this.states.get(safeDid);
      if (st) this.scheduleRecovery(st, 0); // 失败也进入后台恢复循环
      return { hlsUrl, hlsReady: false, proxyMode: 'none', errorMessage: '云端 HLS 会话启动失败，后台自动恢复中' };
    } finally {
      if (this.starting.get(safeDid) === startTask) this.starting.delete(safeDid);
    }
    const ready = await this.waitLocalReady(safeDid, hlsOutFile, 12000);
    if (ready) this.failCount.delete(safeDid);
    return { hlsUrl, hlsReady: ready, proxyMode: 'cloud-hls-proxy' };
  }

  /** 等待本地 HLS 真正就绪（playlist 新鲜 + 至少一个被引用分片存在）；ffmpeg 提前退出则立即返回 */
  private async waitLocalReady(safeDid: string, hlsOutFile: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.deps.isHlsReady(hlsOutFile)) return true;
      const s = this.states.get(safeDid);
      if (s && s.proc && s.proc.exitCode !== null) return this.deps.isHlsReady(hlsOutFile);
      await sleep(300);
    }
    return this.deps.isHlsReady(hlsOutFile);
  }

  public stop(did: string): void {
    this.cleanup(String(did || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown');
  }

  public stopAll(): void {
    for (const safeDid of Array.from(this.states.keys())) {
      this.cleanup(safeDid);
    }
  }

  private cleanup(safeDid: string): void {
    const state = this.states.get(safeDid);
    if (!state) return;
    state.stopping = true;
    if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
    if (state.renewTimer) { clearTimeout(state.renewTimer); state.renewTimer = null; }
    if (state.recoveryTimer) { clearTimeout(state.recoveryTimer); state.recoveryTimer = null; }
    if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
    if (state.proc && !state.proc.killed) { try { state.proc.kill('SIGKILL'); } catch { /* noop */ } }
    this.states.delete(safeDid);
  }

  /**
   * 冷启动/恢复共用的启动过程：
   * - 复用或创建 state（恢复期不删除 state，保证后台恢复循环有挂载点）
   * - 清理旧进程/定时器；只杀当前进程，绝不启动第二个 ffmpeg
   * - 申请 URL（冷启动 ≤2 候选；恢复轮 ≤1 候选）+ 预热验证 → spawn ffmpeg
   * - 失败抛出，state 保留（proc=null），由调用方安排后台恢复
   */
  private async start(
    safeDid: string,
    did: string,
    scope: 'main' | 'camera',
    restarts: number,
    maxAttempts = 2,
  ): Promise<void> {
    const outDir = this.deps.getHlsDir(safeDid);
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* noop */ }

    let state = this.states.get(safeDid);
    if (state) {
      if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
      if (state.renewTimer) { clearTimeout(state.renewTimer); state.renewTimer = null; }
      if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
      if (state.proc && !state.proc.killed) { try { state.proc.kill('SIGKILL'); } catch { /* noop */ } }
      state.proc = null;
    } else {
      state = {
        proc: null,
        safeDid,
        did,
        scope,
        outDir,
        startedAt: Date.now(),
        stopping: false,
        restartTimer: null,
        watchdog: null,
        lastCloudUrl: '',
        restarts,
        recoverAttempts: 0,
        pendingUrl: null,
        pendingCreatedAt: 0,
        renewTimer: null,
        prewarmFailures: 0,
        recoveryTimer: null,
        recoveryBackoffMs: 0,
        recoveryFailures: 0,
        lastRecoveryReason: '',
        lastVerifyReason: '',
      };
      this.states.set(safeDid, state);
    }
    state.restarts = restarts;
    state.lastVerifyReason = '';
    // 本回合不沿用旧 pending（恢复场景下旧 pending 已尝试/失效）
    state.pendingUrl = null;
    state.pendingCreatedAt = 0;

    // per-did 创建互斥：最多等 5s 让 prewarm 完成，然后独占本次创建过程
    for (let i = 0; i < 25 && this.creating.has(safeDid); i += 1) {
      await sleep(200);
    }
    this.creating.add(safeDid);
    try {
      // 云端 startHLSStream 概率性返回无效 URL；恢复轮最多申请 1 个候选，避免高频创建 session 加剧限流。
      // 预热窗口：立即 + 每秒重试（session_not_ready/网络类可重试；403/404 直接判死不再重试同一候选）。
      let cloudUrl = '';
      let warmed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const hls = await xiaomiAdapter.startHLSStream(did, scope);
        const candidate = hls?.hlsUrl;
        if (!candidate) {
          console.warn(`[CloudHlsProxy][${safeDid}] startHLSStream 未返回 URL attempt=${attempt}`);
          state.lastVerifyReason = 'no_url';
          await sleep(1000);
          continue;
        }
        let ok = false;
        let lastReason = 'unknown';
        for (let i = 0; i < 6; i += 1) {
          const v = await this.verifyCloudUrl(candidate);
          lastReason = v.reason;
          if (v.ok) {
            ok = true;
            console.info(`[CloudHlsProxy][${safeDid}] verify ok try=${i + 1}`);
            break;
          }
          console.warn(`[CloudHlsProxy][${safeDid}] verify try=${i + 1} reason=${v.reason}`);
          // 403/404 = 会话已失效，重试同一候选无意义，直接换候选/判失败
          if (/^(playlist|segment)_http_40[34]$/.test(v.reason)) break;
          await sleep(1000);
        }
        if (ok) {
          cloudUrl = candidate;
          warmed = true;
          break;
        }
        state.lastVerifyReason = lastReason;
        console.warn(`[CloudHlsProxy][${safeDid}] 预热失败 reason=${lastReason} attempt=${attempt}`);
        await sleep(1000);
      }
      if (!warmed || !cloudUrl) {
        throw new Error(`云端 master 预热失败（连续 ${maxAttempts} 次申请均无效）reason=${state.lastVerifyReason}`);
      }
      state.lastCloudUrl = cloudUrl;
      const proc = this.spawnFfmpeg(state);
      if (!proc) throw new Error('ffmpeg 启动失败');
      state.proc = proc;
      this.rescheduleRenew(state);
      console.info(`[CloudHlsProxy][${safeDid}] state=starting->streaming url=${cloudUrl.slice(0, 60)}`);
    } finally {
      this.creating.delete(safeDid);
    }
  }

  /**
   * 后台恢复循环（替代原 scheduleRestart 的"失败即 cleanup 死等浏览器"）：
   * - 触发点：ffmpeg exit / watchdog / ensure() 兜底，与浏览器请求无关
   * - 成功 → 清零退避与失败计数
   * - 失败 → 记录原因 + 连续失败次数，按阶梯退避并继续后台尝试（0/5/10/20/30/60/120s，120s 为上限）
   */
  private scheduleRecovery(state: CloudHlsProxyState, delayMs: number): void {
    const s = this.states.get(state.safeDid);
    if (!s || s !== state || s.stopping) return;
    if (s.recoveryTimer) return;
    if (s.proc && !s.proc.killed) return; // 已在播放
    s.recoveryTimer = setTimeout(async () => {
      s.recoveryTimer = null;
      const cur = this.states.get(state.safeDid);
      if (!cur || cur !== state || cur.stopping) return;
      if (cur.proc && !cur.proc.killed) return;
      const ok = await this.recoverOnce(cur);
      if (ok) {
        cur.recoveryBackoffMs = 0;
        cur.recoveryFailures = 0;
        cur.lastRecoveryReason = '';
        this.failCount.delete(cur.safeDid);
        this.cooldown.delete(cur.safeDid);
        console.info(`[CloudHlsProxy][${cur.safeDid}] state=streaming recovered`);
      } else {
        cur.recoveryFailures += 1;
        cur.lastRecoveryReason = cur.lastVerifyReason || 'start_failed';
        cur.recoveryBackoffMs = this.nextBackoff(cur.recoveryBackoffMs);
        console.warn(
          `[CloudHlsProxy][${cur.safeDid}] recovery attempt=${cur.recoveryFailures} backoff=${cur.recoveryBackoffMs}ms reason=${cur.lastRecoveryReason} nextRetryAt=${new Date(Date.now() + cur.recoveryBackoffMs).toISOString()}`,
        );
        this.scheduleRecovery(cur, cur.recoveryBackoffMs);
      }
    }, delayMs);
  }

  private nextBackoff(current: number): number {
    for (const v of CLOUD_HLS_RECOVERY_BACKOFF_LADDER) {
      if (v > current) return v;
    }
    return CLOUD_HLS_RECOVERY_BACKOFF_LADDER[CLOUD_HLS_RECOVERY_BACKOFF_LADDER.length - 1];
  }

  private async recoverOnce(state: CloudHlsProxyState): Promise<boolean> {
    if (this.starting.has(state.safeDid)) return false; // 已有创建/启动在跑，稍后再试
    const s = this.states.get(state.safeDid);
    if (!s || s !== state || s.stopping) return true; // state 已变化：视为已处理
    if (s.proc && !s.proc.killed) return true; // 已被其它路径恢复
    state.lastVerifyReason = '';
    try {
      // 一轮恢复只申请 1 个候选 URL：避免"一次恢复申请两个 URL"加剧 Xiaomi 限流
      await this.runStart(state.safeDid, state.did, state.scope, state.restarts + 1, 1);
      return true;
    } catch (err: any) {
      const fc = (this.failCount.get(state.safeDid) ?? 0) + 1;
      this.failCount.set(state.safeDid, fc);
      this.cooldown.set(state.safeDid, Date.now());
      console.warn(`[CloudHlsProxy][${state.safeDid}] recoverOnce failed reason=${state.lastVerifyReason || 'start_failed'} err=${err?.message || err}`);
      return false;
    }
  }

  /** start 的统一入口：登记到 starting（prewarm/ensure 据此互斥），保证任何 start 都被其它路径感知 */
  private async runStart(
    safeDid: string,
    did: string,
    scope: 'main' | 'camera',
    restarts: number,
    maxAttempts = 2,
  ): Promise<void> {
    const task = this.start(safeDid, did, scope, restarts, maxAttempts);
    this.starting.set(safeDid, task);
    try {
      await task;
    } finally {
      if (this.starting.get(safeDid) === task) this.starting.delete(safeDid);
    }
  }

  // 用 state.lastCloudUrl 启动 ffmpeg，重切云端 HLS 为本地稳定流。
  // 退出时区分「临时网络断连」与「会话失效」：
  // - 临时断连（chunklist EOF / ECONNRESET / TLS reset）：复用同一 URL，退避后受控恢复
  // - 会话失效（403/404 / 正常到期）：优先切新鲜 pending，否则进入后台恢复循环
  private spawnFfmpeg(
    state: CloudHlsProxyState,
  ): ChildProcessByStdio<null, NodeReadable, NodeReadable> | null {
    const { safeDid, outDir, lastCloudUrl } = state;
    const hlsOutFile = path.join(outDir, 'stream.m3u8');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* noop */ }
    // 注意：不再在此清空目录。新流 ready 之前保留旧 m3u8/ts，
    // 新流产出后由看门狗调用 pruneStaleHlsSegments 清理孤儿分片。
    if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
    if (state.renewTimer) { clearTimeout(state.renewTimer); state.renewTimer = null; }

    const ffmpegArgs = [
      ...this.deps.buildInputArgs(lastCloudUrl),
      '-an',
      '-c:v', 'copy',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '8',
      '-hls_flags', 'delete_segments+append_list+independent_segments',
      '-hls_allow_cache', '0',
      '-y',
      hlsOutFile,
    ];
    let spawned: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null = null;
    try {
      spawned = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }) as unknown as ChildProcessByStdio<null, NodeReadable, NodeReadable>;
    } catch (err: any) {
      console.warn(`[CloudHlsProxy][${safeDid}] ffmpeg spawn failed err=${err?.message || err}`);
      return null;
    }
    if (!spawned) return null;
    const proc = spawned;
    let stderrBuf = '';
    proc.stderr.on('data', (chunk: unknown) => {
      const text = String(chunk || '');
      stderrBuf += text;
      if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000);
      for (const line of text.split(/\r?\n/)) {
        if (/error|failed|404|403|tls|reconnect|retrying|server returned|chunklist/i.test(line)) {
          console.warn(`[CloudHlsProxy][${safeDid}] ffmpeg: ${line.trim().slice(0, 220)}`);
        }
      }
    });
    proc.stdout.on('data', () => { /* consume */ });
    state.startedAt = Date.now();
    state.prewarmFailures = 0;

    proc.on('exit', (code, signal) => {
      // 分类 ffmpeg 退出原因：403/404=会话失效；EOF/TCP/TLS=临时断连；其余=未知
      const exitReason = /HTTP error 403|403 Forbidden/i.test(stderrBuf)
        ? 'cloud_hls_403'
        : /HTTP error 404|404 Not Found/i.test(stderrBuf)
          ? 'cloud_hls_404'
          : /HTTP error 401|401 Unauthorized/i.test(stderrBuf)
            ? 'cloud_hls_401'
            : this.isTemporaryDisconnect(stderrBuf)
              ? 'temporary_disconnect'
              : /session.*(?:expired|invalid)|stream.*expired/i.test(stderrBuf)
                ? 'session_invalid'
                : 'exit_unknown';
      console.warn(`[CloudHlsProxy][${safeDid}] current exited code=${code} signal=${signal} reason=${exitReason}`);
      try {
        fs.writeFileSync(path.join(outDir, 'ffmpeg-cloudhls.log'), stderrBuf || '(empty)', 'utf8');
      } catch { /* noop */ }
      const s = this.states.get(safeDid);
      if (!s || s !== state || s.stopping) return;
      // 已被新进程替换 → 旧进程退出不处理（防止旧 exit 回调清掉/重启新流）
      if (s.proc && s.proc !== proc) return;
      s.proc = null;
      if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }

      // 临时网络断连（chunklist EOF / ECONNRESET / TLS reset）：复用同一 URL 受控恢复，
      // 不重新申请云端会话（申请大概率拿到无效 URL，且高频申请会触发限流）。
      if (this.isTemporaryDisconnect(stderrBuf)) {
        if (s.recoverAttempts < CLOUD_HLS_MAX_RECOVER) {
          s.recoverAttempts += 1;
          console.warn(`[CloudHlsProxy][${safeDid}] temporary disconnect -> recover same URL attempt=${s.recoverAttempts}`);
          s.restartTimer = setTimeout(() => {
            s.restartTimer = null;
            const cur = this.states.get(safeDid);
            if (!cur || cur !== state || cur.stopping) return;
            if (this.starting.has(safeDid)) return;
            if (cur.proc && !cur.proc.killed) return;
            const nproc = this.spawnFfmpeg(cur);
            if (nproc) {
              cur.proc = nproc;
              this.rescheduleRenew(cur);
              console.info(`[CloudHlsProxy][${safeDid}] stream recovered (same URL) attempt=${cur.recoverAttempts}`);
            } else {
              console.warn(`[CloudHlsProxy][${safeDid}] same-URL recover spawn failed -> background recovery`);
              cur.recoverAttempts = 0;
              this.scheduleRecovery(cur, 0);
            }
          }, CLOUD_HLS_RECOVER_BACKOFF_MS);
          return;
        }
        console.warn(`[CloudHlsProxy][${safeDid}] temporary recover exhausted -> background recovery`);
        s.recoverAttempts = 0;
        this.scheduleRecovery(s, 0);
        return;
      }

      // 会话失效（403/404/session expired）：优先切新鲜 pending（立即、零空窗）
      if (s.pendingUrl && s.pendingCreatedAt) {
        const pendingAge = Date.now() - s.pendingCreatedAt;
        if (pendingAge < CLOUD_HLS_PENDING_MAX_AGE_MS) {
          const nextUrl = s.pendingUrl;
          s.pendingUrl = null;
          s.pendingCreatedAt = 0;
          s.lastCloudUrl = nextUrl;
          s.recoverAttempts = 0;
          s.recoveryBackoffMs = 0;
          console.info(`[CloudHlsProxy][${safeDid}] current exited -> pending promoted pendingAge=${(pendingAge / 1000).toFixed(1)}s`);
          const nproc = this.spawnFfmpeg(s);
          if (nproc) {
            s.proc = nproc;
            this.rescheduleRenew(s);
            console.info(`[CloudHlsProxy][${safeDid}] state=streaming (via pending)`);
            return;
          }
          console.warn(`[CloudHlsProxy][${safeDid}] pending switch spawn failed -> background recovery`);
        } else {
          console.warn(`[CloudHlsProxy][${safeDid}] pending stale age=${(pendingAge / 1000).toFixed(1)}s discard -> background recovery`);
          s.pendingUrl = null;
          s.pendingCreatedAt = 0;
        }
      } else {
        console.warn(`[CloudHlsProxy][${safeDid}] current exited reason=session_invalid pending=none -> background recovery`);
      }
      s.recoverAttempts = 0;
      this.scheduleRecovery(s, 0);
    });

    // 停滞看门狗：5s 检查一次。
    // - 已出流：playlist 或最新分片超过阈值未更新才判定停滞
    // - 未出流：给 25s 首片宽限
    state.watchdog = setInterval(() => {
      const s = this.states.get(safeDid);
      if (!s || s !== state || s.stopping) return;
      if (s.proc && s.proc !== proc) return; // 已被新进程替换
      let hasM3u8 = false;
      try {
        if (fs.existsSync(hlsOutFile) && fs.statSync(hlsOutFile).size > 0) hasM3u8 = true;
      } catch { /* noop */ }
      if (hasM3u8) {
        try {
          if (Date.now() - fs.statSync(hlsOutFile).mtimeMs < CLOUD_HLS_STALL_PLAYLIST_MS) {
            const tsAge = latestReferencedSegmentAgeMs(outDir, hlsOutFile);
            if (tsAge < CLOUD_HLS_STALL_TS_MS) {
              pruneStaleHlsSegments(outDir, hlsOutFile);
              return;
            }
            if (Date.now() - state.startedAt < CLOUD_HLS_FIRST_SEGMENT_GRACE_MS) return; // 首片宽限
          }
        } catch { return; }
      } else if (Date.now() - state.startedAt < CLOUD_HLS_FIRST_SEGMENT_GRACE_MS) {
        return; // 首片宽限
      }
      console.warn(`[CloudHlsProxy][${safeDid}] stalled hasM3u8=${hasM3u8} -> kill ffmpeg (exit 后走恢复)`);
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 5000);

    return proc;
  }

  /**
   * streaming 期间周期触发 prewarm，保持 pending 新鲜（≤ RENEW_MS）。
   * - 已有新鲜 pending → 不重建（只保持周期）
   * - pending 过期 → 丢弃重建
   * - 失败 → 受限重试（不无限申请）
   * 只有当流仍在播（proc alive）时才保持周期；流退出后交给恢复循环。
   */
  private rescheduleRenew(state: CloudHlsProxyState): void {
    const s = this.states.get(state.safeDid);
    if (!s || s !== state || s.stopping) return;
    if (!s.proc || s.proc.killed) return; // 流已不在播，交给恢复循环
    // 不再排定预热定时器：出流期间完全不申请/切换会话，断流后由 exit/watchdog 走恢复循环申请。
    // 原因：12s 周期预热 → 高频 startHLSStream → 触发小米 CDN/账号限流 → 新会话被间歇性拒绝，
    // 导致"能播一会→断→新会话申请被拒→恢复失败"的循环。停用预热后申请频率大幅降低，限流可自然解除。
    if (s.renewTimer) { clearTimeout(s.renewTimer); s.renewTimer = null; }
  }

  // 提前申请并预热下一个云端会话 URL（供会话到期时无缝切换）。
  // - streaming 期间申请频率 ≈ 每 12s 一次（仅当没有新鲜 pending 时才会真正申请）
  // - 预热失败不影响当前流；受限重试（间隔 8s、最多 3 次）
  private async prewarm(state: CloudHlsProxyState): Promise<void> {
    const cur = this.states.get(state.safeDid);
    if (!cur || cur !== state || cur.stopping) return;
    if (this.starting.has(state.safeDid)) return; // 重建中不抢申请
    if (cur.prewarmFailures >= CLOUD_HLS_PREWARM_MAX_FAILURES) return;
    if (this.creating.has(state.safeDid)) return; // 已有创建过程在跑

    // 已有新鲜 pending → 无需重建，仅保持周期；过期 pending → 丢弃后重建
    if (cur.pendingUrl && cur.pendingCreatedAt) {
      if (Date.now() - cur.pendingCreatedAt < CLOUD_HLS_PENDING_MAX_AGE_MS) {
        this.rescheduleRenew(state);
        return;
      }
      console.warn(`[CloudHlsProxy][${state.safeDid}] pending stale, refresh`);
      cur.pendingUrl = null;
      cur.pendingCreatedAt = 0;
    }

    this.creating.add(state.safeDid);
    let cloudUrl = '';
    try {
      try {
        const hls = await xiaomiAdapter.startHLSStream(state.did, state.scope);
        cloudUrl = hls?.hlsUrl ?? '';
        if (!cloudUrl) {
          console.warn(`[CloudHlsProxy][${state.safeDid}] prewarm no URL from startHLSStream`);
        }
      } catch (e: any) {
        console.warn(`[CloudHlsProxy][${state.safeDid}] prewarm startHLSStream error ${(e?.message || e)?.toString().slice(0, 120)}`);
      }
      if (cloudUrl) {
        let warmed = false;
        for (let i = 0; i < 6 && !warmed; i += 1) {
          const v = await this.verifyCloudUrl(cloudUrl);
          if (v.ok) warmed = true;
          else {
            // 403/404 已判死，重试同一候选无意义
            if (/^(playlist|segment)_http_40[34]$/.test(v.reason)) break;
            await sleep(1000);
          }
        }
        const now = this.states.get(state.safeDid);
        if (now && now === state && !now.stopping && warmed) {
          now.pendingUrl = cloudUrl;
          now.pendingCreatedAt = Date.now();
          now.prewarmFailures = 0;
          console.info(`[CloudHlsProxy][${state.safeDid}] pending ready url=${cloudUrl.slice(0, 60)}`);
          this.rescheduleRenew(state);
          return;
        }
      }
    } finally {
      this.creating.delete(state.safeDid);
    }

    // 预热失败：受限重试 + 保持周期
    const now = this.states.get(state.safeDid);
    if (!now || now !== state || now.stopping) return;
    if (!now.pendingUrl) now.prewarmFailures += 1;
    if (now.prewarmFailures >= CLOUD_HLS_PREWARM_MAX_FAILURES) {
      console.warn(`[CloudHlsProxy][${state.safeDid}] prewarm give up failures=${now.prewarmFailures}`);
      this.rescheduleRenew(state);
      return;
    }
    if (now.renewTimer) clearTimeout(now.renewTimer);
    now.renewTimer = setTimeout(() => {
      now.renewTimer = null;
      void this.prewarm(state);
    }, CLOUD_HLS_PREWARM_RETRY_MS);
  }

  /**
   * 验证云端 HLS URL 真实可用：playlist 200 且含 EXT 标签，且至少能成功拉取 1 个分片。
   * 返回原因，区分：
   *   - playlist_http_403/404 / segment_http_403/404：会话已失效（判死，不重试同一候选）
   *   - session_not_ready：HTTP 200 但暂无可分片（预热窗口内重试，不判死）
   *   - timeout / dns_failure / network_failure / network_temporary_failure：网络临时故障（可重试）
   */
  private async verifyCloudUrl(url: string): Promise<{ ok: boolean; reason: string }> {
    const fetchPlaylist = async (u: string): Promise<{ body: string | null; reason: string }> => {
      try {
        const resp = await axios.get(u, { timeout: 5000, maxRedirects: 5, validateStatus: () => true });
        const body = String(resp.data || '');
        if (resp.status === 200 && body.indexOf('#EXT') >= 0) return { body, reason: 'ok' };
        if (resp.status === 200) return { body: null, reason: 'session_not_ready' };
        if (resp.status === 403 || resp.status === 404) return { body: null, reason: `playlist_http_${resp.status}` };
        return { body: null, reason: `playlist_http_${resp.status}` };
      } catch (e: any) {
        const msg = String(e?.message || '');
        let reason = 'network_temporary_failure';
        if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) reason = 'dns_failure';
        else if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(msg)) reason = 'timeout';
        else if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(msg)) reason = 'network_failure';
        return { body: null, reason };
      }
    };
    const pickSegments = (body: string): string[] =>
      body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && /\.(ts|m4s|mp4)$/i.test(l));
    const fetchSegment = async (seg: string, base: string): Promise<string> => {
      const segUrl = /^https?:\/\//i.test(seg) ? seg : new URL(seg, base).toString();
      try {
        const r = await axios.get(segUrl, { timeout: 5000, maxRedirects: 5, validateStatus: () => true });
        if (r.status === 200) return 'ok';
        if (r.status === 403 || r.status === 404) return `segment_http_${r.status}`;
        return `segment_http_${r.status}`;
      } catch (e: any) {
        const msg = String(e?.message || '');
        if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(msg)) return 'segment_timeout';
        return 'segment_fetch_error';
      }
    };

    let r = await fetchPlaylist(url);
    if (r.reason !== 'ok') return { ok: false, reason: r.reason };
    let body = r.body ?? '';
    let segs = pickSegments(body);
    if (segs.length === 0) {
      const sub = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#') && /\.m3u8$/i.test(l));
      if (sub) {
        const subUrl = /^https?:\/\//i.test(sub) ? sub : new URL(sub, url).toString();
        r = await fetchPlaylist(subUrl);
        if (r.reason !== 'ok') return { ok: false, reason: r.reason };
        body = r.body ?? '';
        segs = pickSegments(body);
      }
    }
    if (segs.length === 0) return { ok: false, reason: 'session_not_ready' }; // 结构上暂无可分片
    for (const seg of segs.slice(0, 3)) {
      const sr = await fetchSegment(seg, url);
      if (sr === 'ok') return { ok: true, reason: 'ok' };
      if (sr === 'segment_http_403' || sr === 'segment_http_404') return { ok: false, reason: sr };
    }
    return { ok: false, reason: 'segment_failed' };
  }

  // 将验证原因映射为用户可读文案（用于 ensure() 返回与日志）
  private reasonText(reason: string): string {
    switch (reason) {
      case 'playlist_http_403': return '云端 HLS 返回 HTTP 403';
      case 'playlist_http_404': return '云端 HLS 返回 HTTP 404';
      case 'segment_http_403': return 'HLS 分片返回 HTTP 403';
      case 'segment_http_404': return 'HLS 分片返回 HTTP 404';
      case 'session_not_ready': return '会话尚未就绪';
      case 'timeout': return '请求超时';
      case 'dns_failure': return 'DNS 解析失败';
      case 'network_failure': return '网络连接失败';
      case 'no_url': return '云端未返回 HLS 地址';
      default: return reason;
    }
  }

  // 判断 ffmpeg stderr 是否为「临时网络/HLS 断连」：
  // - 明确 401/403/404、会话过期/失效 属于会话失效，不判为临时断连
  // - EOF / ECONNRESET / TLS reset / parse_playlist / socket hang up / -10054 等视为临时断连
  private isTemporaryDisconnect(stderr: string): boolean {
    if (/HTTP error 40[134]|404 Not Found|403 Forbidden|401 Unauthorized|server returned 40[134]|session.*(?:expired|invalid)|playlist.*expired|stream.*expired/i.test(stderr)) {
      return false;
    }
    return /end of file|10054|econnreset|connection.*reset|socket hang|parse_playlist|i\/o error|io error|error reading http|timed out|timeout|tls.*error|tcp.*failed/i.test(stderr);
  }
}
