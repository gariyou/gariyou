import { useEffect, useRef, useState } from "react";
import type { AppState } from "./types";

/**
 * 作品フォルダ（例: novels/作品名/）の 設定.json とアプリを連動させる。
 * Claude（Cowork / Claude Code）が書き換えたらアプリに読み込み、アプリで編集したら書き戻す。
 * File System Access API を使うため、パソコンの Chrome / Edge でだけ動く。
 */

export const SETTINGS_FILE = "設定.json";

// File System Access API のうち、TypeScript の DOM 型定義にまだ無い部分
type PermissionMode = { mode: "readwrite" };
interface PermissionHandle {
  queryPermission?: (descriptor: PermissionMode) => Promise<PermissionState>;
  requestPermission?: (descriptor: PermissionMode) => Promise<PermissionState>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function folderSyncSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

// ---- 連動先フォルダの記憶（フォルダのハンドルは localStorage に入らないので IndexedDB に保存する） ----

const DB_NAME = "ai-novel-prompt-builder";
const STORE = "folders";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

const saveFolderHandle = (projectId: string, handle: FileSystemDirectoryHandle) =>
  withStore("readwrite", (store) => store.put(handle, projectId));

const loadFolderHandle = (projectId: string) =>
  withStore<FileSystemDirectoryHandle>("readonly", (store) => store.get(projectId));

export const forgetFolderHandle = (projectId: string) =>
  withStore("readwrite", (store) => store.delete(projectId));

// ---- 設定.json の読み書き ----

async function readSettings(
  dir: FileSystemDirectoryHandle,
): Promise<{ text: string; lastModified: number } | null> {
  try {
    const file = await (await dir.getFileHandle(SETTINGS_FILE)).getFile();
    return { text: await file.text(), lastModified: file.lastModified };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function writeSettings(dir: FileSystemDirectoryHandle, text: string): Promise<number> {
  const handle = await dir.getFileHandle(SETTINGS_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return (await handle.getFile()).lastModified;
}

async function hasPermission(dir: FileSystemDirectoryHandle, request: boolean): Promise<boolean> {
  const handle = dir as FileSystemDirectoryHandle & PermissionHandle;
  const descriptor: PermissionMode = { mode: "readwrite" };
  // 権限APIが無いブラウザでは、読み書きの時点で失敗するまで使えるものとして扱う
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission(descriptor)) === "granted") return true;
  if (!request || !handle.requestPermission) return false;
  return (await handle.requestPermission(descriptor)) === "granted";
}

const serialize = (state: AppState) => JSON.stringify(state, null, 2);

/** ファイルを見に行く間隔 */
const POLL_MS = 2000;
/** 編集してから書き戻すまでの待ち時間 */
const WRITE_DELAY_MS = 800;

export type SyncStatus = "off" | "linked" | "needs-permission";

interface Options {
  projectId: string;
  state: AppState;
  /** 設定.json の中身をアプリの状態に変換する（壊れていれば例外を投げる） */
  parse: (text: string) => AppState;
  /** 読み込んだ状態を画面に反映する。"link" はユーザーが連動を始めたとき、"sync" は自動の読み込み */
  apply: (next: AppState, reason: "link" | "sync") => void;
  /** 今の作品に何か入力されているか（連動開始時に入れ替えてよいか確認するため） */
  hasContent: boolean;
}

export function useFolderSync({ projectId, state, parse, apply, hasContent }: Options) {
  const supported = folderSyncSupported();
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [status, setStatus] = useState<SyncStatus>("off");
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** 最後に読み書きした内容と更新時刻。自分の書き込みを外部の変更と取り違えないために使う */
  const lastText = useRef<string | null>(null);
  const lastModified = useRef<number | null>(null);
  /** 最初の読み込みが済むまでは書き戻さない（ファイルを今の画面の内容で潰さないため） */
  const ready = useRef(false);
  /** ファイル操作は1つずつ順番に行う */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const stateRef = useRef(state);
  stateRef.current = state;
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => (current === text ? null : current)), 8000);
  };

  const run = (operation: () => Promise<unknown>) => {
    queue.current = queue.current.then(operation).catch((error: unknown) => {
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        ready.current = false;
        setStatus("needs-permission");
        notify("フォルダへのアクセス許可が切れました。「再接続」を押してください");
      } else {
        notify(`${SETTINGS_FILE} の読み書きに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  /** 設定.json が変わっていれば読み込んで画面に反映する。ファイルが無ければ false */
  const pull = async (dir: FileSystemDirectoryHandle, force = false): Promise<boolean> => {
    const file = await readSettings(dir);
    if (!file) return false;
    if (!force && file.lastModified === lastModified.current) return true;
    if (file.text === lastText.current) {
      lastModified.current = file.lastModified;
      return true;
    }
    let next: AppState;
    try {
      next = parseRef.current(file.text);
    } catch {
      // 書き込みの途中を読んだ可能性があるので、更新時刻は記録せず次の確認で読み直す
      notify(`${SETTINGS_FILE} を読み込めませんでした（JSONの形式が壊れています）`);
      return true;
    }
    lastModified.current = file.lastModified;
    lastText.current = serialize(next);
    applyRef.current(next, "sync");
    setLastSyncAt(new Date());
    return true;
  };

  const push = async (dir: FileSystemDirectoryHandle) => {
    const text = serialize(stateRef.current);
    if (text === lastText.current) return;
    const current = await readSettings(dir);
    if (current && lastModified.current !== null && current.lastModified !== lastModified.current) {
      // 書き戻す前に外で書き換えられていたら、そちらを優先する
      await pull(dir, true);
      notify(`${SETTINGS_FILE} が外部（Claude など）で更新されていたため、そちらを読み込みました`);
      return;
    }
    lastModified.current = await writeSettings(dir, text);
    lastText.current = text;
    setLastSyncAt(new Date());
  };

  /** 連動の開始・再開時：ファイルがあれば読み込み、無ければ今の内容で作る */
  const start = (dir: FileSystemDirectoryHandle) => {
    ready.current = false;
    lastText.current = null;
    lastModified.current = null;
    run(async () => {
      const exists = await pull(dir, true);
      if (!exists) {
        lastModified.current = await writeSettings(dir, serialize(stateRef.current));
        lastText.current = serialize(stateRef.current);
        setLastSyncAt(new Date());
      }
      ready.current = true;
    });
  };

  // 作品を切り替えたら、その作品の連動先を復元する
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    setHandle(null);
    setStatus("off");
    setLastSyncAt(null);
    if (!supported) return;
    (async () => {
      const saved = await loadFolderHandle(projectId);
      if (cancelled || !saved) return;
      setHandle(saved);
      // 再読み込み後は、ブラウザの仕様でボタン操作からしか許可を求められないことがある
      if (await hasPermission(saved, false)) {
        if (cancelled) return;
        setStatus("linked");
        start(saved);
      } else if (!cancelled) {
        setStatus("needs-permission");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, supported]);

  // 定期的にファイルの変更を確認する
  useEffect(() => {
    if (status !== "linked" || !handle) return;
    const timer = window.setInterval(() => {
      if (ready.current) run(() => pull(handle));
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, handle]);

  // アプリで編集したら、少し待ってから書き戻す
  useEffect(() => {
    if (status !== "linked" || !handle || !ready.current) return;
    if (serialize(state) === lastText.current) return;
    const timer = window.setTimeout(() => run(() => push(handle)), WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state, status, handle]);

  /** フォルダを選んで連動を始める（ボタン操作から呼ぶ） */
  const link = async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker!({ id: "novel-folder", mode: "readwrite" });
    } catch {
      return; // キャンセル
    }
    if (!(await hasPermission(dir, true))) {
      window.alert("フォルダへの書き込みが許可されなかったため、連動できません。");
      return;
    }
    let file: Awaited<ReturnType<typeof readSettings>>;
    try {
      file = await readSettings(dir);
    } catch (error) {
      window.alert(`${SETTINGS_FILE} を読めませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (file) {
      let next: AppState;
      try {
        next = parseRef.current(file.text);
      } catch {
        window.alert(`「${dir.name}」の ${SETTINGS_FILE} はJSONの形式が壊れているため読み込めません。`);
        return;
      }
      const load =
        !hasContent ||
        window.confirm(
          `「${dir.name}」の ${SETTINGS_FILE} を読み込み、この作品の内容と入れ替えます。よろしいですか？\n（今の内容はバックアップされ、「バックアップを復元」で戻せます）`,
        );
      if (load) {
        lastText.current = serialize(next);
        lastModified.current = file.lastModified;
        applyRef.current(next, "link");
      } else if (
        window.confirm(`代わりに、この作品の今の内容で「${dir.name}」の ${SETTINGS_FILE} を上書きしますか？`)
      ) {
        lastModified.current = await writeSettings(dir, serialize(stateRef.current));
        lastText.current = serialize(stateRef.current);
      } else {
        return;
      }
    } else {
      lastModified.current = await writeSettings(dir, serialize(stateRef.current));
      lastText.current = serialize(stateRef.current);
    }
    await saveFolderHandle(projectId, dir);
    setHandle(dir);
    setStatus("linked");
    setLastSyncAt(new Date());
    ready.current = true;
    notify(`「${dir.name}」の ${SETTINGS_FILE} と連動しました`);
  };

  /** 再読み込み後などに、アクセス許可を取り直して連動を再開する（ボタン操作から呼ぶ） */
  const reconnect = async () => {
    if (!handle) return;
    try {
      if (!(await hasPermission(handle, true))) return;
    } catch {
      notify("フォルダが見つかりません。もう一度「作品フォルダと連動」で選び直してください");
      return;
    }
    setStatus("linked");
    start(handle);
  };

  const unlink = async () => {
    await forgetFolderHandle(projectId);
    ready.current = false;
    setHandle(null);
    setStatus("off");
    setLastSyncAt(null);
  };

  return {
    supported,
    status,
    folderName: handle?.name ?? "",
    lastSyncAt,
    message,
    link,
    reconnect,
    unlink,
  };
}
