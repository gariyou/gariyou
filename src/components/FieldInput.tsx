import type { FieldDef } from "../types";

interface Props {
  def: FieldDef;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}

const inputClass =
  "w-full rounded-md border border-night-600 bg-night-900 px-3 py-2 text-sm text-slate-200 " +
  "placeholder:text-slate-500/70 focus:border-gold-400/60 focus:outline-none focus:ring-1 focus:ring-gold-400/40 " +
  "transition-colors";

export function FieldInput({ def, value, onChange }: Props) {
  if (def.type === "chips") {
    const selected = Array.isArray(value) ? value : [];
    const toggle = (option: string) => {
      onChange(
        selected.includes(option)
          ? selected.filter((item) => item !== option)
          : [...selected, option],
      );
    };
    return (
      <div>
        <span className="mb-1.5 block text-xs font-medium tracking-wide text-slate-400">
          {def.label}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {(def.options ?? []).map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(option)}
                className={
                  "rounded-full border px-3 py-1 text-xs transition-colors " +
                  (active
                    ? "border-gold-400/70 bg-gold-400/15 text-gold-300"
                    : "border-night-600 bg-night-800 text-slate-400 hover:border-slate-500 hover:text-slate-300")
                }
              >
                {option}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-slate-400">
        {def.label}
      </span>
      {def.type === "textarea" ? (
        <textarea
          className={`${inputClass} min-h-[4.5rem] resize-y leading-relaxed`}
          value={text}
          placeholder={def.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type="text"
          className={inputClass}
          value={text}
          placeholder={def.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
