/**
 * チェックメモ — Google Apps Script サーバー側
 *
 * データは自分の Google ドライブの「チェックメモ」フォルダ内の
 * checkmemo-data.json に保存される。
 * クライアントは「操作(op)」の配列を送り、サーバーはロックを取って
 * 最新ファイルに操作を適用してから保存する。複数端末から同時に
 * 触っても上書きで消えないようにするための作り。
 */

var FOLDER_NAME = 'チェックメモ';
var FILE_NAME = 'checkmemo-data.json';

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('チェックメモ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setFaviconUrl('https://fonts.gstatic.com/s/i/materialiconsround/check_circle/v6/24px.svg');
}

/** クライアントと共有する操作ロジックのソース(テンプレートから埋め込む) */
function sharedSource() {
  return [emptyData_, applyOp_].map(function (f) { return f.toString(); }).join('\n');
}

/** 現在のデータを取得 */
function loadData() {
  return readData_(getFile_());
}

/** 操作をまとめて適用して保存し、最新データを返す */
function applyOps(ops) {
  var lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    var file = getFile_();
    var data = readData_(file);
    (ops || []).forEach(function (op) { applyOp_(data, op); });
    data.updatedAt = new Date().toISOString();
    file.setContent(JSON.stringify(data));
    return data;
  } finally {
    lock.releaseLock();
  }
}

/** ドライブ上のファイルの場所(URL)を返す */
function getFileUrl() {
  return getFile_().getUrl();
}

// ---------------------------------------------------------------------------

function getFile_() {
  var props = PropertiesService.getUserProperties();
  var id = props.getProperty('fileId');
  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 消された等 → 作り直す */ }
  }
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
  var files = folder.getFilesByName(FILE_NAME);
  var file = files.hasNext()
    ? files.next()
    : folder.createFile(FILE_NAME, JSON.stringify(emptyData_()), 'application/json');
  props.setProperty('fileId', file.getId());
  return file;
}

function readData_(file) {
  var text = file.getBlob().getDataAsString('UTF-8');
  var data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data || !data.lists) data = emptyData_();
  if (!data.tasks) data.tasks = [];
  if (!data.done) data.done = [];
  if (!data.lists.length) data.lists = emptyData_().lists;
  return data;
}

// ---- ここから下の2関数はクライアントでも同じものが動く ----------------------

function emptyData_() {
  return {
    version: 1,
    lists: [{ id: 'default', name: 'メモ' }],
    tasks: [],
    done: [],
    updatedAt: null
  };
}

function applyOp_(data, op) {
  function idx(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return i;
    return -1;
  }
  var i;
  switch (op.type) {
    case 'add':
      if (idx(data.tasks, op.id) < 0 && idx(data.done, op.id) < 0) {
        data.tasks.push({ id: op.id, listId: op.listId, text: op.text, createdAt: op.at });
      }
      break;
    case 'check':
      i = idx(data.tasks, op.id);
      if (i >= 0) {
        var t = data.tasks.splice(i, 1)[0];
        t.doneAt = op.at;
        data.done.unshift(t);
      }
      break;
    case 'uncheck':
      i = idx(data.done, op.id);
      if (i >= 0) {
        var d = data.done.splice(i, 1)[0];
        delete d.doneAt;
        data.tasks.push(d);
      }
      break;
    case 'edit':
      i = idx(data.tasks, op.id);
      if (i >= 0) data.tasks[i].text = op.text;
      else if ((i = idx(data.done, op.id)) >= 0) data.done[i].text = op.text;
      break;
    case 'delete':
      if ((i = idx(data.tasks, op.id)) >= 0) data.tasks.splice(i, 1);
      else if ((i = idx(data.done, op.id)) >= 0) data.done.splice(i, 1);
      break;
    case 'move':
      // op.ids: そのリストの未完了タスクの新しい並び順
      var order = {};
      op.ids.forEach(function (id, n) { order[id] = n; });
      var mine = data.tasks.filter(function (x) { return x.id in order; })
        .sort(function (a, b) { return order[a.id] - order[b.id]; });
      var k = 0;
      data.tasks = data.tasks.map(function (x) { return x.id in order ? mine[k++] : x; });
      break;
    case 'clearDone':
      data.done = data.done.filter(function (x) { return op.listId && x.listId !== op.listId; });
      break;
    case 'addList':
      if (idx(data.lists, op.id) < 0) data.lists.push({ id: op.id, name: op.name });
      break;
    case 'renameList':
      if ((i = idx(data.lists, op.id)) >= 0) data.lists[i].name = op.name;
      break;
    case 'deleteList':
      if (data.lists.length > 1 && (i = idx(data.lists, op.id)) >= 0) {
        data.lists.splice(i, 1);
        data.tasks = data.tasks.filter(function (x) { return x.listId !== op.id; });
        data.done = data.done.filter(function (x) { return x.listId !== op.id; });
      }
      break;
  }
  return data;
}
