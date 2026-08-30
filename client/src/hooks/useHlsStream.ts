import { useEffect, useRef } from 'react';

/**
 * 挂载 HLS 直播流到 <video>。
 * - 原生支持 m3u8 的浏览器（Safari）直接赋值 src
 * - 其余走 hls.js（懒加载，与项目既有用法一致）
 * - url 变化或卸载时自动销毁旧实例
 */
export function useHlsStream(url: string | null | undefined) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!url || !videoEl) return;

    let destroyed = false;
    let hls: any = null;

    const run = async () => {
      const canNative =
        typeof videoEl.canPlayType === 'function' &&
        videoEl.canPlayType('application/vnd.apple.mpegurl');
      if (canNative) {
        videoEl.src = url;
        try {
          await videoEl.play();
        } catch {
          /* 自动播放被浏览器拦截时保持静默 */
        }
        return;
      }
      try {
        const Hls = (await import('hls.js')).default;
        if (!Hls || !Hls.isSupported() || destroyed) return;
        hls = new Hls({
          lowLatencyMode: true,
          enableWorker: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 3,
          maxBufferLength: 4,
          maxMaxBufferLength: 8,
          backBufferLength: 2,
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

    return () => {
      destroyed = true;
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
  }, [url]);

  return videoRef;
}
