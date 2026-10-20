import { useEffect, useRef } from 'react';

/**
 * 挂载 HLS 直播流到 <video>。
 * - 原生支持 m3u8 的浏览器（Safari）直接赋值 src
 * - 其余走 hls.js（懒加载，与项目既有用法一致）
 * - url 变化或卸载时自动销毁旧实例
 * - opts.epoch：bump 后即使 url 不变也强制重建播放器（用于流恢复后 reload）
 * - opts.onFatalError：hls.js fatal 错误时回调（页面据此受控恢复，非普通 warning 不触发）
 */
export function useHlsStream(
  url: string | null | undefined,
  opts?: { epoch?: number; onFatalError?: () => void },
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { epoch = 0, onFatalError } = opts ?? {};
  const onFatalErrorRef = useRef(onFatalError);

  // 回调 identity 变化不重建播放器（避免每帧重创建 hls.js）
  useEffect(() => {
    onFatalErrorRef.current = onFatalError;
  }, [onFatalError]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!url || !videoEl) return;

    let destroyed = false;
    let hls: any = null;
    let lastFatalAt = 0;

    const run = async () => {
      const canNative =
        typeof videoEl.canPlayType === 'function' &&
        videoEl.canPlayType('application/vnd.apple.mpegurl');
      // 桌面 Chrome 对 canPlayType('application/vnd.apple.mpegurl') 可能返回 "maybe"，
      // 但原生 HLS 解码（尤其 MPEG-TS + H.264）经常报 DEMUXER_ERROR_COULD_NOT_PARSE 黑屏。
      // 因此优先使用 hls.js（MSE），只有浏览器不支持 MSE 时才退回原生 HLS（如 iOS Safari）。
      let Hls: any = null;
      try {
        Hls = (await import('hls.js')).default;
      } catch {
        Hls = null;
      }
      const hlsSupported = !!(Hls && typeof Hls.isSupported === 'function' && Hls.isSupported());
      if (!hlsSupported) {
        if (canNative) {
          videoEl.src = url;
          try {
            await videoEl.play();
          } catch {
            /* 自动播放被浏览器拦截时保持静默 */
          }
        }
        return;
      }
      try {
        if (destroyed) return;
        hls = new Hls({
          // 小米云 P2P 流偶有抖动/延迟尖峰：关闭低延迟模式，留足够缓冲，优先稳定而不是最低延迟
          lowLatencyMode: false,
          enableWorker: true,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          maxBufferLength: 12,
          maxMaxBufferLength: 30,
          backBufferLength: 10,
          manifestLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 1000,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 1000,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 1000,
        });
        // 只处理 fatal 错误（防抖 3s），通知页面触发受控恢复；普通网络抖动交给 hls.js 内部重试
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data || !data.fatal || destroyed) return;
          const now = Date.now();
          if (now - lastFatalAt < 3000) return;
          lastFatalAt = now;
          onFatalErrorRef.current?.();
        });
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play().catch(() => {});
        });
      } catch {
        /* 拉流失败时静默，由外层占位兜底 */
      }
    };

    run();

    // 直播流停滞检测：hls.js 在后端流恢复（m3u8 媒体序列跳变/重建）时可能静默卡死且不触发 fatal 错误，
    // 表现为 currentTime 长时间不前进。这里检测到卡死后复用 onFatalError 恢复路径（refetch + 重建播放器）。
    // - 暂停（自动播放被拦/用户暂停）与初始加载阶段不判定卡死，避免误触发恢复循环
    const STALL_CHECK_MS = 2000;
    const STALL_AFTER_MS = 8000;
    let lastPlayTime = -1;
    let stallStartedAt = 0;
    let hasAdvanced = false;
    const stallTimer = setInterval(() => {
      if (destroyed) return;
      try {
        const t = videoEl.currentTime;
        if (videoEl.paused) {
          lastPlayTime = t;
          stallStartedAt = 0;
          return;
        }
        if (t > 0) hasAdvanced = true;
        if (!hasAdvanced) {
          lastPlayTime = t;
          return;
        }
        if (t === lastPlayTime) {
          if (stallStartedAt === 0) stallStartedAt = Date.now();
          else if (Date.now() - stallStartedAt >= STALL_AFTER_MS) {
            stallStartedAt = 0;
            onFatalErrorRef.current?.();
          }
        } else {
          lastPlayTime = t;
          stallStartedAt = 0;
        }
      } catch {
        /* noop */
      }
    }, STALL_CHECK_MS);

    return () => {
      destroyed = true;
      clearInterval(stallTimer);
      if (hls) {
        try {
          hls.destroy();
        } catch {
          /* noop */
        }
      }
      try {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, epoch]);

  return videoRef;
}
