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

export interface AppState {
  records: Record<string, RecordValues>;
  lists: Record<string, ListItem[]>;
  /** 出力プロンプトから除外するセクションの id */
  hiddenSections: string[];
  /** 出力テンプレート（フル設計書／企画用／執筆用／校正用）の id */
  template: string;
}
