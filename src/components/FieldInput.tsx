import { useState } from "react";
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
  // 自由入力チップ用の下書き（chips以外のフィールドでは使われない）
  const [draft, setDraft] = useState("");

  if (def.type === "chips") {
    const selected = Array.isArray(value) ? value : [];
    const predefined = def.options ?? [];
    // 定義済みの選択肢に加え、自由入力で追加された選択中の値もチップとして表示する
    const custom = selected.filter((item) => !predefined.includes(item));
    const toggle = (option: string) => {
      onChange(
        selected.includes(option)
          ? selected.filter((item) => item !== option)
          : [...selected, option],
      );
    };
    const addCustom = () => {
      const entry = draft.trim();
      setDraft("");
      if (!entry || selected.includes(entry)) return;
      onChange([...selected, entry]);
    };
    return (
      <div>
        <span className="mb-1.5 block text-xs font-medium tracking-wide text-slate-400">
          {def.label}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {[...predefined, ...custom].map((option) => {
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
          <span className="inline-flex items-center gap-1">
            <input
              type="text"
              value={draft}
              placeholder="自由入力で追加"
              aria-label={`${def.label}に自由入力で追加`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustom();
                }
              }}
              className="w-32 rounded-full border border-dashed border-night-600 bg-night-900 px-3 py-1 text-xs text-slate-200 placeholder:text-slate-500/70 focus:border-gold-400/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={addCustom}
              className="rounded-full border border-night-600 bg-night-800 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:border-gold-400/50 hover:text-gold-300"
            >
              追加
            </button>
          </span>
        </div>
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";

  if (def.type === "select") {
    const options = def.options ?? [];
    // 選択肢から消えた保存値（章の改名・削除など）も選択状態のまま見えるようにする
    const optionList = text && !options.includes(text) ? [...options, text] : options;
    return (
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium tracking-wide text-slate-400">
          {def.label}
        </span>
        <select
          className={inputClass}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">（未設定）</option>
          {optionList.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

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
