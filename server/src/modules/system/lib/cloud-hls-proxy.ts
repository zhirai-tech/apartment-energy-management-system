import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { spawn, ChildProcessByStdio } from 'child_process';
import { Readable as NodeReadable } from 'stream';
import { xiaomiAdapter } from '../xiaomi.adapter';

// 云端 HLS 本地代理的进程状态（自动续流）
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
  /** 当前 HLS URL 因临时网络断连（chunklist EOF/ECONNRESET/TLS reset）已连续恢复的次数 */
  recoverAttempts: number;
  /** 提前预热好的下一个云端会话 URL（会话到期时无缝切换，避免重建空窗） */
  pendingUrl: string | null;
  /** 提前续流定时器 */
  renewTimer: NodeJS.Timeout | null;
}

/** CloudHlsProxyManager 对宿主 SystemService 的最小依赖集 */
export interface CloudHlsProxyDeps {
  getHlsDir(did: string): string;
  isHlsReady(out: string, maxAgeMs?: number): boolean;
  waitForHlsReadyOrExit(did: string, timeoutMs?: number): Promise<boolean>;
  buildInputArgs(url: string): string[];
}

// 分级冷却 / 断连恢复 / 提前续流参数
const CLOUD_HLS_MAX_RECOVER = 3;
const CLOUD_HLS_RECOVER_BACKOFF_MS = 3000;
const CLOUD_HLS_RENEW_MS = 70_000;
const CLOUD_HLS_COOLDOWN_BASE_MS = 20_000;
const CLOUD_HLS_COOLDOWN_MAX_MS = 120_000;
const CLOUD_HLS_FAIL_LIMIT = 5;

// 云端 HLS 本地代理（自动续流）：
// 服务端用 ffmpeg 持续拉取小米云端 HLS 并重切为本地 HLS（streams/hls/<did>/stream.m3u8）。
// 云端会话因 CDN 间歇性失效/URL 时效而中断时，自动重建云端会话并重启 ffmpeg，
// 浏览器只连本地稳定流，避免被云端 URL 间歇 404/时效问题反复打断。
export class CloudHlsProxyManager {
  private states = new Map<string, CloudHlsProxyState>();

  // 启动中的代理（避免前端重连与内部重启并发触发多次 startHLSStream）
  private starting = new Map<string, Promise<void>>();

  // 代理放弃后的冷却时间戳（避免高频重试触发小米云端限流）
  private cooldown = new Map<string, number>();

  // 连续启动失败计数（用于分级冷却判定）
  private failCount = new Map<string, number>();

  constructor(private readonly deps: CloudHlsProxyDeps) {}

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
    // 并发去重：已有启动任务在跑则等待，避免前端重连与内部重启重复建会话
    const inFlight = this.starting.get(safeDid);
    if (inFlight) {
      try { await inFlight; } catch { /* noop */ }
      const st = this.states.get(safeDid);
      if (st && st.proc && !st.proc.killed) {
        return { hlsUrl, hlsReady: this.deps.isHlsReady(hlsOutFile), proxyMode: 'cloud-hls-proxy' };
      }
      return { hlsUrl, hlsReady: false, proxyMode: 'none', errorMessage: '云端 HLS 会话启动中，请稍候' };
    }
    // 代理 state 存在但进程已死：
    // 若有重启排程则由本次请求直接接管（清掉排程，避免 5s 后并发再起），
    // 随后清理陈旧 state，进入下方正常启动逻辑。
    if (existing) {
      if (existing.restartTimer) {
        clearTimeout(existing.restartTimer);
        existing.restartTimer = null;
      }
      this.cleanup(safeDid);
    }
    // 分级冷却：普通失败短冷却（20s）重试——云端 startHLSStream 是概率性有效，
    // 多试几次大概率拿到有效 URL；连续失败达上限才长冷却（120s）防限流。
    // 仍返回本地 hlsUrl（hlsReady=false），前端据此周期重试自愈，而不是返回空让其放弃。
    const cool = this.cooldown.get(safeDid);
    if (cool) {
      const failCount = this.failCount.get(safeDid) ?? 0;
      const coolMs = failCount >= CLOUD_HLS_FAIL_LIMIT
        ? CLOUD_HLS_COOLDOWN_MAX_MS
        : CLOUD_HLS_COOLDOWN_BASE_MS;
      const remainMs = coolMs - (Date.now() - cool);
      if (remainMs > 0) {
        const leftSec = Math.ceil(remainMs / 1000);
        console.info(`[CloudHlsProxy] cooldown did=${safeDid} failCount=${failCount} left=${leftSec}s`);
        return {
          hlsUrl,
          hlsReady: false,
          proxyMode: 'none',
          errorMessage: `云端 HLS 会话冷却中（约 ${leftSec}s 后自动重试）`,
        };
      }
      // 冷却已过期：清除旧冷却标记，走下方正常启动
      this.cooldown.delete(safeDid);
    }
    const startTask = this.start(safeDid, did, scope, 0);
    this.starting.set(safeDid, startTask);
    try {
      await startTask;
    } catch (err: any) {
      console.warn('[CloudHlsProxy] start failed did=', safeDid, 'err=', err?.message || err);
      // 启动失败：累加失败计数，进入冷却（短冷却让概率性有效的重试尽快发生）
      const fc = (this.failCount.get(safeDid) ?? 0) + 1;
      this.failCount.set(safeDid, fc);
      this.cooldown.set(safeDid, Date.now());
      return {
        hlsUrl,
        hlsReady: false,
        proxyMode: 'none',
        errorMessage: '云端 HLS 会话启动失败，冷却中',
      };
    } finally {
      this.starting.delete(safeDid);
    }
    const ready = await this.deps.waitForHlsReadyOrExit(safeDid, 12000);
    if (ready) {
      // 出流成功：清零失败计数，让下次失败重新按短冷却走
      this.failCount.delete(safeDid);
    }
    return { hlsUrl, hlsReady: ready, proxyMode: 'cloud-hls-proxy' };
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
    if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
    if (state.proc && !state.proc.killed) { try { state.proc.kill('SIGKILL'); } catch { /* noop */ } }
    this.states.delete(safeDid);
  }

  private async start(
    safeDid: string,
    did: string,
    scope: 'main' | 'camera',
    restarts: number,
  ): Promise<void> {
    const prev = this.states.get(safeDid);
    if (prev) {
      prev.stopping = true;
      if (prev.restartTimer) { clearTimeout(prev.restartTimer); prev.restartTimer = null; }
      if (prev.renewTimer) { clearTimeout(prev.renewTimer); prev.renewTimer = null; }
      if (prev.watchdog) { clearInterval(prev.watchdog); prev.watchdog = null; }
      if (prev.proc && !prev.proc.killed) { try { prev.proc.kill('SIGKILL'); } catch { /* noop */ } }
      this.states.delete(safeDid);
    }

    const outDir = this.deps.getHlsDir(safeDid);
    const hlsOutFile = path.join(outDir, 'stream.m3u8');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* noop */ }
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (/\.(m3u8|ts)$/i.test(f)) {
          try { fs.unlinkSync(path.join(outDir, f)); } catch { /* noop */ }
        }
      }
    } catch { /* noop */ }

    // 云端 startHLSStream 概率性返回无效 URL（实测约 1/4 有效）。
    // 单次启动尝试内最多重试申请 4 次，命中有效 URL 即继续，全部失败才抛错进冷却，
    // 把"一次启动尝试"的可用率从 ~25% 提升到 ~68%，减少无谓的冷却空窗。
    let cloudUrl = '';
    let warmed = false;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // 强制新建云端会话（不读缓存），避免拿到已失效的 URL
      const hls = await xiaomiAdapter.startHLSStream(did, scope);
      const candidate = hls?.hlsUrl;
      if (!candidate) {
        console.warn(`[CloudHlsProxy] startHLSStream 未返回 URL did=${safeDid} attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // 预热确认：轮询云端 master playlist 直到可访问（200 且含 EXT 标签），
      // 避免用"刚创建尚未就绪 / 间歇 404"的 URL 直接启动 ffmpeg（否则 ffmpeg 秒退）。
      let ok = false;
      for (let i = 0; i < 6; i += 1) {
        try {
          const resp = await axios.get(candidate, { timeout: 4000, maxRedirects: 5, validateStatus: () => true });
          const body = String(resp.data || '');
          if (resp.status === 200 && body.indexOf('#EXT') >= 0) {
            ok = true;
            console.info(`[CloudHlsProxy] preheat ok did=${safeDid} attempt=${attempt} try=${i + 1} status=200 size=${body.length}`);
            break;
          }
          console.warn(`[CloudHlsProxy] preheat try=${i + 1} did=${safeDid} status=${resp.status} size=${body.length}`);
        } catch (e: any) {
          console.warn(`[CloudHlsProxy] preheat try=${i + 1} did=${safeDid} err=${(e?.message || e)?.toString().slice(0, 120)}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (ok) {
        cloudUrl = candidate;
        warmed = true;
        break;
      }
      console.warn(`[CloudHlsProxy] 预热失败，重试申请新 URL did=${safeDid} attempt=${attempt}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!warmed || !cloudUrl) {
      throw new Error(`云端 master 预热失败（连续 4 次申请均无效）：${cloudUrl?.slice(0, 90) || 'no url'}`);
    }
    console.info(`[CloudHlsProxy] warmed did=${safeDid} url=${cloudUrl.slice(0, 90)}`);

    const state: CloudHlsProxyState = {
      proc: null,
      safeDid,
      did,
      scope,
      outDir,
      startedAt: Date.now(),
      stopping: false,
      restartTimer: null,
      watchdog: null,
      lastCloudUrl: cloudUrl,
      restarts,
      recoverAttempts: 0,
      pendingUrl: null,
      renewTimer: null,
    };
    this.states.set(safeDid, state);

    const proc = this.spawnFfmpeg(state);
    if (!proc) {
      this.states.delete(safeDid);
      throw new Error('ffmpeg 启动失败');
    }
    state.proc = proc;
  }

  // 用 state.lastCloudUrl 启动 ffmpeg，重切云端 HLS 为本地稳定流。
  // 退出时区分「临时网络断连」与「会话失效」：
  // - 临时断连（chunklist EOF / ECONNRESET / TLS reset）：复用同一 URL，退避后受控恢复
  // - 会话失效（404/403 / 正常到期）：走现有 scheduleRestart 重建会话
  private spawnFfmpeg(
    state: CloudHlsProxyState,
  ): ChildProcessByStdio<null, NodeReadable, NodeReadable> | null {
    const { safeDid, outDir, lastCloudUrl } = state;
    const hlsOutFile = path.join(outDir, 'stream.m3u8');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* noop */ }
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (/\.(m3u8|ts)$/i.test(f)) {
          try { fs.unlinkSync(path.join(outDir, f)); } catch { /* noop */ }
        }
      }
    } catch { /* noop */ }

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
    // 直接用 spawn 并完整落盘 stderr，便于定位云端拉流失败的具体原因
    let spawned: ChildProcessByStdio<null, NodeReadable, NodeReadable> | null = null;
    try {
      spawned = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }) as unknown as ChildProcessByStdio<null, NodeReadable, NodeReadable>;
    } catch (err: any) {
      console.warn(`[CloudHlsProxy] ffmpeg spawn failed did=${safeDid} err=${err?.message || err}`);
      return null;
    }
    if (!spawned) return null;
    const proc = spawned;
    let stderrBuf = '';
    proc.stderr.on('data', (chunk: unknown) => {
      const text = String(chunk || '');
      stderrBuf += text;
      if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000);
      // 关键错误行实时打印
      for (const line of text.split(/\r?\n/)) {
        if (/error|failed|404|403|tls|reconnect|retrying|server returned|chunklist/i.test(line)) {
          console.warn(`[CloudHlsProxy] ffmpeg did=${safeDid}: ${line.trim().slice(0, 220)}`);
        }
      }
    });
    proc.stdout.on('data', () => { /* consume */ });
    state.startedAt = Date.now();

    proc.on('exit', (code, signal) => {
      console.warn(`[CloudHlsProxy] ffmpeg exit did=${safeDid} code=${code} signal=${signal}`);
      try {
        fs.writeFileSync(path.join(outDir, 'ffmpeg-cloudhls.log'), stderrBuf || '(empty)', 'utf8');
      } catch { /* noop */ }
      const s = this.states.get(safeDid);
      if (!s || s !== state || s.stopping) return;
      s.proc = null;
      if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }

      // 临时网络断连（chunklist EOF / ECONNRESET / TLS reset）：复用同一 URL 受控恢复，
      // 不重新申请云端会话（申请大概率拿到无效 URL，且高频申请会触发限流）。
      if (this.isTemporaryDisconnect(stderrBuf)) {
        if (s.recoverAttempts < CLOUD_HLS_MAX_RECOVER) {
          s.recoverAttempts += 1;
          console.warn(
            `[CloudHlsProxy] temporary disconnect detected did=${safeDid} attempt=${s.recoverAttempts} -> recovering HLS input with same URL`,
          );
          s.restartTimer = setTimeout(() => {
            s.restartTimer = null;
            const cur = this.states.get(safeDid);
            if (!cur || cur !== state || cur.stopping) return;
            if (this.starting.has(safeDid)) {
              console.info(`[CloudHlsProxy] skip recover (in-flight) did=${safeDid}`);
              return;
            }
            const nproc = this.spawnFfmpeg(cur);
            if (nproc) {
              cur.proc = nproc;
              console.info(`[CloudHlsProxy] stream recovered did=${safeDid} attempt=${cur.recoverAttempts}`);
            } else {
              console.warn(`[CloudHlsProxy] recovery failed did=${safeDid} (ffmpeg spawn) -> session restart`);
              cur.recoverAttempts = 0;
              this.scheduleRestart(cur);
            }
          }, CLOUD_HLS_RECOVER_BACKOFF_MS);
          return;
        }
        console.warn(`[CloudHlsProxy] recovery failed did=${safeDid} (reached max attempts) -> session restart`);
        s.recoverAttempts = 0;
        this.scheduleRestart(s);
        return;
      }

      // 会话到期/失效：优先用提前预热好的 pendingUrl 无缝切换，
      // 直接复用已就绪的 URL 重启 ffmpeg，跳过「重新申请 + 预热」的空窗（约 10s+）。
      if (s.pendingUrl) {
        const nextUrl = s.pendingUrl;
        s.pendingUrl = null;
        s.lastCloudUrl = nextUrl;
        s.recoverAttempts = 0;
        console.info(`[CloudHlsProxy] session expired, switching to prewarmed URL did=${safeDid}`);
        const nproc = this.spawnFfmpeg(s);
        if (nproc) {
          s.proc = nproc;
          console.info(`[CloudHlsProxy] stream recovered via prewarmed session did=${safeDid}`);
          return;
        }
        console.warn(`[CloudHlsProxy] prewarmed switch failed did=${safeDid} -> session restart`);
      }

      s.recoverAttempts = 0;
      this.scheduleRestart(s);
    });

    // 停滞看门狗：5s 检查一次。
    // - 已出流：stream.m3u8 15s 未更新才判定停滞
    // - 未出流：给 25s 首片时间（ffmpeg 打开云端流→下载 ts→等关键帧→切首片需要时间），
    //   超时仍无 m3u8 才强制重启，避免把"正常慢启动"误判为停滞
    state.watchdog = setInterval(() => {
      const s = this.states.get(safeDid);
      if (!s || s !== state || s.stopping) return;
      let hasM3u8 = false;
      try {
        if (fs.existsSync(hlsOutFile) && fs.statSync(hlsOutFile).size > 0) hasM3u8 = true;
      } catch { /* noop */ }
      if (hasM3u8) {
        try {
          if (Date.now() - fs.statSync(hlsOutFile).mtimeMs < 15000) return;
        } catch { return; }
      } else if (Date.now() - state.startedAt < 25000) {
        return;
      }
      console.warn(`[CloudHlsProxy] stalled did=${safeDid} hasM3u8=${hasM3u8} -> restart`);
      try { state.proc?.kill('SIGKILL'); } catch { /* noop */ }
    }, 5000);

    // 提前续流：出流后 CLOUD_HLS_RENEW_MS 申请下一个云端会话 URL 并预热，
    // 当前会话到期时直接用预热好的 URL 无缝切换，避免重新申请造成的长时间黑屏。
    if (state.renewTimer) { clearTimeout(state.renewTimer); state.renewTimer = null; }
    state.renewTimer = setTimeout(() => {
      state.renewTimer = null;
      void this.prewarm(state);
    }, CLOUD_HLS_RENEW_MS);

    return proc;
  }

  // 提前申请并预热下一个云端会话 URL（供会话到期时无缝切换）。
  // - 申请频率 ≈ 每 2 分钟 1 次，远低于小米限流阈值
  // - 预热失败不影响当前流，仅不设 pendingUrl，到期时走原有重建流程
  private async prewarm(state: CloudHlsProxyState): Promise<void> {
    const cur = this.states.get(state.safeDid);
    if (!cur || cur !== state || cur.stopping) return;
    if (cur.pendingUrl) return; // 已有预热好的备用 URL
    if (this.starting.has(state.safeDid)) return; // 重建中不抢申请
    try {
      const hls = await xiaomiAdapter.startHLSStream(state.did, state.scope);
      const cloudUrl = hls?.hlsUrl;
      if (!cloudUrl) {
        console.warn(`[CloudHlsProxy] prewarm failed did=${state.safeDid} (no URL from startHLSStream)`);
        return;
      }
      // 预热确认（与正式启动一致：master 200 且含 EXT 标签）
      let warmed = false;
      for (let i = 0; i < 6; i += 1) {
        try {
          const resp = await axios.get(cloudUrl, { timeout: 4000, maxRedirects: 5, validateStatus: () => true });
          if (resp.status === 200 && String(resp.data || '').indexOf('#EXT') >= 0) {
            warmed = true;
            break;
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      const now = this.states.get(state.safeDid);
      if (!now || now !== state || now.stopping) return;
      if (warmed) {
        now.pendingUrl = cloudUrl;
        console.info(`[CloudHlsProxy] prewarmed next session did=${state.safeDid} url=${cloudUrl.slice(0, 90)}`);
      } else {
        console.warn(`[CloudHlsProxy] prewarm next session failed did=${state.safeDid} (master not reachable)`);
      }
    } catch (e: any) {
      console.warn(`[CloudHlsProxy] prewarm next session error did=${state.safeDid} err=${(e?.message || e)?.toString().slice(0, 140)}`);
    }
  }

  // 判断 ffmpeg stderr 是否为「临时网络/HLS 断连」：
  // - 明确 404/403 属于会话失效，不判为临时断连（由现有重建流程处理）
  // - EOF / ECONNRESET / TLS reset / parse_playlist / socket hang up / -10054 等视为临时断连
  private isTemporaryDisconnect(stderr: string): boolean {
    if (/HTTP error 40[34]|404 Not Found|403 Forbidden|server returned 40[34]/i.test(stderr)) {
      return false;
    }
    return /end of file|10054|econnreset|connection.*reset|socket hang|parse_playlist|i\/o error|io error|error reading http|timed out|timeout|tls.*error|tcp.*failed/i.test(stderr);
  }

  private scheduleRestart(state: CloudHlsProxyState): void {
    const s = this.states.get(state.safeDid);
    if (!s || s !== state || s.stopping) return;
    if (state.restartTimer) return;
    // 正常会话到期（存活 ≥ 60s，云 CDN 约 2 分钟强制断流）不属于失败，
    // 不进入冷却，5s 后自动续建新会话继续播流。
    // 仅当 start 实际启动失败时才走冷却（由调用方处理），
    // 避免"每 2 分钟正常断流 → 重试 3 次 → 永久冷却"把画面彻底掐死。
    state.restartTimer = setTimeout(async () => {
      state.restartTimer = null;
      const cur = this.states.get(state.safeDid);
      if (!cur || cur !== state || cur.stopping) return;
      // 已有启动任务在跑（前端触发）则跳过本次重启，避免并发重复建会话
      if (this.starting.has(state.safeDid)) {
        console.info(`[CloudHlsProxy] skip restart (in-flight) did=${state.safeDid}`);
        return;
      }
      cur.restarts += 1;
      try {
        await this.start(state.safeDid, state.did, state.scope, cur.restarts);
        this.failCount.delete(state.safeDid);
        console.info(`[CloudHlsProxy] restarted did=${state.safeDid} attempt=${cur.restarts}`);
      } catch (err: any) {
        console.warn(`[CloudHlsProxy] restart failed did=${state.safeDid} err=${err?.message || err}`);
        // 重启失败：累加失败计数，进入分级冷却（普通失败短冷却，连续失败长冷却）
        const fc = (this.failCount.get(state.safeDid) ?? 0) + 1;
        this.failCount.set(state.safeDid, fc);
        this.cooldown.set(state.safeDid, Date.now());
        this.cleanup(state.safeDid);
      }
    }, 5000);
  }
}
