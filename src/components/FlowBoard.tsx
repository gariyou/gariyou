import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import {
  CHAPTER_STATUSES,
  NOTE_H,
  NOTE_W,
  chapterByTitle,
  computeLayout,
  renameChapterReferences,
  statusDef,
  type CardBox,
  type CardKind,
} from "../flow";
import { getSections } from "../schema";
import type { AppState, ChapterStatus, ListItem, ListSectionDef } from "../types";
import { chapterTitleList, newId } from "../utils";
import { FieldInput } from "./FieldInput";

interface Props {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
}

type Selection = { kind: CardKind | "foreshadow" | "link"; id: string } | null;

interface View {
  x: number;
  y: number;
  k: number;
}

interface DragState {
  id: string;
  kind: CardKind;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  moved: boolean;
  /** シーンを重ねている章カードの id（離すとその章へ付け替える） */
  dropChapterId: string | null;
}

interface PanState {
  pointers: Map<number, { x: number; y: number }>;
  travel: number;
  lastDist: number | null;
  lastMid: { x: number; y: number } | null;
}

const MIN_K = 0.25;
const MAX_K = 2;
/** これ以上動いたらクリックではなくドラッグとみなす（px） */
const DRAG_THRESHOLD = 4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 画面上の点 (px, py) を中心に拡大縮小する */
const zoomAround =
  (px: number, py: number, factor: number) =>
  (view: View): View => {
    const k = clamp(view.k * factor, MIN_K, MAX_K);
    const ratio = k / view.k;
    return { k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
  };

const hasContent = (values: Record<string, string>) =>
  Object.values(values).some((value) => value.trim() !== "");

function listDef(mode: AppState["mode"], id: string): ListSectionDef {
  return getSections(mode).find((section) => section.id === id) as ListSectionDef;
}

function emptyItem(def: ListSectionDef, preset: Record<string, string> = {}): ListItem {
  const values: Record<string, string> = {};
  for (const field of def.fields) values[field.key] = "";
  return { id: newId(), values: { ...values, ...preset } };
}

/** 左右をつなぐ曲線（章 → 次の章） */
function horizontalCurve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** 上下をつなぐ曲線（章 → シーン → 次のシーン） */
function verticalCurve(x1: number, y1: number, x2: number, y2: number): string {
  const dy = Math.max(20, Math.abs(y2 - y1) / 2);
  return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
}

const toolButton =
  "rounded-md border border-night-600 bg-night-800 px-2.5 py-1.5 text-xs font-medium text-slate-300 " +
  "transition-colors hover:border-gold-400/50 hover:text-gold-300";

const panelButton =
  "rounded-md border border-night-600 bg-night-900 px-2.5 py-1 text-xs text-slate-400 " +
  "transition-colors hover:border-gold-400/50 hover:text-gold-300 disabled:opacity-30 disabled:hover:border-night-600 disabled:hover:text-slate-400";

const deleteButton =
  "rounded-md border border-red-500/30 bg-night-900 px-2.5 py-1 text-xs text-red-400/90 " +
  "transition-colors hover:border-red-500/60 hover:text-red-400";

export function FlowBoard({ state, setState }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [selection, setSelection] = useState<Selection>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [showForeshadows, setShowForeshadows] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState>({ pointers: new Map(), travel: 0, lastDist: null, lastMid: null });

  const chapterDef = listDef(state.mode, "chapters");
  const sceneDef = listDef(state.mode, "scenes");
  const foreshadowDef = listDef(state.mode, "foreshadows");
  const chapters = state.lists.chapters ?? [];
  const scenes = state.lists.scenes ?? [];
  const foreshadows = state.lists.foreshadows ?? [];
  const chapterTitles = useMemo(() => chapterTitleList(state), [state.lists.chapters]);

  // ドラッグ中のカードは、離すまで保存せず表示だけ動かす
  const positions = useMemo(
    () =>
      drag ? { ...state.flow.positions, [drag.id]: { x: drag.x, y: drag.y } } : state.flow.positions,
    [state.flow.positions, drag],
  );
  const layout = useMemo(() => computeLayout(state, positions), [state, positions]);

  // 伏線の線：初出の章 → 回収の章。どちらの章にも紐付かない伏線は一覧で知らせる
  const foreshadowInfo = useMemo(() => {
    const byTitle = chapterByTitle(chapters);
    const arcs: {
      item: ListItem;
      index: number;
      from: CardBox | undefined;
      to: CardBox | undefined;
      lane: number;
    }[] = [];
    const unplaced: { item: ListItem; index: number }[] = [];
    const perChapter = new Map<string, number>();
    foreshadows.forEach((item, index) => {
      if (!hasContent(item.values)) return;
      const intro = byTitle.get((item.values.introChapter ?? "").trim());
      const payoff = byTitle.get((item.values.payoffChapter ?? "").trim());
      for (const chapter of new Set([intro, payoff])) {
        if (chapter) perChapter.set(chapter.id, (perChapter.get(chapter.id) ?? 0) + 1);
      }
      if (!intro && !payoff) {
        unplaced.push({ item, index });
        return;
      }
      arcs.push({
        item,
        index,
        from: intro ? layout.boxes.get(intro.id) : undefined,
        to: payoff ? layout.boxes.get(payoff.id) : undefined,
        lane: arcs.length % 5,
      });
    });
    return { arcs, unplaced, perChapter };
  }, [chapters, foreshadows, layout]);

  /** 画面座標 → キャンバス座標 */
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: (clientX - rect.left - current.x) / current.k,
      y: (clientY - rect.top - current.y) / current.k,
    };
  };

  /**
   * すべてのカードが画面に収まるように表示位置と倍率を合わせる。
   * 初回表示では、スマホなどで字が読めないほど小さくなる場合に左上（物語の始まり）を優先する。
   */
  const fitView = (initial = false) => {
    const container = containerRef.current;
    if (!container) return;
    const boxes = [...layout.boxes.values()];
    if (boxes.length === 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const box of boxes) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    // 伏線の弧はカードの上に描くので、その分の余白を取る
    if (showForeshadows && foreshadowInfo.arcs.length > 0) minY -= 190;
    const pad = 32;
    const width = container.clientWidth - pad * 2;
    const height = container.clientHeight - pad * 2;
    const fitK = clamp(Math.min(width / (maxX - minX), height / (maxY - minY)), MIN_K, 1.1);
    const readableK = 0.6;
    if (initial && fitK < readableK) {
      setView({ k: readableK, x: pad - minX * readableK, y: pad - minY * readableK });
      return;
    }
    setView({
      k: fitK,
      x: pad - minX * fitK + Math.max(0, (width - (maxX - minX) * fitK) / 2),
      y: pad - minY * fitK,
    });
  };

  // 初回表示時に全体が見えるようにする
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    fitView(true);
  });

  // ホイールで拡大縮小（ページのスクロールを止めるため passive: false で登録する）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const speed = event.ctrlKey ? 0.01 : 0.0015;
      setView(
        zoomAround(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * speed)),
      );
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // ---- データ更新 ----

  const updateItem = (sectionId: string, id: string, key: string, value: string) => {
    setState((prev) => {
      let lists = prev.lists;
      if (sectionId === "chapters" && key === "title") {
        // 章を改名しても、シーンと伏線の紐付けが切れないように付け替える
        const old = (lists.chapters ?? []).find((item) => item.id === id)?.values.title ?? "";
        lists = renameChapterReferences(lists, old, value);
      }
      return {
        ...prev,
        lists: {
          ...lists,
          [sectionId]: (lists[sectionId] ?? []).map((item) =>
            item.id === id ? { ...item, values: { ...item.values, [key]: value } } : item,
          ),
        },
      };
    });
  };

  const commitPosition = (id: string, x: number, y: number) => {
    setState((prev) => ({
      ...prev,
      flow: {
        ...prev.flow,
        positions: { ...prev.flow.positions, [id]: { x: Math.round(x), y: Math.round(y) } },
      },
    }));
  };

  /** シーンを章へ付け替え、章の下の自動配置に戻す */
  const assignSceneToChapter = (sceneId: string, chapterId: string, drop: { x: number; y: number }) => {
    const chapter = chapters.find((item) => item.id === chapterId);
    const title = (chapter?.values.title ?? "").trim();
    if (!title) {
      window.alert(`${chapterDef.itemLabel}タイトルが未入力の${chapterDef.itemLabel}には付け替えられません。先にタイトルを入力してください。`);
      commitPosition(sceneId, drop.x, drop.y);
      return;
    }
    setState((prev) => {
      const { [sceneId]: _removed, ...restPositions } = prev.flow.positions;
      return {
        ...prev,
        lists: {
          ...prev.lists,
          scenes: (prev.lists.scenes ?? []).map((item) =>
            item.id === sceneId ? { ...item, values: { ...item.values, chapter: title } } : item,
          ),
        },
        flow: { ...prev.flow, positions: restPositions },
      };
    });
  };

  const setStatus = (chapterId: string, status: ChapterStatus) => {
    setState((prev) => {
      const { [chapterId]: _previous, ...rest } = prev.flow.status;
      return {
        ...prev,
        flow: { ...prev.flow, status: status === "todo" ? rest : { ...rest, [chapterId]: status } },
      };
    });
  };

  const selectedChapterTitle =
    selection?.kind === "chapter"
      ? (chapters.find((item) => item.id === selection.id)?.values.title ?? "").trim()
      : "";

  const addChapter = () => {
    const item = emptyItem(chapterDef);
    setState((prev) => ({ ...prev, lists: { ...prev.lists, chapters: [...(prev.lists.chapters ?? []), item] } }));
    setSelection({ kind: "chapter", id: item.id });
  };

  const addScene = (chapterTitle = selectedChapterTitle) => {
    const item = emptyItem(sceneDef, chapterTitle ? { chapter: chapterTitle } : {});
    setState((prev) => ({ ...prev, lists: { ...prev.lists, scenes: [...(prev.lists.scenes ?? []), item] } }));
    setSelection({ kind: "scene", id: item.id });
  };

  const addForeshadow = () => {
    const item = emptyItem(foreshadowDef, selectedChapterTitle ? { introChapter: selectedChapterTitle } : {});
    setState((prev) => ({
      ...prev,
      lists: { ...prev.lists, foreshadows: [...(prev.lists.foreshadows ?? []), item] },
    }));
    setSelection({ kind: "foreshadow", id: item.id });
  };

  const addNote = (at?: { x: number; y: number }) => {
    const container = containerRef.current;
    const center =
      at ??
      (container
        ? {
            x: (container.clientWidth / 2 - view.x) / view.k - NOTE_W / 2,
            y: (container.clientHeight / 2 - view.y) / view.k - NOTE_H / 2,
          }
        : { x: 40, y: 40 });
    const id = newId();
    setState((prev) => ({
      ...prev,
      flow: {
        ...prev.flow,
        notes: [...prev.flow.notes, { id, text: "" }],
        positions: { ...prev.flow.positions, [id]: { x: Math.round(center.x), y: Math.round(center.y) } },
      },
    }));
    setSelection({ kind: "note", id });
  };

  const addLink = (from: string, to: string) => {
    if (from === to) return;
    setState((prev) => {
      const exists = prev.flow.links.some(
        (link) => (link.from === from && link.to === to) || (link.from === to && link.to === from),
      );
      if (exists) return prev;
      return { ...prev, flow: { ...prev.flow, links: [...prev.flow.links, { id: newId(), from, to }] } };
    });
  };

  /** カードを消すときは、その位置・執筆状況・つながっている線も一緒に消す */
  const withoutCard = (flow: AppState["flow"], id: string): AppState["flow"] => {
    const { [id]: _position, ...positionsRest } = flow.positions;
    const { [id]: _status, ...statusRest } = flow.status;
    return {
      ...flow,
      positions: positionsRest,
      status: statusRest,
      notes: flow.notes.filter((note) => note.id !== id),
      links: flow.links.filter((link) => link.from !== id && link.to !== id),
    };
  };

  const deleteSelection = () => {
    if (!selection) return;
    const { kind, id } = selection;
    if (kind === "link") {
      setState((prev) => ({
        ...prev,
        flow: { ...prev.flow, links: prev.flow.links.filter((link) => link.id !== id) },
      }));
      setSelection(null);
      return;
    }
    if (kind === "note") {
      const note = state.flow.notes.find((entry) => entry.id === id);
      if (note?.text.trim() && !window.confirm("このメモを削除します。よろしいですか？")) return;
      setState((prev) => ({ ...prev, flow: withoutCard(prev.flow, id) }));
      setSelection(null);
      return;
    }
    const sectionId = kind === "chapter" ? "chapters" : kind === "scene" ? "scenes" : "foreshadows";
    const def = kind === "chapter" ? chapterDef : kind === "scene" ? sceneDef : foreshadowDef;
    const items = state.lists[sectionId] ?? [];
    const index = items.findIndex((item) => item.id === id);
    const target = items[index];
    if (!target) return;
    if (hasContent(target.values)) {
      const name = (target.values[def.titleKey] ?? "").trim() || `${def.itemLabel}${index + 1}`;
      if (!window.confirm(`「${name}」を削除します。よろしいですか？`)) return;
    }
    setState((prev) => ({
      ...prev,
      lists: { ...prev.lists, [sectionId]: (prev.lists[sectionId] ?? []).filter((item) => item.id !== id) },
      flow: withoutCard(prev.flow, id),
    }));
    setSelection(null);
  };

  /** 章の順番（物語の順番）を入れ替える */
  const moveChapter = (id: string, delta: -1 | 1) => {
    setState((prev) => {
      const items = [...(prev.lists.chapters ?? [])];
      const from = items.findIndex((item) => item.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return prev;
      [items[from], items[to]] = [items[to], items[from]];
      return { ...prev, lists: { ...prev.lists, chapters: items } };
    });
  };

  /** 同じ章のシーンの中で順番を入れ替える */
  const moveScene = (id: string, delta: -1 | 1) => {
    setState((prev) => {
      const items = [...(prev.lists.scenes ?? [])];
      const from = items.findIndex((item) => item.id === id);
      if (from < 0) return prev;
      const chapter = (items[from].values.chapter ?? "").trim();
      const siblings = items
        .map((item, position) => ({ item, position }))
        .filter(({ item }) => (item.values.chapter ?? "").trim() === chapter)
        .map(({ position }) => position);
      const at = siblings.indexOf(from);
      const to = siblings[at + delta];
      if (to === undefined) return prev;
      [items[from], items[to]] = [items[to], items[from]];
      return { ...prev, lists: { ...prev.lists, scenes: items } };
    });
  };

  const autoArrange = () => {
    if (
      !window.confirm(
        "手動で動かした章・シーンのカードを自動配置に戻します。よろしいですか？（メモの位置はそのままです）",
      )
    ) {
      return;
    }
    const ids = new Set([...chapters, ...scenes].map((item) => item.id));
    setState((prev) => ({
      ...prev,
      flow: {
        ...prev.flow,
        positions: Object.fromEntries(
          Object.entries(prev.flow.positions).filter(([id]) => !ids.has(id)),
        ),
      },
    }));
  };

  // ---- ポインター操作 ----

  const handleCardClick = (id: string, kind: CardKind) => {
    if (connectMode) {
      if (!connectFrom) {
        setConnectFrom(id);
      } else if (connectFrom !== id) {
        addLink(connectFrom, id);
        setConnectFrom(null);
        setConnectMode(false);
      }
      return;
    }
    setSelection({ kind, id });
  };

  const onCardPointerDown = (event: ReactPointerEvent<HTMLDivElement>, box: CardBox) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: box.id,
      kind: box.kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: box.x,
      originY: box.y,
      x: box.x,
      y: box.y,
      moved: false,
      dropChapterId: null,
    };
  };

  const onCardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY);
    if (!current.moved && distance < DRAG_THRESHOLD) return;
    const k = viewRef.current.k;
    let dropChapterId: string | null = null;
    if (current.kind === "scene") {
      const point = toCanvas(event.clientX, event.clientY);
      dropChapterId =
        layout.chapters.find(
          ({ box }) =>
            point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h,
        )?.item.id ?? null;
    }
    const next: DragState = {
      ...current,
      moved: true,
      x: current.originX + (event.clientX - current.startClientX) / k,
      y: current.originY + (event.clientY - current.startClientY) / k,
      dropChapterId,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const onCardPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!current.moved) {
      handleCardClick(current.id, current.kind);
    } else if (current.kind === "scene" && current.dropChapterId) {
      assignSceneToChapter(current.id, current.dropChapterId, current);
    } else {
      commitPosition(current.id, current.x, current.y);
    }
  };

  const onCardPointerCancel = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, id: string, kind: CardKind) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleCardClick(id, kind);
    }
  };

  const cardHandlers = (box: CardBox) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onCardPointerDown(event, box),
    onPointerMove: onCardPointerMove,
    onPointerUp: onCardPointerUp,
    onPointerCancel: onCardPointerCancel,
    onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => onCardKeyDown(event, box.id, box.kind),
    role: "button",
    tabIndex: 0,
  });

  // 背景：1本指（マウス）で移動、2本指でピンチ拡大縮小
  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const pan = panRef.current;
    if (pan.pointers.size === 0) pan.travel = 0;
    pan.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pan.lastDist = null;
    pan.lastMid = null;
  };

  const onBackgroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const previous = pan.pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pan.pointers.set(event.pointerId, current);
    if (pan.pointers.size === 1) {
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      pan.travel += Math.abs(dx) + Math.abs(dy);
      setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    } else if (pan.pointers.size === 2) {
      const [a, b] = [...pan.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const lastDist = pan.lastDist;
      const lastMid = pan.lastMid;
      if (lastDist && lastMid && dist > 0) {
        const rect = event.currentTarget.getBoundingClientRect();
        setView((prev) => {
          const zoomed = zoomAround(mid.x - rect.left, mid.y - rect.top, dist / lastDist)(prev);
          return { ...zoomed, x: zoomed.x + mid.x - lastMid.x, y: zoomed.y + mid.y - lastMid.y };
        });
      }
      pan.lastDist = dist;
      pan.lastMid = mid;
      pan.travel += DRAG_THRESHOLD;
    }
  };

  const onBackgroundPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan.pointers.delete(event.pointerId)) return;
    pan.lastDist = null;
    pan.lastMid = null;
    if (pan.pointers.size === 0 && pan.travel < DRAG_THRESHOLD) {
      // 背景のクリックで選択を解除する
      setSelection(null);
      setConnectFrom(null);
    }
  };

  const onBackgroundDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const point = toCanvas(event.clientX, event.clientY);
    addNote({ x: point.x - NOTE_W / 2, y: point.y - NOTE_H / 2 });
  };

  // キーボード：Esc で解除、Delete でメモ・線を削除
  const deleteRef = useRef(deleteSelection);
  deleteRef.current = deleteSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select") || target.isContentEditable)) return;
      if (event.key === "Escape") {
        setConnectMode(false);
        setConnectFrom(null);
        setSelection(null);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        // 章・シーン・伏線は誤操作で消えないよう、パネルのボタンからだけ削除する
        const current = selectionRef.current;
        if (current && (current.kind === "note" || current.kind === "link")) {
          event.preventDefault();
          deleteRef.current();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 選択中のものが消えたら選択を外す
  useEffect(() => {
    if (!selection) return;
    const exists =
      selection.kind === "link"
        ? state.flow.links.some((link) => link.id === selection.id)
        : selection.kind === "note"
          ? state.flow.notes.some((note) => note.id === selection.id)
          : (state.lists[
              selection.kind === "chapter" ? "chapters" : selection.kind === "scene" ? "scenes" : "foreshadows"
            ] ?? []).some((item) => item.id === selection.id);
    if (!exists) setSelection(null);
  }, [selection, state]);

  // ---- 描画 ----

  // 線を描く SVG は、全カードと伏線の弧が収まる範囲に置く（範囲外は環境によってクリックできないため）
  const bounds = useMemo(() => {
    let minX = 0;
    let minY = 0;
    let maxX = 800;
    let maxY = 600;
    for (const box of layout.boxes.values()) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    return { x: minX - 400, y: minY - 400, w: maxX - minX + 800, h: maxY - minY + 800 };
  }, [layout]);

  const chapterEdges = layout.chapters.slice(0, -1).map(({ box }, index) => {
    const next = layout.chapters[index + 1].box;
    return {
      key: `${box.id}->${next.id}`,
      d: horizontalCurve(box.x + box.w, box.y + box.h / 2, next.x, next.y + next.h / 2),
    };
  });

  const sceneEdges: { key: string; d: string }[] = [];
  for (const { box: chapterBox } of layout.chapters) {
    const group = layout.scenesByChapter.get(chapterBox.id) ?? [];
    let previous = chapterBox;
    for (const { box } of group) {
      sceneEdges.push({
        key: `${previous.id}->${box.id}`,
        d: verticalCurve(previous.x + previous.w / 2, previous.y + previous.h, box.x + box.w / 2, box.y),
      });
      previous = box;
    }
  }

  const arcs = showForeshadows
    ? foreshadowInfo.arcs.map(({ item, index, from, to, lane }) => {
        const name = (item.values.name ?? "").trim() || `${foreshadowDef.itemLabel}${index + 1}`;
        const shift = (lane - 2) * 10;
        if (from && to) {
          const same = from.id === to.id;
          const x1 = from.x + from.w / 2 + (same ? -26 : shift);
          const x2 = to.x + to.w / 2 + (same ? 26 : shift);
          const y1 = from.y;
          const y2 = to.y;
          const top = Math.min(y1, y2) - (same ? 60 : 56) - lane * 26;
          return {
            id: item.id,
            name,
            d: `M${x1},${y1} C${x1},${top} ${x2},${top} ${x2},${y2}`,
            label: { x: (x1 + x2) / 2, y: (y1 + y2 + 6 * top) / 8 },
            arrow: true,
            warning: "",
          };
        }
        if (from) {
          const x1 = from.x + from.w / 2 + shift;
          const end = { x: x1 + 70, y: from.y - 64 - lane * 26 };
          return {
            id: item.id,
            name,
            d: `M${x1},${from.y} Q${x1},${end.y} ${end.x},${end.y}`,
            label: end,
            arrow: false,
            warning: "回収先未定",
          };
        }
        const x2 = to!.x + to!.w / 2 + shift;
        const start = { x: x2 - 70, y: to!.y - 64 - lane * 26 };
        return {
          id: item.id,
          name,
          d: `M${start.x},${start.y} Q${x2},${start.y} ${x2},${to!.y}`,
          label: start,
          arrow: true,
          warning: "初出未定",
        };
      })
    : [];

  const links = state.flow.links
    .map((link) => {
      const a = layout.boxes.get(link.from);
      const b = layout.boxes.get(link.to);
      if (!a || !b) return null;
      return {
        id: link.id,
        x1: a.x + a.w / 2,
        y1: a.y + a.h / 2,
        x2: b.x + b.w / 2,
        y2: b.y + b.h / 2,
      };
    })
    .filter((link): link is NonNullable<typeof link> => link !== null);

  const cardRing = (id: string) => {
    if (drag?.dropChapterId === id) return " ring-2 ring-emerald-400";
    if (connectFrom === id) return " ring-2 ring-sky-400";
    if (selection?.id === id) return " ring-2 ring-gold-400";
    return "";
  };

  const cardStyle = (box: CardBox) => ({
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    cursor: connectMode ? "crosshair" : "grab",
    zIndex: drag?.id === box.id ? 20 : undefined,
  });

  const done = chapters.filter((item) => {
    const status = state.flow.status[item.id];
    return status === "drafted" || status === "revised";
  }).length;
  const isEmpty = chapters.length === 0 && scenes.length === 0 && state.flow.notes.length === 0;

  // ---- 右パネル ----

  const renderFields = (
    sectionId: string,
    def: ListSectionDef,
    item: ListItem,
    selectOptions: Record<string, string[]> = {},
  ) =>
    def.fields.map((field) => (
      <FieldInput
        key={field.key}
        def={field.type === "select" && selectOptions[field.key] ? { ...field, options: selectOptions[field.key] } : field}
        value={item.values[field.key] ?? ""}
        onChange={(value) => updateItem(sectionId, item.id, field.key, value as string)}
      />
    ));

  const renderPanel = () => {
    if (!selection) return null;
    let title = "";
    let body: React.ReactNode = null;

    if (selection.kind === "chapter") {
      const index = chapters.findIndex((item) => item.id === selection.id);
      const item = chapters[index];
      if (!item) return null;
      const status = state.flow.status[item.id] ?? "todo";
      title = `${chapterDef.itemLabel}${index + 1}`;
      body = (
        <>
          <div>
            <span className="mb-1.5 block text-xs font-medium tracking-wide text-slate-400">執筆状況</span>
            <div className="flex flex-wrap gap-1.5">
              {CHAPTER_STATUSES.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  aria-pressed={status === def.id}
                  onClick={() => setStatus(item.id, def.id)}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                    (status === def.id
                      ? def.badge
                      : "border-night-600 bg-night-800 text-slate-500 hover:text-slate-300")
                  }
                >
                  {def.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={panelButton} disabled={index === 0} onClick={() => moveChapter(item.id, -1)}>
              ◀ 前へ
            </button>
            <button
              type="button"
              className={panelButton}
              disabled={index === chapters.length - 1}
              onClick={() => moveChapter(item.id, 1)}
            >
              次へ ▶
            </button>
            <button
              type="button"
              className={panelButton}
              onClick={() => addScene((item.values.title ?? "").trim())}
            >
              ＋ この{chapterDef.itemLabel}にシーン
            </button>
          </div>
          {renderFields("chapters", chapterDef, item)}
        </>
      );
    } else if (selection.kind === "scene") {
      const index = scenes.findIndex((item) => item.id === selection.id);
      const item = scenes[index];
      if (!item) return null;
      title = `${sceneDef.itemLabel}${index + 1}`;
      body = (
        <>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={panelButton} onClick={() => moveScene(item.id, -1)}>
              ↑ 前のシーンへ
            </button>
            <button type="button" className={panelButton} onClick={() => moveScene(item.id, 1)}>
              ↓ 次のシーンへ
            </button>
          </div>
          {renderFields("scenes", sceneDef, item, { chapter: chapterTitles })}
        </>
      );
    } else if (selection.kind === "foreshadow") {
      const index = foreshadows.findIndex((item) => item.id === selection.id);
      const item = foreshadows[index];
      if (!item) return null;
      title = `${foreshadowDef.itemLabel}${index + 1}`;
      body = renderFields("foreshadows", foreshadowDef, item, {
        introChapter: chapterTitles,
        payoffChapter: chapterTitles,
      });
    } else if (selection.kind === "note") {
      const note = state.flow.notes.find((entry) => entry.id === selection.id);
      if (!note) return null;
      title = "メモ";
      body = (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium tracking-wide text-slate-400">内容</span>
          <textarea
            autoFocus
            value={note.text}
            placeholder="アイデア、気になっている点、没ネタなど"
            onChange={(event) => {
              const text = event.target.value;
              setState((prev) => ({
                ...prev,
                flow: {
                  ...prev.flow,
                  notes: prev.flow.notes.map((entry) => (entry.id === note.id ? { ...entry, text } : entry)),
                },
              }));
            }}
            className="min-h-[9rem] w-full resize-y rounded-md border border-night-600 bg-night-900 px-3 py-2 text-sm leading-relaxed text-slate-200 placeholder:text-slate-500/70 focus:border-gold-400/60 focus:outline-none focus:ring-1 focus:ring-gold-400/40"
          />
        </label>
      );
    } else {
      title = "線";
      body = <p className="text-xs text-slate-400">カード同士を結ぶ線です。</p>;
    }

    return (
      <aside className="absolute inset-x-0 bottom-0 z-30 flex max-h-[60%] flex-col rounded-t-xl border-t border-night-600 bg-night-900/95 shadow-2xl shadow-black/50 backdrop-blur lg:static lg:max-h-none lg:w-80 lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0">
        <div className="flex items-center gap-2 border-b border-night-600/70 px-4 py-3">
          <h2 className="font-serif-jp mr-auto text-sm font-semibold tracking-wider text-slate-100">{title}</h2>
          <button type="button" className={deleteButton} onClick={deleteSelection}>
            削除
          </button>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => setSelection(null)}
            className="rounded px-2 py-1 text-sm text-slate-500 transition-colors hover:text-slate-200"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">{body}</div>
      </aside>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ツールバー */}
      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-night-600/70 bg-night-900/60 px-4 py-2 sm:flex-wrap [&>*]:shrink-0">
        <button type="button" className={toolButton} onClick={addChapter}>
          ＋ {chapterDef.itemLabel}
        </button>
        <button type="button" className={toolButton} onClick={() => addScene()}>
          ＋ シーン
        </button>
        <button type="button" className={toolButton} onClick={addForeshadow}>
          ＋ 伏線
        </button>
        <button type="button" className={toolButton} onClick={() => addNote()}>
          ＋ メモ
        </button>
        <span aria-hidden className="mx-1 hidden h-4 w-px bg-night-600 sm:block" />
        <button
          type="button"
          aria-pressed={connectMode}
          onClick={() => {
            setConnectMode((prev) => !prev);
            setConnectFrom(null);
          }}
          className={
            toolButton + (connectMode ? " border-sky-400/60 bg-sky-400/10 text-sky-300 hover:text-sky-300" : "")
          }
        >
          {connectMode ? (connectFrom ? "つなぐ先のカードを選択…" : "つなぐ元のカードを選択…") : "線でつなぐ"}
        </button>
        <button
          type="button"
          aria-pressed={showForeshadows}
          onClick={() => setShowForeshadows((prev) => !prev)}
          className={toolButton + (showForeshadows ? " text-violet-300" : " text-slate-500")}
        >
          伏線の線 {showForeshadows ? "ON" : "OFF"}
        </button>
        <button type="button" className={toolButton} onClick={autoArrange}>
          自動整列
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="縮小"
            className={toolButton}
            onClick={() => {
              const container = containerRef.current;
              if (container) setView(zoomAround(container.clientWidth / 2, container.clientHeight / 2, 1 / 1.2));
            }}
          >
            −
          </button>
          <span className="w-11 text-center text-[11px] text-slate-500">{Math.round(view.k * 100)}%</span>
          <button
            type="button"
            aria-label="拡大"
            className={toolButton}
            onClick={() => {
              const container = containerRef.current;
              if (container) setView(zoomAround(container.clientWidth / 2, container.clientHeight / 2, 1.2));
            }}
          >
            ＋
          </button>
          <button type="button" className={toolButton} onClick={() => fitView()}>
            全体表示
          </button>
        </div>
      </div>

      {/* 進み具合と未配置の伏線 */}
      {(chapters.length > 0 || foreshadowInfo.unplaced.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-night-600/70 px-4 py-1.5 text-[11px] text-slate-400">
          {chapters.length > 0 && (
            <span className="flex items-center gap-2">
              執筆
              <span className="inline-flex h-1.5 w-28 overflow-hidden rounded-full bg-night-700">
                {CHAPTER_STATUSES.slice(1).map((def) => {
                  const count = chapters.filter((item) => state.flow.status[item.id] === def.id).length;
                  return (
                    <span
                      key={def.id}
                      className={def.bar}
                      style={{ width: `${(count / chapters.length) * 100}%` }}
                    />
                  );
                })}
              </span>
              <span className="text-slate-300">
                {done}/{chapters.length}
                {chapterDef.itemLabel}書き上げ
              </span>
            </span>
          )}
          <span className="hidden items-center gap-2 sm:flex">
            {CHAPTER_STATUSES.map((def) => (
              <span key={def.id} className="flex items-center gap-1">
                <span className={`inline-block h-2 w-2 rounded-full ${def.bar}`} />
                {def.label}
              </span>
            ))}
          </span>
          {foreshadowInfo.unplaced.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-amber-300/90">
              ⚠ {chapterDef.itemLabel}に紐付いていない伏線:
              {foreshadowInfo.unplaced.map(({ item, index }) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelection({ kind: "foreshadow", id: item.id })}
                  className="rounded-full border border-amber-400/40 px-2 py-0.5 hover:bg-amber-400/10"
                >
                  {(item.values.name ?? "").trim() || `${foreshadowDef.itemLabel}${index + 1}`}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* キャンバス */}
        <div
          ref={containerRef}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onBackgroundPointerMove}
          onPointerUp={onBackgroundPointerUp}
          onPointerCancel={onBackgroundPointerUp}
          onDoubleClick={onBackgroundDoubleClick}
          className="relative min-w-0 flex-1 touch-none select-none overflow-hidden"
          style={{
            cursor: "grab",
            backgroundImage: "radial-gradient(circle, rgba(148,163,184,0.14) 1px, transparent 1px)",
            backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        >
          <div
            className="absolute left-0 top-0"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
          >
            <svg
              className="absolute"
              style={{ left: bounds.x, top: bounds.y, pointerEvents: "none", overflow: "visible" }}
              width={bounds.w}
              height={bounds.h}
            >
              <defs>
                <marker id="flow-arrow-gold" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#d4af6a" />
                </marker>
                <marker id="flow-arrow-slate" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
                </marker>
                <marker id="flow-arrow-violet" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#a78bfa" />
                </marker>
              </defs>
              <g transform={`translate(${-bounds.x}, ${-bounds.y})`}>
                {links.map((link) => {
                  const selected = selection?.kind === "link" && selection.id === link.id;
                  const d = `M${link.x1},${link.y1} L${link.x2},${link.y2}`;
                  return (
                    <g key={link.id}>
                      <path d={d} stroke={selected ? "#e8c882" : "#94a3b8"} strokeOpacity={selected ? 1 : 0.55} strokeWidth={selected ? 2.5 : 1.5} fill="none" />
                      <path
                        d={d}
                        stroke="transparent"
                        strokeWidth={16}
                        fill="none"
                        style={{ pointerEvents: "stroke", cursor: "pointer" }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          setSelection({ kind: "link", id: link.id });
                        }}
                      />
                    </g>
                  );
                })}
                {chapterEdges.map((edge) => (
                  <path key={edge.key} d={edge.d} stroke="#d4af6a" strokeOpacity={0.7} strokeWidth={2} fill="none" markerEnd="url(#flow-arrow-gold)" />
                ))}
                {sceneEdges.map((edge) => (
                  <path key={edge.key} d={edge.d} stroke="#64748b" strokeWidth={1.5} fill="none" markerEnd="url(#flow-arrow-slate)" />
                ))}
                {arcs.map((arc) => {
                  const selected = selection?.kind === "foreshadow" && selection.id === arc.id;
                  return (
                    <path
                      key={arc.id}
                      d={arc.d}
                      stroke={arc.warning ? "#fbbf24" : "#a78bfa"}
                      strokeOpacity={selected ? 1 : 0.65}
                      strokeWidth={selected ? 2.5 : 1.5}
                      strokeDasharray="6 5"
                      fill="none"
                      markerEnd={arc.arrow ? "url(#flow-arrow-violet)" : undefined}
                    />
                  );
                })}
              </g>
            </svg>

            {layout.looseLabel && (
              <div
                className="absolute whitespace-nowrap text-[11px] tracking-wider text-slate-500"
                style={{ left: layout.looseLabel.x, top: layout.looseLabel.y + 60, width: 224, textAlign: "center" }}
              >
                所属{chapterDef.itemLabel}なし
              </div>
            )}

            {layout.chapters.map(({ item, index, box }) => {
              const status = statusDef(state.flow.status[item.id]);
              const title = (item.values.title ?? "").trim();
              const sceneCount = layout.scenesByChapter.get(item.id)?.length ?? 0;
              const foreshadowCount = foreshadowInfo.perChapter.get(item.id) ?? 0;
              return (
                <div
                  key={item.id}
                  {...cardHandlers(box)}
                  aria-label={`${chapterDef.itemLabel}${index + 1} ${title}`}
                  className={`absolute flex flex-col overflow-hidden rounded-lg border bg-night-800 shadow-lg shadow-black/30 outline-none ${status.border}${cardRing(item.id)}`}
                  style={cardStyle(box)}
                >
                  <div className={`h-1 shrink-0 ${status.bar}`} />
                  <div className="flex items-center gap-2 px-3 pt-2">
                    <span className="text-[10px] tracking-wider text-gold-400/80">
                      {chapterDef.itemLabel}
                      {index + 1}
                    </span>
                    <span className={`ml-auto rounded-full border px-1.5 py-px text-[9px] ${status.badge}`}>
                      {status.label}
                    </span>
                  </div>
                  <p className="font-serif-jp truncate px-3 pt-0.5 text-sm font-semibold text-slate-100">
                    {title || <span className="text-slate-500">（タイトル未設定）</span>}
                  </p>
                  <p className="line-clamp-2 px-3 pt-0.5 text-[11px] leading-snug text-slate-400">
                    {(item.values.purpose ?? "").trim() || (item.values.events ?? "").trim()}
                  </p>
                  <p className="mt-auto px-3 pb-1.5 text-[10px] text-slate-500">
                    シーン {sceneCount} ・ 伏線 {foreshadowCount}
                  </p>
                </div>
              );
            })}

            {[...[...layout.scenesByChapter.values()].flat(), ...layout.looseScenes].map(({ item, index, box }) => {
              const title = (item.values.title ?? "").trim();
              const number = (item.values.number ?? "").trim();
              const detail = [item.values.place, item.values.characters]
                .map((value) => (value ?? "").trim())
                .filter(Boolean)
                .join(" ／ ");
              return (
                <div
                  key={item.id}
                  {...cardHandlers(box)}
                  aria-label={`${sceneDef.itemLabel} ${title}`}
                  className={`absolute flex flex-col justify-center overflow-hidden rounded-md border border-night-600 bg-night-900 px-3 shadow-md shadow-black/30 outline-none${cardRing(item.id)}`}
                  style={cardStyle(box)}
                >
                  <p className="truncate text-xs font-medium text-slate-200">
                    {number && <span className="mr-1.5 text-[10px] text-gold-400/80">{number}</span>}
                    {title || <span className="text-slate-500">{sceneDef.itemLabel}{index + 1}</span>}
                  </p>
                  {detail && <p className="mt-0.5 truncate text-[10px] text-slate-500">{detail}</p>}
                </div>
              );
            })}

            {layout.notes.map(({ id, text, box }) => (
              <div
                key={id}
                {...cardHandlers(box)}
                aria-label="メモ"
                className={`absolute overflow-hidden rounded-md border border-amber-300/30 bg-amber-200/10 px-3 py-2 shadow-md shadow-black/30 outline-none${cardRing(id)}`}
                style={cardStyle(box)}
              >
                <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-snug text-amber-100/90">
                  {text.trim() || <span className="text-amber-100/40">（空のメモ）</span>}
                </p>
              </div>
            ))}

            {arcs.map((arc) => {
              const selected = selection?.kind === "foreshadow" && selection.id === arc.id;
              return (
                <button
                  key={arc.id}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={() => setSelection({ kind: "foreshadow", id: arc.id })}
                  className={
                    "absolute max-w-[12rem] -translate-x-1/2 -translate-y-1/2 truncate rounded-full border bg-night-950 px-2 py-0.5 text-[10px] " +
                    (arc.warning
                      ? "border-amber-400/60 text-amber-300"
                      : "border-violet-400/50 text-violet-200") +
                    (selected ? " ring-2 ring-gold-400" : "")
                  }
                  style={{ left: arc.label.x, top: arc.label.y }}
                >
                  {arc.name}
                  {arc.warning && ` ／ ${arc.warning}`}
                </button>
              );
            })}
          </div>

          {isEmpty && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm leading-relaxed text-slate-500">
              まだカードがありません。
              <br />
              上の「＋ {chapterDef.itemLabel}」やメモで追加するか、設計書タブで{chapterDef.title}を入力してください。
            </div>
          )}

          <p className="pointer-events-none absolute bottom-2 left-3 hidden text-[10px] text-slate-600 sm:block">
            背景ドラッグで移動 ・ ホイール／ピンチで拡大縮小 ・ ダブルクリックでメモ ・ シーンを{chapterDef.itemLabel}カードに重ねると付け替え
          </p>
        </div>

        {renderPanel()}
      </div>
    </div>
  );
}
