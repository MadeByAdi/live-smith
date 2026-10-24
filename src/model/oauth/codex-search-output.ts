import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Nodes } from "mdast";

import { normalizeModelCitations } from "../citations.js";
import type { ModelCitation } from "../contracts.js";
import { isRecord } from "./oauth-utils.js";

/** Resolve search-local references before independent searches can reuse their IDs. */
export function normalizeCodexSearchOutput(output: string, results: readonly unknown[]): {
  content: string;
  sources: ModelCitation[];
} {
  const records = results.filter(isRecord).filter(item => item.type === "text_result");
  const sources = normalizeModelCitations(records);
  const acceptedUrls = new Set(sources.map(source => source.url));
  const references = new Map<string, ModelCitation>();
  for (const record of records) {
    if (typeof record.ref_id !== "string" || !record.ref_id) continue;
    const source = normalizeModelCitations([record])[0];
    if (source && acceptedUrls.has(source.url)) references.set(record.ref_id, source);
  }

  const parts: string[] = [];
  let cursor = 0;
  function visit(node: Nodes): void {
    if (node.type === "text") {
      // Parser-provided offsets retain the original Markdown and reference labels.
      const start = node.position!.start.offset!;
      const end = node.position!.end.offset!;
      const original = output.slice(start, end);
      const content = original.replace(/\uE200cite\uE202([^\uE201\r\n]*)\uE201|【([^】\r\n]+)】/gu, (raw, citationIds, headerId, offset: number) => {
        let expanded: string;
        if (citationIds !== undefined) {
          expanded = normalizeModelCitations(
            citationIds.split("\uE202").map((id: string) => references.get(id)),
          ).map(markdownSourceLink).join(" ");
        } else {
          const source = references.get(headerId);
          if (!source) return raw;
          expanded = markdownSourceLink(source);
        }
        return expanded && offset > 0 && !/\s/u.test(original[offset - 1]!)
          ? ` ${expanded}` : expanded;
      });
      parts.push(output.slice(cursor, start), content);
      cursor = end;
    } else if ("children" in node && node.type !== "link" && node.type !== "linkReference") {
      node.children.forEach(visit);
    }
  }
  visit(fromMarkdown(output, {
    extensions: [gfmStrikethrough(), gfmTable()],
    mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown()],
  }));
  parts.push(output.slice(cursor));
  return { content: parts.join(""), sources };
}

function markdownSourceLink(source: ModelCitation): string {
  return `[${markdownLiteral(source.title)}](<${markdownLiteral(source.url)}>)`;
}

function markdownLiteral(value: string): string {
  // Keep punctuation and protocol symbols literal through Markdown and HTML parsing.
  return value.replace(/[^\p{L}\p{N} ]/gu,
    character => `&#${character.codePointAt(0)};`);
}
