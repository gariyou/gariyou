import type { AppState } from "./types";

/** crypto.randomUUID は非セキュアコンテキスト（LAN内のhttp等）では使えないため、フォールバック付きで生成する */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
