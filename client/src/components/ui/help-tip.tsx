import { useEffect, useRef, useState } from 'react';

/**
 * 问号帮助图标：说明类文字统一收进图标，点击展开，桌面悬停也可看。
 * 页面正文不再铺开说明文案。
 */
export function HelpTip({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  return (
    <span ref={ref} className={`relative inline-flex align-middle ${className ?? ''}`}>
      <button
        type="button"
        aria-label="说明"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex h-4 w-4 flex-none items-center justify-center rounded-full border border-current text-[10px] leading-none opacity-45 transition-opacity hover:opacity-100 focus:opacity-100"
      >
        ?
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-1/2 top-full z-40 mt-1.5 w-max max-w-[min(280px,78vw)] -translate-x-1/2 rounded-md bg-slate-900 px-2.5 py-1.5 text-left text-[11px] font-normal leading-snug text-slate-50 shadow-lg"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

export default HelpTip;
