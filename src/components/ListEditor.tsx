import { useState } from "react";
import type { ListItem, ListSectionDef } from "../types";
import { newId } from "../utils";
import { FieldInput } from "./FieldInput";

interface Props {
  def: ListSectionDef;
  items: ListItem[];
  onChange: (items: ListItem[]) => void;
  /** select型フィールドへ動的に渡す選択肢（例: シーンの「所属章」に章タイトル一覧） */
  selectOptions?: Record<string, string[]>;
}

function newItem(def: ListSectionDef): ListItem {
  const values: Record<string, string> = {};
  for (const field of def.fields) values[field.key] = "";
  return { id: newId(), values };
}

export function ListEditor({ def, items, onChange, selectOptions }: Props) {
  // 追加直後のアイテムだけ開いた状態にする
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const toggleItem = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addItem = () => {
    const item = newItem(def);
    onChange([...items, item]);
    setOpenIds((prev) => new Set(prev).add(item.id));
  };

  const removeItem = (target: ListItem, index: number) => {
    // 何か入力済みのアイテムは、誤クリックで消えないよう確認を挟む
    const hasContent = Object.values(target.values).some((value) => value.trim() !== "");
    if (hasContent) {
      const name = (target.values[def.titleKey] ?? "").trim() || `${def.itemLabel}${index + 1}`;
      if (!window.confirm(`「${name}」を削除します。よろしいですか？`)) return;
    }
    onChange(items.filter((item) => item.id !== target.id));
  };

  const moveItem = (from: number, delta: -1 | 1) => {
    const to = from + delta;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };

  const updateItem = (id: string, key: string, value: string) => {
    onChange(
      items.map((item) =>
        item.id === id ? { ...item, values: { ...item.values, [key]: value } } : item,
      ),
    );
  };

  return (
    <div className="space-y-3">
      {items.map((item, index) => {
        const open = openIds.has(item.id);
        const name = (item.values[def.titleKey] ?? "").trim();
        const tag = def.tagKey ? (item.values[def.tagKey] ?? "").trim() : "";
        return (
          <div key={item.id} className="rounded-md border border-night-600 bg-night-900/60">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => toggleItem(item.id)}
                aria-expanded={open}
                className="flex flex-1 items-center gap-2 text-left"
              >
                <span
                  className={`text-[10px] text-slate-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                >
                  ▼
                </span>
                <span className="text-xs font-medium text-slate-300">
                  {def.itemLabel}
                  {index + 1}
                  {name && <span className="ml-2 text-gold-300/90">{name}</span>}
                  {tag && (
                    <span className="ml-2 rounded-full border border-night-600 px-2 py-0.5 text-[10px] font-normal text-slate-400">
                      {tag}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => moveItem(index, -1)}
                disabled={index === 0}
                aria-label="上へ移動"
                className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:text-gold-300 disabled:opacity-30 disabled:hover:text-slate-500"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveItem(index, 1)}
                disabled={index === items.length - 1}
                aria-label="下へ移動"
                className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:text-gold-300 disabled:opacity-30 disabled:hover:text-slate-500"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeItem(item, index)}
                className="rounded px-2 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                削除
              </button>
            </div>
            {open && (
              <div className="space-y-3 border-t border-night-600/70 px-3 py-3">
                {def.fields.map((field) => {
                  const resolved =
                    field.type === "select" && selectOptions?.[field.key]
                      ? { ...field, options: selectOptions[field.key] }
                      : field;
                  return (
                    <FieldInput
                      key={field.key}
                      def={resolved}
                      value={item.values[field.key] ?? ""}
                      onChange={(value) => updateItem(item.id, field.key, value as string)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addItem}
        className="w-full rounded-md border border-dashed border-gold-400/40 px-3 py-2 text-xs font-medium text-gold-300 transition-colors hover:border-gold-400/70 hover:bg-gold-400/10"
      >
        ＋ {def.addLabel}
      </button>
    </div>
  );
}
