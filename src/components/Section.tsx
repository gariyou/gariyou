import { useState, type ReactNode } from "react";

interface Props {
  icon: string;
  title: string;
  /** 入力済み項目数などのバッジ表示。0 のときは非表示 */
  filledCount: number;
  /** 警告バッジ表示（伏線の未回収警告など）。0 のときは非表示 */
  warningCount?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Section({
  icon,
  title,
  filledCount,
  warningCount = 0,
  defaultOpen = false,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-lg border border-night-600 bg-night-800/60 shadow-lg shadow-black/20">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-night-700/50"
      >
        <span className="font-serif-jp text-xs tracking-[0.2em] text-gold-400/80">{icon}</span>
        <span className="font-serif-jp flex-1 text-sm font-semibold tracking-wider text-slate-100">
          {title}
        </span>
        {warningCount > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            ⚠ {warningCount}
          </span>
        )}
        {filledCount > 0 && (
          <span className="rounded-full bg-gold-400/15 px-2 py-0.5 text-[10px] font-medium text-gold-300">
            {filledCount}
          </span>
        )}
        <span
          className={`text-xs text-slate-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          ▼
        </span>
      </button>
      {open && <div className="space-y-4 border-t border-night-600/70 px-4 py-4">{children}</div>}
    </section>
  );
}
