import { useEffect, useMemo, useRef, useState } from "react";
import { buildPrompt } from "./prompt";
import { SECTIONS, createEmptyState } from "./schema";
import type { AppState, ListItem } from "./types";
import { newId, stateHasContent } from "./utils";
import { ListEditor } from "./components/ListEditor";
import { FieldInput } from "./components/FieldInput";
import { Section } from "./components/Section";

const STORAGE_KEY = "ai-novel-prompt-builder:v1";
const BACKUP_KEY = "ai-novel-prompt-builder:backup";

interface BackupPayload {
  savedAt: string;
  state: Partial<AppState>;
}

function readBackup(): BackupPayload | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BackupPayload;
    if (!parsed || typeof parsed !== "object" || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** リセット・インポート・復元で失われる直前の状態を退避する */
function writeBackup(state: AppState): boolean {
  try {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), state } satisfies BackupPayload),
    );
    return true;
  } catch {
    return false;
  }
}

function loadState(): AppState {
  const empty = createEmptyState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return mergeState(empty, parsed);
  } catch {
    return empty;
  }
}

/** 保存データやインポートデータを、現在のスキーマに合わせて安全に取り込む */
function mergeState(base: AppState, incoming: Partial<AppState>): AppState {
  const next: AppState = { records: { ...base.records }, lists: { ...base.lists } };
  for (const section of SECTIONS) {
    if (section.kind === "record") {
      const source = incoming.records?.[section.id];
      if (!source || typeof source !== "object") continue;
      const values = { ...next.records[section.id] };
      for (const field of section.fields) {
        const value = source[field.key];
        if (field.type === "chips") {
          if (Array.isArray(value)) {
            values[field.key] = value.filter(
              (item): item is string =>
                typeof item === "string" && (field.options ?? []).includes(item),
            );
          }
        } else if (typeof value === "string") {
          values[field.key] = value;
        }
      }
      next.records[section.id] = values;
    } else {
      const source = incoming.lists?.[section.id];
      if (!Array.isArray(source)) continue;
      next.lists[section.id] = source
        .filter((item): item is ListItem => !!item && typeof item === "object")
        .map((item) => {
          const values: Record<string, string> = {};
          for (const field of section.fields) {
            const value = item.values?.[field.key];
            values[field.key] = typeof value === "string" ? value : "";
          }
          return { id: typeof item.id === "string" ? item.id : newId(), values };
        });
    }
  }
  return next;
}

function countFilled(values: Record<string, string | string[]>): number {
  return Object.values(values).filter((value) =>
    Array.isArray(value) ? value.length > 0 : value.trim() !== "",
  ).length;
}

const actionButtonClass =
  "rounded-md border border-night-600 bg-night-800 px-3 py-1.5 text-xs font-medium text-slate-300 " +
  "transition-colors hover:border-gold-400/50 hover:text-gold-300";

export default function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [copied, setCopied] = useState<"plain" | "markdown" | null>(null);
  const [mobileView, setMobileView] = useState<"form" | "preview">("form");
  const [hasBackup, setHasBackup] = useState(() => readBackup() !== null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ローカルストレージへ自動保存（デバウンス付き）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        // プライベートモードや容量超過では保存できないが、アプリ自体は使い続けられるようにする
        console.warn("自動保存に失敗しました:", error);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state]);

  /** 現在の状態をバックアップへ退避し、復元ボタンを表示する */
  const backupCurrentState = () => {
    if (stateHasContent(state) && writeBackup(state)) setHasBackup(true);
  };

  const prompt = useMemo(() => buildPrompt(state, false), [state]);
  const markdownPrompt = useMemo(() => buildPrompt(state, true), [state]);

  const updateRecord = (sectionId: string, key: string, value: string | string[]) => {
    setState((prev) => ({
      ...prev,
      records: {
        ...prev.records,
        [sectionId]: { ...prev.records[sectionId], [key]: value },
      },
    }));
  };

  const updateList = (sectionId: string, items: ListItem[]) => {
    setState((prev) => ({ ...prev, lists: { ...prev.lists, [sectionId]: items } }));
  };

  const copy = async (kind: "plain" | "markdown") => {
    const text = kind === "plain" ? prompt : markdownPrompt;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードAPIが使えない環境向けのフォールバック
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "novel-prompt.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importJson: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Partial<AppState>;
        const next = mergeState(createEmptyState(), parsed);
        backupCurrentState();
        setState(next);
      } catch {
        window.alert("JSONの読み込みに失敗しました。ファイル形式を確認してください。");
      }
    };
    reader.readAsText(file);
  };

  const reset = () => {
    const message = stateHasContent(state)
      ? "すべての入力内容を消去します。よろしいですか？\n（直前の内容はバックアップされ、「バックアップを復元」で戻せます）"
      : "すべての入力内容を消去します。よろしいですか？";
    if (!window.confirm(message)) return;
    backupCurrentState();
    setState(createEmptyState());
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 消せなくても空の状態が自動保存で上書きするため問題ない
    }
  };

  const restoreBackup = () => {
    const backup = readBackup();
    if (!backup) {
      setHasBackup(false);
      return;
    }
    const savedAt = new Date(backup.savedAt);
    const label = Number.isNaN(savedAt.getTime()) ? "" : `${savedAt.toLocaleString()} 時点の`;
    if (
      !window.confirm(`${label}バックアップを復元します。現在の入力内容と入れ替わります。よろしいですか？`)
    ) {
      return;
    }
    const restored = mergeState(createEmptyState(), backup.state);
    // 現在の状態を新しいバックアップにする（復元のやり直しができるように入れ替える）
    writeBackup(state);
    setState(restored);
  };

  const form = (
    <div className="space-y-3">
      {SECTIONS.map((section, index) =>
        section.kind === "record" ? (
          <Section
            key={section.id}
            icon={section.icon}
            title={section.title}
            filledCount={countFilled(state.records[section.id] ?? {})}
            defaultOpen={index === 0}
          >
            {section.fields.map((field) => (
              <FieldInput
                key={field.key}
                def={field}
                value={state.records[section.id]?.[field.key] ?? (field.type === "chips" ? [] : "")}
                onChange={(value) => updateRecord(section.id, field.key, value)}
              />
            ))}
          </Section>
        ) : (
          <Section
            key={section.id}
            icon={section.icon}
            title={section.title}
            filledCount={(state.lists[section.id] ?? []).length}
          >
            <ListEditor
              def={section}
              items={state.lists[section.id] ?? []}
              onChange={(items) => updateList(section.id, items)}
            />
          </Section>
        ),
      )}
    </div>
  );

  const preview = (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-night-600 bg-night-800/60 shadow-lg shadow-black/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-night-600/70 px-4 py-3">
        <h2 className="font-serif-jp mr-auto text-sm font-semibold tracking-wider text-slate-100">
          完成プロンプト
        </h2>
        <button type="button" onClick={() => copy("plain")} className={actionButtonClass}>
          {copied === "plain" ? "✓ コピーしました" : "コピー"}
        </button>
        <button type="button" onClick={() => copy("markdown")} className={actionButtonClass}>
          {copied === "markdown" ? "✓ コピーしました" : "Markdown形式でコピー"}
        </button>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-4 font-sans text-[13px] leading-relaxed text-slate-300">
        {prompt}
      </pre>
      <div className="border-t border-night-600/70 px-4 py-2 text-right text-[11px] text-slate-500">
        {prompt.length.toLocaleString()} 文字
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-night-950 text-slate-200">
      <header className="sticky top-0 z-10 border-b border-night-600/70 bg-night-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="mr-auto">
            <h1 className="font-serif-jp text-lg font-bold tracking-widest text-gold-300">
              AI Novel Prompt Builder
            </h1>
            <p className="text-[11px] tracking-wide text-slate-500">
              長編小説を破綻なく作るための設計書生成ツール
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={exportJson} className={actionButtonClass}>
              JSONでエクスポート
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={actionButtonClass}
            >
              JSONをインポート
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={importJson}
            />
            {hasBackup && (
              <button type="button" onClick={restoreBackup} className={actionButtonClass}>
                バックアップを復元
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-red-500/30 bg-night-800 px-3 py-1.5 text-xs font-medium text-red-400/90 transition-colors hover:border-red-500/60 hover:text-red-400"
            >
              リセット
            </button>
          </div>
        </div>
      </header>

      {/* モバイル用の表示切り替え */}
      <div className="mx-auto max-w-7xl px-4 pt-3 lg:hidden">
        <div className="flex overflow-hidden rounded-md border border-night-600">
          {(
            [
              ["form", "入力フォーム"],
              ["preview", "完成プロンプト"],
            ] as const
          ).map(([view, label]) => (
            <button
              key={view}
              type="button"
              onClick={() => setMobileView(view)}
              className={
                "flex-1 px-3 py-2 text-xs font-medium transition-colors " +
                (mobileView === view
                  ? "bg-gold-400/15 text-gold-300"
                  : "bg-night-800 text-slate-400")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-2 lg:py-6">
        <div className={mobileView === "form" ? "" : "hidden lg:block"}>{form}</div>
        <div
          className={
            (mobileView === "preview" ? "" : "hidden lg:block") +
            " lg:sticky lg:top-[4.5rem] lg:h-[calc(100vh-6rem)]"
          }
        >
          {preview}
        </div>
      </main>
    </div>
  );
}
