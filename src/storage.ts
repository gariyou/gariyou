export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
}

export interface ProjectIndex {
  activeId: string;
  projects: ProjectMeta[];
}

const INDEX_KEY = "ai-novel-prompt-builder:projects";
/** 複数プロジェクト対応以前の単一スロットキー（初回起動時に移行する） */
const LEGACY_KEY = "ai-novel-prompt-builder:v1";

export const projectKey = (id: string) => `ai-novel-prompt-builder:project:${id}`;

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn("ローカルストレージへの保存に失敗しました:", error);
    return false;
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 消せなくても実害はない
  }
}

export function readIndex(): ProjectIndex | null {
  const raw = safeGet(INDEX_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProjectIndex;
    if (!parsed || !Array.isArray(parsed.projects)) return null;
    const projects = parsed.projects.filter(
      (meta): meta is ProjectMeta => !!meta && typeof meta.id === "string",
    );
    if (projects.length === 0) return null;
    const activeId = projects.some((meta) => meta.id === parsed.activeId)
      ? parsed.activeId
      : projects[0].id;
    return { activeId, projects };
  } catch {
    return null;
  }
}

export function writeIndex(index: ProjectIndex): boolean {
  return safeSet(INDEX_KEY, JSON.stringify(index));
}

export function readLegacyState(): string | null {
  return safeGet(LEGACY_KEY);
}

export function removeLegacyState(): void {
  safeRemove(LEGACY_KEY);
}
