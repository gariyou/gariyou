import { SECTIONS, STRICT_RULES } from "./schema";
import { TEMPLATES } from "./templates";
import { chapterTitleList } from "./utils";
import type { AppState, FieldDef, ListItem, ListSectionDef, RecordValues } from "./types";

/** 出力形式。plain=汎用テキスト、markdown=ChatGPT/Cursor向け、xml=Claude向けのタグ構造 */
export type PromptFormat = "plain" | "markdown" | "xml";

function fieldValueToText(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  return value.trim();
}

function formatFieldLine(field: FieldDef, value: string, format: PromptFormat): string {
  if (format === "xml") {
    return value.includes("\n") ? `${field.label}:\n${value}` : `${field.label}: ${value}`;
  }
  const label = format === "markdown" ? `**${field.label}**` : field.label;
  if (value.includes("\n")) {
    // 複数行の値は折り返してインデントする
    const indented = value
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return `- ${label}:\n${indented}`;
  }
  return `- ${label}: ${value}`;
}

function recordBody(
  fields: FieldDef[],
  values: RecordValues,
  format: PromptFormat,
  skipKeys?: Set<string>,
): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    if (skipKeys?.has(field.key)) continue;
    const text = fieldValueToText(values[field.key]);
    if (!text) continue;
    lines.push(formatFieldLine(field, text, format));
  }
  return lines;
}

function itemBlock(
  section: ListSectionDef,
  item: ListItem,
  index: number,
  format: PromptFormat,
  headingLevel: number,
  skipKeys?: Set<string>,
): string | null {
  const lines = recordBody(section.fields, item.values, format, skipKeys);
  if (lines.length === 0) return null;
  if (format === "xml") {
    const tag = `${section.itemLabel}${index + 1}`;
    return `<${tag}>\n${lines.join("\n")}\n</${tag}>`;
  }
  const name = (item.values[section.titleKey] ?? "").trim();
  const heading = `${section.itemLabel}${index + 1}${name ? `：${name}` : ""}`;
  const headingLine =
    format === "markdown" ? `${"#".repeat(headingLevel)} ${heading}` : `【${heading}】`;
  return [headingLine, ...lines].join("\n");
}

function listBody(section: ListSectionDef, items: ListItem[], format: PromptFormat): string[] {
  const blocks: string[] = [];
  items.forEach((item, index) => {
    const block = itemBlock(section, item, index, format, 3);
    if (block) blocks.push(block);
  });
  return blocks;
}

/** シーンは「所属章」が使われていれば章ごとにまとめて出力する */
function scenesBody(
  section: ListSectionDef,
  items: ListItem[],
  format: PromptFormat,
  chapterTitles: string[],
): string[] {
  const anyLinked = items.some((item) => (item.values.chapter ?? "").trim() !== "");
  if (!anyLinked) return listBody(section, items, format);

  const groups = new Map<string, { item: ListItem; index: number }[]>();
  items.forEach((item, index) => {
    const chapter = (item.values.chapter ?? "").trim();
    const entries = groups.get(chapter) ?? [];
    entries.push({ item, index });
    groups.set(chapter, entries);
  });

  // 章構成の順 → 章構成に無い章名（改名・削除の名残）→ 未設定、の順で並べる
  const known = chapterTitles.filter((title) => groups.has(title));
  const stale = [...groups.keys()].filter((name) => name && !chapterTitles.includes(name));
  const orderedNames = [...known, ...stale, ...(groups.has("") ? [""] : [])];

  // グルーピング時は各シーン内の「所属章」行は冗長なので省く
  const skipKeys = new Set(["chapter"]);
  const blocks: string[] = [];
  for (const name of orderedNames) {
    const entries = groups.get(name) ?? [];
    const itemBlocks = entries
      .map(({ item, index }) => itemBlock(section, item, index, format, 4, skipKeys))
      .filter((block): block is string => block !== null);
    if (itemBlocks.length === 0) continue;
    const groupLabel = name || "（所属章未設定）";
    const headingLine = format === "markdown" ? `### ${groupLabel}` : `◆ ${groupLabel}`;
    blocks.push([headingLine, ...itemBlocks].join("\n\n"));
  }
  return blocks;
}

function wrapSection(
  title: string,
  body: string[],
  format: PromptFormat,
  blockSpacing: boolean,
): string {
  const joined = body.join(blockSpacing ? "\n\n" : "\n");
  if (format === "xml") return `<${title}>\n${joined}\n</${title}>`;
  const heading = format === "markdown" ? `## ${title}` : `■ ${title}`;
  return `${heading}\n\n${joined}`;
}

/** 入力状態から完成プロンプトを組み立てる。未入力の項目・セクションは省略する。 */
export function buildPrompt(state: AppState, format: PromptFormat): string {
  const template = TEMPLATES.find((t) => t.id === state.template) ?? TEMPLATES[0];
  const hidden = new Set(state.hiddenSections ?? []);
  const chapterTitles = chapterTitleList(state);

  const sectionParts: string[] = [];
  for (const section of SECTIONS) {
    if (hidden.has(section.id)) continue;
    let body: string[];
    if (section.kind === "record") {
      body = recordBody(section.fields, state.records[section.id] ?? {}, format);
    } else if (section.id === "scenes") {
      body = scenesBody(section, state.lists[section.id] ?? [], format, chapterTitles);
    } else {
      body = listBody(section, state.lists[section.id] ?? [], format);
    }
    if (body.length === 0) continue;
    sectionParts.push(wrapSection(section.title, body, format, section.kind === "list"));
  }

  const parts: string[] = [template.intro];
  if (format === "xml" && sectionParts.length > 0) {
    parts.push(`<設定資料>\n\n${sectionParts.join("\n\n")}\n\n</設定資料>`);
  } else {
    parts.push(...sectionParts);
  }
  if (template.request) {
    parts.push(wrapSection("今回の依頼", [template.request], format, false));
  }
  parts.push(
    wrapSection(
      "厳守事項",
      STRICT_RULES.map((rule) => `- ${rule}`),
      format,
      false,
    ),
  );

  return parts.join("\n\n");
}

/** 日本語はおおむね1文字≒1.1トークンとして概算する */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 1.1);
}
