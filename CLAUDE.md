# AI Novel Prompt Builder

小説・RPGの「構築プロンプト（設計書）」を作る、ブラウザだけで完結するアプリ（React + TypeScript + Tailwind CSS v4 + Vite）と、同じ設計書を対話で作って本文執筆まで進める Claude スキル `novel-prompt` のリポジトリ。UI文言・生成されるプロンプト・スキルはすべて日本語。

`main` ブランチは無く、`claude/novel-prompt-builder-app-d7kdcs` が本流。PR はここへ向ける。

## コマンド

- `npm run dev` — 開発サーバー
- `npm run build` — 型チェック（`tsc -b`）と、単一ファイル `dist/index.html` へのビルド。テストとリンターは無いので、コードを変えたらこれで確かめる

## 構成

- `src/schema.ts` — 小説（`NOVEL_SECTIONS`）と RPG（`RPG_SECTIONS`）のセクション・フィールド定義、厳守事項（`getStrictRules`）
- `src/templates.ts` — テンプレート（フル／企画／執筆／校正）ごとの冒頭文と「今回の依頼」
- `src/prompt.ts` — 完成プロンプトの組み立て（テキスト／Markdown／XML）
- `src/App.tsx`・`src/storage.ts` — localStorage への保存、複数作品の管理、JSON の入出力（`mergeState`）
- `src/flow.ts`・`src/components/FlowBoard.tsx` — フローチャート画面（カードの自動配置、執筆状況、メモと線）。状態は `AppState.flow`
- `src/folderSync.ts` — 作品フォルダの `設定.json` との連動（File System Access API。連動先のフォルダは IndexedDB に記憶）
- `.claude/skills/novel-prompt/` — スキル本体（`SKILL.md`）と `references/`

## スキルとアプリの同期

スキルの `references/` はアプリの仕様を手で写したものなので、アプリ側を変えたら同じ変更で直す。

- `src/schema.ts` のセクションid・フィールドkey・チップ項目、`src/types.ts` の `FlowState` → `references/app-json-format.md`
- `src/schema.ts` の厳守事項、`src/templates.ts` の冒頭文・依頼文、`src/prompt.ts` の出力形式 → `references/prompt-format.md`

スキルは claude.ai にもアップロードして使っている。スキルを変えたらマージ後に README の手順で zip を作り直し、再アップロードする（しないと claude.ai 側に古い版が残る）。
