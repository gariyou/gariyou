# AI Novel Prompt Builder アプリ互換JSON仕様

このJSONはアプリの「JSONをインポート」でそのまま取り込める。**キー名は下記と完全一致させること**（アプリは未知のキーを無視し、欠けたキーは空欄として扱う）。

## トップレベル構造

```json
{
  "records": { ... },
  "lists": { ... },
  "hiddenSections": [],
  "template": "full"
}
```

- `hiddenSections`: 出力から除外するセクションid の配列。通常は `[]`
- `template`: `"full"`（フル設計書）/ `"planning"`（企画用）/ `"writing"`（執筆用）/ `"review"`（校正用）

## records（単一入力セクション）

値はすべて文字列。複数行は `\n` 区切り。`media`・`emphasis`・`tasks` のみ**文字列の配列**。

```json
"records": {
  "basic": {
    "title": "作品タイトル", "tentativeTitle": "仮タイトル",
    "genre": "ジャンル", "subGenre": "サブジャンル",
    "audience": "対象読者",
    "media": ["Web小説"],
    "length": "想定文字数", "episodes": "想定話数",
    "concept": "一言コンセプト", "selling": "作品の売り"
  },
  "tone": {
    "style": "文体", "mood": "雰囲気", "aftertaste": "読後感",
    "emphasis": ["キャラクター", "ストーリー"],
    "reference": "参考にしたい作風", "avoid": "避けたい作風",
    "ng": "NG表現", "rules": "AIに守らせたい文章ルール"
  },
  "world": {
    "stage": "舞台", "era": "時代", "civilization": "文明レベル",
    "magic": "魔法・異能・科学技術", "nations": "国家・組織",
    "classes": "身分制度", "religion": "宗教", "economy": "経済",
    "systems": "主要システム", "commonSense": "世界の常識",
    "contradictions": "世界の矛盾や問題点", "start": "物語開始時点の状況"
  },
  "protagonist": {
    "name": "名前", "age": "年齢", "gender": "性別", "appearance": "外見",
    "position": "立場", "personality": "性格", "desire": "欲望",
    "weakness": "弱点", "secret": "秘密", "ability": "能力",
    "initial": "初期状態", "change": "最終的な変化",
    "presentation": "読者にどう見せたいか", "charm": "魅力", "flaw": "欠点"
  },
  "conflict": {
    "boss": "最大の敵", "midBoss": "中ボス", "organization": "敵組織",
    "reason": "対立理由", "ideology": "思想の対立", "interest": "利害の対立",
    "emotion": "感情の対立", "finalBattle": "最終決戦の構図"
  },
  "story": {
    "incident": "物語開始時の事件", "act1": "第一幕", "act2": "第二幕",
    "act3": "第三幕", "climax": "クライマックス", "ending": "エンディング",
    "twist": "どんでん返し", "growth": "主人公の成長曲線",
    "others": "ヒロインや仲間の変化", "theme": "物語全体のテーマ"
  },
  "instructions": {
    "tasks": ["プロット作成", "本文執筆"],
    "format": "出力形式", "count": "文字数", "style": "文体指定",
    "checks": "チェックしてほしい点", "mustRules": "絶対に守るルール",
    "forbidden": "やってはいけないこと"
  }
}
```

チップ項目の定番値（これ以外の自由な文字列も可）:

- `media`: Web小説 / ライトノベル / 一般文芸 / 成人向け / ゲームシナリオ / 漫画原作
- `emphasis`: キャラクター / 世界観 / ストーリー / 会話 / バトル / 恋愛 / 心理描写 / 成り上がり / ざまぁ / ダークさ / 官能性
- `tasks`: 企画作成 / プロット作成 / 章構成作成 / シーン作成 / 本文執筆 / リライト / 矛盾チェック / キャラ口調チェック / 伏線チェック

## lists（複数アイテムセクション）

各アイテムは `{ "id": "任意の一意な文字列", "values": { ... } }`。値はすべて文字列。

```json
"lists": {
  "characters": [
    { "id": "c1", "values": {
      "name": "名前", "role": "役割", "age": "年齢", "gender": "性別",
      "appearance": "外見", "personality": "性格", "goal": "目的",
      "relation": "主人公との関係", "ability": "能力", "secret": "秘密",
      "speech": "口調", "storyRole": "物語上の役割", "change": "最終的な変化"
    } }
  ],
  "chapters": [
    { "id": "ch1", "values": {
      "title": "章タイトル", "purpose": "章の目的", "start": "開始状況",
      "events": "主な事件", "highlight": "見せ場", "end": "終了状況",
      "hook": "次章への引き"
    } }
  ],
  "scenes": [
    { "id": "s1", "values": {
      "number": "1-1", "title": "シーンタイトル", "chapter": "所属章",
      "characters": "登場人物", "place": "場所", "purpose": "目的",
      "events": "起きる出来事", "emotion": "感情の変化",
      "impression": "読者に与えたい印象", "hook": "次シーンへの引き"
    } }
  ],
  "foreshadows": [
    { "id": "f1", "values": {
      "name": "伏線名", "intro": "初出", "introChapter": "初出の章",
      "presentation": "読者への見せ方", "truth": "真相",
      "payoff": "回収予定", "payoffChapter": "回収の章", "effect": "回収時の効果"
    } }
  ]
}
```

## 重要な整合性ルール

1. `scenes[].values.chapter`・`foreshadows[].values.introChapter`・`foreshadows[].values.payoffChapter` は、**`chapters[].values.title` のいずれかと一字一句同じ文字列**にすること（アプリはこの文字列一致で章と紐付け、シーンの章別グルーピングと伏線の未回収警告を行う）
2. `foreshadows` の `payoffChapter` が空だとアプリで「回収の章が未設定」警告が出る。伏線を作るときは必ず回収の章まで決める
3. 未入力の項目は空文字 `""`（または省略）でよい。アプリ側で自動的に出力から省かれる
4. `id` はアイテムごとに一意なら何でもよい（例: "c1", "ch1", "s1", "f1" の連番）
