import type { AppState } from "./types";

/** crypto.randomUUID は非セキュアコンテキスト（LAN内のhttp等）では使えないため、フォールバック付きで生成する */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 章構成に入力済みの章タイトル一覧（重複除去済み・入力順） */
export function chapterTitleList(state: AppState): string[] {
  const titles = (state.lists.chapters ?? [])
    .map((item) => (item.values.title ?? "").trim())
    .filter(Boolean);
  return [...new Set(titles)];
}

/** 何かひとつでも入力されているか */
export function stateHasContent(state: AppState): boolean {
  const recordFilled = Object.values(state.records).some((values) =>
    Object.values(values).some((value) =>
      Array.isArray(value) ? value.length > 0 : value.trim() !== "",
    ),
  );
  return recordFilled || Object.values(state.lists).some((items) => items.length > 0);
}
