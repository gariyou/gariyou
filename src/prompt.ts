import { SECTIONS, STRICT_RULES } from "./schema";
import type { AppState, FieldDef, ListItem, RecordValues } from "./types";

const HEADER =
  "あなたは長編小説制作に特化した編集者兼プロ作家AIです。\n\n以下の設定資料をもとに、小説制作を進めてください。";

function fieldValueToText(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  return value.trim();
}

function formatFieldLine(field: FieldDef, value: string, markdown: boolean): string {
  const label = markdown ? `**${field.label}**` : field.label;
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

function recordBody(fields: FieldDef[], values: RecordValues, markdown: boolean): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    const text = fieldValueToText(values[field.key]);
    if (!text) continue;
    lines.push(formatFieldLine(field, text, markdown));
  }
  return lines;
}

function listBody(
  fields: FieldDef[],
  items: ListItem[],
  itemLabel: string,
  titleKey: string,
  markdown: boolean,
): string[] {
  const blocks: string[] = [];
  items.forEach((item, index) => {
    const lines = recordBody(fields, item.values, markdown);
    if (lines.length === 0) return;
    const name = (item.values[titleKey] ?? "").trim();
    const heading = `${itemLabel}${index + 1}${name ? `：${name}` : ""}`;
    const headingLine = markdown ? `### ${heading}` : `【${heading}】`;
    blocks.push([headingLine, ...lines].join("\n"));
  });
  return blocks;
}

/** 入力状態から完成プロンプトを組み立てる。未入力の項目・セクションは省略する。 */
export function buildPrompt(state: AppState, markdown: boolean): string {
  const parts: string[] = [HEADER];
  const hidden = new Set(state.hiddenSections ?? []);

  for (const section of SECTIONS) {
    if (hidden.has(section.id)) continue;
    let body: string[];
    if (section.kind === "record") {
      body = recordBody(section.fields, state.records[section.id] ?? {}, markdown);
    } else {
      body = listBody(
        section.fields,
        state.lists[section.id] ?? [],
        section.itemLabel,
        section.titleKey,
        markdown,
      );
    }
    if (body.length === 0) continue;
    const title = markdown ? `## ${section.title}` : `■ ${section.title}`;
    const separator = section.kind === "list" ? "\n\n" : "\n";
    parts.push(`${title}\n\n${body.join(separator)}`);
  }

  const strictTitle = markdown ? "## 厳守事項" : "■ 厳守事項";
  parts.push(`${strictTitle}\n\n${STRICT_RULES.map((rule) => `- ${rule}`).join("\n")}`);

  return parts.join("\n\n");
}
