/** 作品タイプ。セクション構成・テンプレート・厳守事項がこれで切り替わる */
export type Mode = "novel" | "rpg";

export type FieldType = "text" | "textarea" | "chips" | "select";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: string[];
}

/** 単一レコード型セクション（基本情報・世界観など） */
export interface RecordSectionDef {
  kind: "record";
  id: string;
  title: string;
  icon: string;
  fields: FieldDef[];
}

/** 複数アイテム型セクション（キャラクター・章・シーン・伏線） */
export interface ListSectionDef {
  kind: "list";
  id: string;
  title: string;
  icon: string;
  itemLabel: string;
  addLabel: string;
  /** アイテムの見出しに使うフィールドの key */
  titleKey: string;
  /** アイテムの見出し横にタグ表示するフィールドの key（例: シーンの所属章） */
  tagKey?: string;
  fields: FieldDef[];
}

export type SectionDef = RecordSectionDef | ListSectionDef;

export type RecordValues = Record<string, string | string[]>;

export interface ListItem {
  id: string;
  values: Record<string, string>;
}

/** 章の執筆状況（フローチャートで色分けする） */
export type ChapterStatus = "todo" | "writing" | "drafted" | "revised";

/** フローチャート上の自由メモ */
export interface FlowNote {
  id: string;
  text: string;
}

/** フローチャート上でカード同士を結ぶ自由な線（from/to は章・シーン・メモの id） */
export interface FlowLink {
  id: string;
  from: string;
  to: string;
}

/** フローチャート画面の状態。章・シーン・伏線の中身は lists 側にあり、ここは配置と進行だけを持つ */
export interface FlowState {
  /** 手動で動かしたカードの位置（キーは章・シーン・メモの id）。無いカードは自動配置 */
  positions: Record<string, { x: number; y: number }>;
  /** 章の執筆状況（キーは章の id）。無い章は未着手 */
  status: Record<string, ChapterStatus>;
  notes: FlowNote[];
  links: FlowLink[];
}

export interface AppState {
  /** 作品タイプ（省略時は novel として扱う） */
  mode: Mode;
  records: Record<string, RecordValues>;
  lists: Record<string, ListItem[]>;
  /** 出力プロンプトから除外するセクションの id */
  hiddenSections: string[];
  /** 出力テンプレート（フル設計書／企画用／執筆用／校正用）の id */
  template: string;
  /** フローチャート画面の配置・執筆状況・メモ */
  flow: FlowState;
}
