import type { AppState, ChapterStatus, FlowState, ListItem } from "./types";

/** カードの大きさ（線の端点計算に使うため固定サイズにしている） */
export const CHAPTER_W = 224;
export const CHAPTER_H = 108;
export const SCENE_W = 200;
export const SCENE_H = 64;
export const NOTE_W = 184;
export const NOTE_H = 92;

const ORIGIN = 40;
const COLUMN_GAP = 300;
const SCENE_TOP_GAP = 52;
const SCENE_GAP = 16;

export const CHAPTER_STATUSES: {
  id: ChapterStatus;
  label: string;
  /** カード上端の帯・進捗バー */
  bar: string;
  /** 状態バッジ・選択ボタン */
  badge: string;
  /** カードの枠線 */
  border: string;
}[] = [
  {
    id: "todo",
    label: "未着手",
    bar: "bg-slate-600",
    badge: "border-slate-500/50 text-slate-400",
    border: "border-night-600",
  },
  {
    id: "writing",
    label: "執筆中",
    bar: "bg-sky-400",
    badge: "border-sky-400/50 bg-sky-400/10 text-sky-300",
    border: "border-sky-400/50",
  },
  {
    id: "drafted",
    label: "書き上げ",
    bar: "bg-emerald-400",
    badge: "border-emerald-400/50 bg-emerald-400/10 text-emerald-300",
    border: "border-emerald-400/50",
  },
  {
    id: "revised",
    label: "推敲済み",
    bar: "bg-gold-400",
    badge: "border-gold-400/60 bg-gold-400/10 text-gold-300",
    border: "border-gold-400/60",
  },
];

export function statusDef(status: ChapterStatus | undefined) {
  return CHAPTER_STATUSES.find((def) => def.id === status) ?? CHAPTER_STATUSES[0];
}

export function emptyFlow(): FlowState {
  return { positions: {}, status: {}, notes: [], links: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 保存データやインポートデータの flow を、壊れた値を捨てて取り込む */
export function sanitizeFlow(raw: unknown): FlowState {
  const flow = emptyFlow();
  if (!isRecord(raw)) return flow;
  if (isRecord(raw.positions)) {
    for (const [id, pos] of Object.entries(raw.positions)) {
      if (isRecord(pos) && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        flow.positions[id] = { x: pos.x as number, y: pos.y as number };
      }
    }
  }
  if (isRecord(raw.status)) {
    for (const [id, status] of Object.entries(raw.status)) {
      if (CHAPTER_STATUSES.some((def) => def.id === status)) {
        flow.status[id] = status as ChapterStatus;
      }
    }
  }
  if (Array.isArray(raw.notes)) {
    flow.notes = raw.notes
      .filter(isRecord)
      .filter((note) => typeof note.id === "string")
      .map((note) => ({ id: note.id as string, text: typeof note.text === "string" ? note.text : "" }));
  }
  if (Array.isArray(raw.links)) {
    flow.links = raw.links
      .filter(isRecord)
      .filter(
        (link) =>
          typeof link.id === "string" && typeof link.from === "string" && typeof link.to === "string",
      )
      .map((link) => ({ id: link.id as string, from: link.from as string, to: link.to as string }));
  }
  return flow;
}

export type CardKind = "chapter" | "scene" | "note";

export interface CardBox {
  id: string;
  kind: CardKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowLayout {
  chapters: { item: ListItem; index: number; box: CardBox }[];
  /** 章ごとのシーン（章 id → リスト順のシーン） */
  scenesByChapter: Map<string, { item: ListItem; index: number; box: CardBox }[]>;
  /** 所属章が未設定、または章構成に見つからないシーン */
  looseScenes: { item: ListItem; index: number; box: CardBox }[];
  /** 「所属章なし」列の見出し位置。該当シーンが無ければ null */
  looseLabel: { x: number; y: number } | null;
  notes: { id: string; text: string; box: CardBox }[];
  boxes: Map<string, CardBox>;
}

/** 章タイトル → その題名を持つ最初の章 */
export function chapterByTitle(chapters: ListItem[]): Map<string, ListItem> {
  const map = new Map<string, ListItem>();
  for (const item of chapters) {
    const title = (item.values.title ?? "").trim();
    if (title && !map.has(title)) map.set(title, item);
  }
  return map;
}

/**
 * カードの配置を決める。手動で動かしたカードは保存位置を使い、それ以外は
 * 章を横一列、シーンを所属章の下に縦一列で自動配置する（章を動かすと自動配置のシーンも付いていく）。
 */
export function computeLayout(
  state: AppState,
  positions: Record<string, { x: number; y: number }>,
): FlowLayout {
  const boxes = new Map<string, CardBox>();
  const chaptersList = state.lists.chapters ?? [];
  const byTitle = chapterByTitle(chaptersList);

  const chapters = chaptersList.map((item, index) => {
    const pos = positions[item.id] ?? { x: ORIGIN + index * COLUMN_GAP, y: ORIGIN };
    const box: CardBox = { id: item.id, kind: "chapter", ...pos, w: CHAPTER_W, h: CHAPTER_H };
    boxes.set(item.id, box);
    return { item, index, box };
  });

  const scenesByChapter = new Map<string, { item: ListItem; index: number; box: CardBox }[]>();
  const looseScenes: { item: ListItem; index: number; box: CardBox }[] = [];
  const looseX = ORIGIN + chaptersList.length * COLUMN_GAP;
  const sceneTop = (chapterY: number, slot: number) =>
    chapterY + CHAPTER_H + SCENE_TOP_GAP + slot * (SCENE_H + SCENE_GAP);

  (state.lists.scenes ?? []).forEach((item, index) => {
    const chapter = byTitle.get((item.values.chapter ?? "").trim());
    if (chapter) {
      const group = scenesByChapter.get(chapter.id) ?? [];
      const chapterBox = boxes.get(chapter.id)!;
      const pos = positions[item.id] ?? {
        x: chapterBox.x + (CHAPTER_W - SCENE_W) / 2,
        y: sceneTop(chapterBox.y, group.length),
      };
      const box: CardBox = { id: item.id, kind: "scene", ...pos, w: SCENE_W, h: SCENE_H };
      boxes.set(item.id, box);
      group.push({ item, index, box });
      scenesByChapter.set(chapter.id, group);
    } else {
      const pos = positions[item.id] ?? {
        x: looseX + (CHAPTER_W - SCENE_W) / 2,
        y: sceneTop(ORIGIN, looseScenes.length),
      };
      const box: CardBox = { id: item.id, kind: "scene", ...pos, w: SCENE_W, h: SCENE_H };
      boxes.set(item.id, box);
      looseScenes.push({ item, index, box });
    }
  });

  // 位置が無いメモ（インポート直後など）は、章・シーンの下に横一列で並べる
  let bottom = ORIGIN + CHAPTER_H;
  for (const box of boxes.values()) bottom = Math.max(bottom, box.y + box.h);
  let unplaced = 0;
  const notes = state.flow.notes.map((note) => {
    const pos = positions[note.id] ?? {
      x: ORIGIN + unplaced++ * (NOTE_W + 24),
      y: bottom + 80,
    };
    const box: CardBox = { id: note.id, kind: "note", ...pos, w: NOTE_W, h: NOTE_H };
    boxes.set(note.id, box);
    return { id: note.id, text: note.text, box };
  });

  return {
    chapters,
    scenesByChapter,
    looseScenes,
    looseLabel: looseScenes.length > 0 ? { x: looseX, y: ORIGIN } : null,
    notes,
    boxes,
  };
}

/**
 * 章タイトルの変更に合わせて、シーンの所属章と伏線の初出・回収の章を付け替える。
 * 同じタイトルの章が他にもある場合は、どの章を指していたか分からないので付け替えない。
 */
export function renameChapterReferences(
  lists: AppState["lists"],
  oldTitle: string,
  newTitle: string,
): AppState["lists"] {
  const from = oldTitle.trim();
  const to = newTitle.trim();
  if (!from || from === to) return lists;
  const sameTitle = (lists.chapters ?? []).filter(
    (item) => (item.values.title ?? "").trim() === from,
  ).length;
  if (sameTitle !== 1) return lists;
  const retarget = (items: ListItem[] | undefined, keys: string[]) =>
    (items ?? []).map((item) => {
      const changed = keys.filter((key) => (item.values[key] ?? "").trim() === from);
      if (changed.length === 0) return item;
      const values = { ...item.values };
      for (const key of changed) values[key] = to;
      return { ...item, values };
    });
  return {
    ...lists,
    scenes: retarget(lists.scenes, ["chapter"]),
    foreshadows: retarget(lists.foreshadows, ["introChapter", "payoffChapter"]),
  };
}
