import { useEffect, useMemo, useRef, useState } from "react";
import { buildPrompt, estimateTokens, type PromptFormat } from "./prompt";
import { SECTIONS, createEmptyState } from "./schema";
import { TEMPLATES } from "./templates";
import type { AppState, ListItem } from "./types";
import { chapterTitleList, newId, stateHasContent } from "./utils";
import {
  projectKey,
  readIndex,
  readLegacyState,
  removeLegacyState,
  safeGet,
  safeRemove,
  safeSet,
  writeIndex,
  type ProjectIndex,
} from "./storage";
import { ListEditor } from "./components/ListEditor";
import { FieldInput } from "./components/FieldInput";
import { Section } from "./components/Section";

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

/** プロジェクト名は作品タイトル（なければ仮タイトル）から自動で決める */
function deriveProjectName(state: AppState): string {
  const basic = state.records.basic ?? {};
  const title = typeof basic.title === "string" ? basic.title.trim() : "";
  const tentative = typeof basic.tentativeTitle === "string" ? basic.tentativeTitle.trim() : "";
  return title || tentative || "無題の作品";
}

function loadProjectState(id: string): AppState {
  const empty = createEmptyState();
  const raw = safeGet(projectKey(id));
  if (!raw) return empty;
  try {
    return mergeState(empty, JSON.parse(raw) as Partial<AppState>);
  } catch {
    return empty;
  }
}

/** プロジェクト一覧を読み込む。初回起動時は旧単一スロット保存から移行する */
function initialSetup(): { index: ProjectIndex; state: AppState } {
  const existing = readIndex();
  if (existing) return { index: existing, state: loadProjectState(existing.activeId) };

  let state = createEmptyState();
  const legacy = readLegacyState();
  if (legacy) {
    try {
      state = mergeState(createEmptyState(), JSON.parse(legacy) as Partial<AppState>);
    } catch {
      // 壊れた保存データは捨てて新規開始する
    }
  }
  const id = newId();
  const index: ProjectIndex = {
    activeId: id,
    projects: [{ id, name: deriveProjectName(state), updatedAt: new Date().toISOString() }],
  };
  safeSet(projectKey(id), JSON.stringify(state));
  writeIndex(index);
  removeLegacyState();
  return { index, state };
}

/** 現在のプロジェクトを保存し、名前と更新日時を反映したインデックスを返す */
function persistProject(state: AppState, index: ProjectIndex): ProjectIndex {
  safeSet(projectKey(index.activeId), JSON.stringify(state));
  const next: ProjectIndex = {
    ...index,
    projects: index.projects.map((meta) =>
      meta.id === index.activeId
        ? { ...meta, name: deriveProjectName(state), updatedAt: new Date().toISOString() }
        : meta,
    ),
  };
  writeIndex(next);
  return next;
}

/** 保存データやインポートデータを、現在のスキーマに合わせて安全に取り込む */
function mergeState(base: AppState, incoming: Partial<AppState>): AppState {
  const next: AppState = {
    records: { ...base.records },
    lists: { ...base.lists },
    hiddenSections: Array.isArray(incoming.hiddenSections)
      ? incoming.hiddenSections.filter(
          (id): id is string =>
            typeof id === "string" && SECTIONS.some((section) => section.id === id),
        )
      : [...base.hiddenSections],
    template: TEMPLATES.some((template) => template.id === incoming.template)
      ? (incoming.template as string)
      : base.template,
  };
  for (const section of SECTIONS) {
    if (section.kind === "record") {
      const source = incoming.records?.[section.id];
      if (!source || typeof source !== "object") continue;
      const values = { ...next.records[section.id] };
      for (const field of section.fields) {
        const value = source[field.key];
        if (field.type === "chips") {
          if (Array.isArray(value)) {
            // 自由入力チップも取り込めるよう、文字列であれば選択肢外の値も受け入れる
            values[field.key] = [
              ...new Set(value.filter((item): item is string => typeof item === "string")),
            ];
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
  const initial = useMemo(initialSetup, []);
  const [index, setIndex] = useState<ProjectIndex>(initial.index);
  const [state, setState] = useState<AppState>(initial.state);
  const [copied, setCopied] = useState<"current" | "markdown" | null>(null);
  const [previewMode, setPreviewMode] = useState<PromptFormat>("plain");
  const [mobileView, setMobileView] = useState<"form" | "preview">("form");
  const [hasBackup, setHasBackup] = useState(() => readBackup() !== null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 現在のプロジェクトへ自動保存（デバウンス付き）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = persistProject(state, index);
      // 作品タイトル由来のプロジェクト名が変わったときだけ画面側も更新する
      const nameOf = (idx: ProjectIndex) =>
        idx.projects.find((meta) => meta.id === idx.activeId)?.name;
      if (nameOf(index) !== nameOf(next)) setIndex(next);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state, index]);

  /** 現在の状態をバックアップへ退避し、復元ボタンを表示する */
  const backupCurrentState = () => {
    if (stateHasContent(state) && writeBackup(state)) setHasBackup(true);
  };

  const switchProject = (id: string) => {
    if (id === index.activeId) return;
    // デバウンス待ちの編集を失わないよう、切り替え前に確実に保存する
    const saved = persistProject(state, index);
    const next: ProjectIndex = { ...saved, activeId: id };
    writeIndex(next);
    setIndex(next);
    setState(loadProjectState(id));
  };

  const createProject = () => {
    const saved = persistProject(state, index);
    const id = newId();
    const empty = createEmptyState();
    safeSet(projectKey(id), JSON.stringify(empty));
    const next: ProjectIndex = {
      activeId: id,
      projects: [...saved.projects, { id, name: "無題の作品", updatedAt: new Date().toISOString() }],
    };
    writeIndex(next);
    setIndex(next);
    setState(empty);
  };

  const deleteProject = () => {
    const name = index.projects.find((meta) => meta.id === index.activeId)?.name ?? "無題の作品";
    const message = stateHasContent(state)
      ? `作品「${name}」を削除します。よろしいですか？\n（直前の内容はバックアップされ、「バックアップを復元」で戻せます）`
      : `作品「${name}」を削除します。よろしいですか？`;
    if (!window.confirm(message)) return;
    backupCurrentState();
    safeRemove(projectKey(index.activeId));
    const remaining = index.projects.filter((meta) => meta.id !== index.activeId);
    if (remaining.length === 0) {
      // 最後の1件を消したら、空の作品を作り直す
      const id = newId();
      const empty = createEmptyState();
      safeSet(projectKey(id), JSON.stringify(empty));
      const next: ProjectIndex = {
        activeId: id,
        projects: [{ id, name: "無題の作品", updatedAt: new Date().toISOString() }],
      };
      writeIndex(next);
      setIndex(next);
      setState(empty);
      return;
    }
    const next: ProjectIndex = { activeId: remaining[0].id, projects: remaining };
    writeIndex(next);
    setIndex(next);
    setState(loadProjectState(remaining[0].id));
  };

  const prompt = useMemo(() => buildPrompt(state, previewMode), [state, previewMode]);
  const markdownPrompt = useMemo(() => buildPrompt(state, "markdown"), [state]);

  // シーン・伏線の章セレクトに渡す章タイトル一覧
  const chapterTitles = useMemo(() => chapterTitleList(state), [state.lists.chapters]);

  // 伏線の未回収・リンク切れ警告（章構成が使われている場合のみチェックする）
  const foreshadowWarnings = useMemo(() => {
    if (chapterTitles.length === 0) return [];
    const warnings: string[] = [];
    (state.lists.foreshadows ?? []).forEach((item, index) => {
      const values = item.values;
      if (!Object.values(values).some((value) => value.trim() !== "")) return;
      const name = (values.name ?? "").trim() || `伏線${index + 1}`;
      const payoffChapter = (values.payoffChapter ?? "").trim();
      if (!payoffChapter) {
        warnings.push(`「${name}」の回収の章が未設定です`);
      } else if (!chapterTitles.includes(payoffChapter)) {
        warnings.push(`「${name}」の回収の章「${payoffChapter}」が章構成に見つかりません`);
      }
      const introChapter = (values.introChapter ?? "").trim();
      if (introChapter && !chapterTitles.includes(introChapter)) {
        warnings.push(`「${name}」の初出の章「${introChapter}」が章構成に見つかりません`);
      }
    });
    return warnings;
  }, [state.lists.foreshadows, chapterTitles]);

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

  /** テンプレートを切り替え、出力セクションをテンプレート推奨値に合わせる */
  const applyTemplate = (templateId: string) => {
    const template = TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    setState((prev) => ({
      ...prev,
      template: templateId,
      hiddenSections: [...template.recommendedHidden],
    }));
  };

  /** シーンを章構成の順に並べ替える（同じ章の中では現在の順序を保つ） */
  const sortScenesByChapter = () => {
    const items = state.lists.scenes ?? [];
    const order = new Map(chapterTitles.map((title, position) => [title, position]));
    const staleNames = [
      ...new Set(
        items
          .map((item) => (item.values.chapter ?? "").trim())
          .filter((name) => name && !order.has(name)),
      ),
    ];
    const rank = (item: ListItem): number => {
      const chapter = (item.values.chapter ?? "").trim();
      if (!chapter) return chapterTitles.length + staleNames.length; // 未設定は最後
      return order.get(chapter) ?? chapterTitles.length + staleNames.indexOf(chapter);
    };
    const next = items
      .map((item, position) => ({ item, position }))
      .sort((a, b) => rank(a.item) - rank(b.item) || a.position - b.position)
      .map(({ item }) => item);
    updateList("scenes", next);
  };

  const toggleSectionOutput = (sectionId: string) => {
    setState((prev) => ({
      ...prev,
      hiddenSections: prev.hiddenSections.includes(sectionId)
        ? prev.hiddenSections.filter((id) => id !== sectionId)
        : [...prev.hiddenSections, sectionId],
    }));
  };

  const copy = async (kind: "current" | "markdown") => {
    const text = kind === "current" ? prompt : markdownPrompt;
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
    anchor.download = `${deriveProjectName(state).replace(/[\\/:*?"<>|]/g, "_")}.json`;
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
    // 空の状態が自動保存でプロジェクトへ書き込まれる
    setState(createEmptyState());
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
            warningCount={section.id === "foreshadows" ? foreshadowWarnings.length : 0}
          >
            {section.id === "foreshadows" && foreshadowWarnings.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <p className="mb-1 font-medium">⚠ 回収チェック</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {foreshadowWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {section.id === "scenes" &&
              (state.lists.scenes ?? []).length > 1 &&
              chapterTitles.length > 0 && (
                <button
                  type="button"
                  onClick={sortScenesByChapter}
                  className="rounded-md border border-night-600 bg-night-900 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-gold-400/50 hover:text-gold-300"
                >
                  章構成の順に並べ替え
                </button>
              )}
            <ListEditor
              def={section}
              items={state.lists[section.id] ?? []}
              onChange={(items) => updateList(section.id, items)}
              selectOptions={
                section.id === "scenes"
                  ? { chapter: chapterTitles }
                  : section.id === "foreshadows"
                    ? { introChapter: chapterTitles, payoffChapter: chapterTitles }
                    : undefined
              }
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
        <div
          role="group"
          aria-label="出力形式"
          className="flex overflow-hidden rounded-md border border-night-600 text-xs"
        >
          {(
            [
              ["plain", "テキスト", "汎用のプレーンテキスト形式"],
              ["markdown", "Markdown", "ChatGPT / Cursor などに適した形式"],
              ["xml", "XML", "Claude が得意とするタグ構造の形式"],
            ] as const
          ).map(([mode, label, description]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={previewMode === mode}
              title={description}
              onClick={() => setPreviewMode(mode)}
              className={
                "px-2.5 py-1.5 font-medium transition-colors " +
                (previewMode === mode
                  ? "bg-gold-400/15 text-gold-300"
                  : "bg-night-800 text-slate-400 hover:text-slate-300")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => copy("current")} className={actionButtonClass}>
          {copied === "current" ? "✓ コピーしました" : "コピー"}
        </button>
        <button type="button" onClick={() => copy("markdown")} className={actionButtonClass}>
          {copied === "markdown" ? "✓ コピーしました" : "Markdown形式でコピー"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-night-600/70 px-4 py-2">
        <span className="mr-1 text-[10px] tracking-wide text-slate-500">テンプレート:</span>
        {TEMPLATES.map((template) => {
          const active = state.template === template.id;
          return (
            <button
              key={template.id}
              type="button"
              aria-pressed={active}
              title="選択すると出力セクションもテンプレートの推奨構成に切り替わります"
              onClick={() => applyTemplate(template.id)}
              className={
                "rounded-full border px-2.5 py-0.5 text-[10px] transition-colors " +
                (active
                  ? "border-gold-400/70 bg-gold-400/15 text-gold-300"
                  : "border-night-600 bg-night-900 text-slate-400 hover:border-slate-500 hover:text-slate-300")
              }
            >
              {template.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-night-600/70 px-4 py-2">
        <span className="mr-1 text-[10px] tracking-wide text-slate-500">出力するセクション:</span>
        {SECTIONS.map((section) => {
          const included = !state.hiddenSections.includes(section.id);
          return (
            <button
              key={section.id}
              type="button"
              aria-pressed={included}
              onClick={() => toggleSectionOutput(section.id)}
              title={included ? "クリックで出力から除外" : "クリックで出力に含める"}
              className={
                "rounded-full border px-2 py-0.5 text-[10px] transition-colors " +
                (included
                  ? "border-gold-400/50 bg-gold-400/10 text-gold-300"
                  : "border-night-600 bg-night-900 text-slate-500 line-through hover:text-slate-400")
              }
            >
              {section.title}
            </button>
          );
        })}
      </div>
      {foreshadowWarnings.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-[11px] leading-relaxed text-amber-300/90">
          ⚠ 伏線の回収チェック（{foreshadowWarnings.length}件）: {foreshadowWarnings.join(" ／ ")}
        </div>
      )}
      <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-4 font-sans text-[13px] leading-relaxed text-slate-300">
        {prompt}
      </pre>
      <div
        className="border-t border-night-600/70 px-4 py-2 text-right text-[11px] text-slate-500"
        title="日本語はおおむね1文字≒1.1トークンとして概算しています"
      >
        {prompt.length.toLocaleString()} 文字 ・ 約{estimateTokens(prompt).toLocaleString()}{" "}
        トークン（目安）
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
            <select
              value={index.activeId}
              onChange={(event) => switchProject(event.target.value)}
              aria-label="作品の切り替え"
              className="max-w-[11rem] rounded-md border border-night-600 bg-night-800 px-2 py-1.5 text-xs font-medium text-slate-200 focus:border-gold-400/60 focus:outline-none"
            >
              {index.projects.map((meta) => (
                <option key={meta.id} value={meta.id}>
                  {meta.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={createProject} className={actionButtonClass}>
              ＋ 新規作品
            </button>
            <button
              type="button"
              onClick={deleteProject}
              className="rounded-md border border-night-600 bg-night-800 px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:border-red-500/50 hover:text-red-400"
            >
              作品を削除
            </button>
            <span aria-hidden className="mx-1 hidden h-4 w-px bg-night-600 sm:block" />
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
