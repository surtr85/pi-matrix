import * as path from "node:path";

export interface MarkdownParserOptions {
  enableMath?: boolean;
  enableAlerts?: boolean;
  enableFootnotes?: boolean;
}

export function cleanAssistantText(rawText: string): string {
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, "");
  return cleaned.trim();
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function isPersian(text: string): boolean {
  const textWithoutCode = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, "");

  const persianRegex = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const firstStrong = textWithoutCode.match(
    /[A-Za-z]|[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/,
  );
  if (firstStrong) {
    return persianRegex.test(firstStrong[0]);
  }
  return persianRegex.test(textWithoutCode);
}

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

// Map for link references: [id]: url "title"
interface LinkRef {
  url: string;
  title?: string;
}

// Map for footnotes: [^id]: text
interface FootnoteDef {
  id: string;
  text: string;
}

class ParserContext {
  linkRefs = new Map<string, LinkRef>();
  footnotes = new Map<string, FootnoteDef>();
  usedFootnotes = new Set<string>();
}

/**
 * Escapes characters for safe inclusion inside an HTML attribute
 */
function escapeAttr(str: string): string {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

/**
 * Extract code spans according to CommonMark spec:
 * Delimiter run of backticks of length N matches only another run of backticks of length N.
 */
function extractCodeSpans(input: string): { text: string; spans: string[] } {
  let text = "";
  let i = 0;
  const spans: string[] = [];

  while (i < input.length) {
    if (input[i] === "`") {
      let tickCount = 0;
      while (i + tickCount < input.length && input[i + tickCount] === "`") {
        tickCount++;
      }
      // Look for closing sequence of exact tickCount backticks
      let closeIdx = -1;
      let j = i + tickCount;
      while (j < input.length) {
        if (input[j] === "`") {
          let closeTicks = 0;
          while (
            j + closeTicks < input.length &&
            input[j + closeTicks] === "`"
          ) {
            closeTicks++;
          }
          if (closeTicks === tickCount) {
            closeIdx = j;
            break;
          }
          j += closeTicks;
        } else {
          j++;
        }
      }

      if (closeIdx !== -1) {
        let code = input.slice(i + tickCount, closeIdx);
        // CommonMark: if code begins and ends with space (and not all spaces), strip one space from both ends
        if (
          code.startsWith(" ") &&
          code.endsWith(" ") &&
          code.trim().length > 0
        ) {
          code = code.slice(1, -1);
        }
        const idx = spans.length;
        spans.push(code);
        text += `\uE001IC${idx}\uE002`;
        i = closeIdx + tickCount;
        continue;
      }
    }
    text += input[i];
    i++;
  }
  return { text, spans };
}

/**
 * Inline Markdown Parser
 */
export function renderInlineMarkdown(
  text: string,
  ctx: ParserContext = new ParserContext(),
): string {
  if (!text) return "";

  // 1. Preserve escaped backslashes: \* \_ \[ \] \( \) \{ \} \# \+ \- \. \! \| \` \~
  const escapes: string[] = [];
  let s = text.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, (_m, ch) => {
    const idx = escapes.length;
    escapes.push(ch);
    return `\uE001ESC${idx}\uE002`;
  });

  // 2. Extract code spans using CommonMark backtick matching
  const { text: textWithCodes, spans: rawCodeSpans } = extractCodeSpans(s);
  s = textWithCodes;
  const codeSpanHtmls = rawCodeSpans.map((rawCode) => {
    return `<code dir="ltr" style="direction: ltr; font-family: monospace; padding: 2px 5px; background: rgba(128, 128, 128, 0.18); border-radius: 3px; font-size: 0.9em;">${escapeHtml(
      rawCode,
    )}</code>`;
  });

  // 3. Inline LaTeX math: $...$
  const inlineMaths: string[] = [];
  s = s.replace(/(?<!\$)\$(?!\$)([^\n$]+?)(?<!\$)\$(?!\$)/g, (_m, math) => {
    const trimmed = math.trim();
    if (!trimmed) return _m;
    const idx = inlineMaths.length;
    const escapedMath = escapeHtml(trimmed);
    inlineMaths.push(
      `<span data-mx-math="${escapeAttr(trimmed)}" dir="ltr" style="direction: ltr;"><code dir="ltr" style="direction: ltr; font-family: monospace; background: rgba(128,128,128,0.12); padding: 1px 4px; border-radius: 3px;">$${escapedMath}$</code></span>`,
    );
    return `\uE001IM${idx}\uE002`;
  });

  // 4. Footnote references: [^id]
  const footnoteTokens: string[] = [];
  s = s.replace(/\[\^([^\]]+)\]/g, (_m, fnId) => {
    ctx.usedFootnotes.add(fnId);
    const idx = footnoteTokens.length;
    footnoteTokens.push(
      `<sup><a href="#fn-${encodeURIComponent(fnId)}" id="fnref-${encodeURIComponent(
        fnId,
      )}" style="text-decoration: none;">[${escapeHtml(fnId)}]</a></sup>`,
    );
    return `\uE001FN${idx}\uE002`;
  });

  // 5. Links & Images
  const linkTokens: string[] = [];

  // 5a. Markdown Images: ![alt](url "title")
  s = s.replace(
    /!\[([^\]]*)\]\(\s*([^\s)"']+)(?:\s+["']([^"']*)["'])?\s*\)/g,
    (_m, alt, url, title) => {
      const idx = linkTokens.length;
      const safeUrl = escapeAttr(url);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      linkTokens.push(
        `<img src="${safeUrl}" alt="${escapeAttr(alt)}"${titleAttr} style="max-width: 100%; border-radius: 4px;" />`,
      );
      return `\uE001LK${idx}\uE002`;
    },
  );

  // 5b. Inline links: [text](url "title")
  s = s.replace(
    /\[((?:[^[\]]|\[[^[\]]*\])+)\]\(\s*([^\s)"']+(?:\([^\s)"']*\)[^\s)"']*)*)(?:\s+["']([^"']*)["'])?\s*\)/g,
    (_m, textInside, url, title) => {
      const idx = linkTokens.length;
      const renderedInner = renderInlineMarkdown(textInside, ctx);
      const safeUrl = escapeAttr(url);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      linkTokens.push(
        `<a href="${safeUrl}"${titleAttr} target="_blank" rel="noopener noreferrer">${renderedInner}</a>`,
      );
      return `\uE001LK${idx}\uE002`;
    },
  );

  // 5c. Reference links: [text][ref] or [text]
  s = s.replace(
    /\[((?:[^[\]]|\[[^[\]]*\])+)\](?:\[([^\]]*)\])?/g,
    (fullMatch, textInside, refKey) => {
      const key = (refKey !== undefined && refKey !== "" ? refKey : textInside)
        .trim()
        .toLowerCase();
      const ref = ctx.linkRefs.get(key);
      if (ref) {
        const idx = linkTokens.length;
        const renderedInner = renderInlineMarkdown(textInside, ctx);
        const safeUrl = escapeAttr(ref.url);
        const titleAttr = ref.title ? ` title="${escapeAttr(ref.title)}"` : "";
        linkTokens.push(
          `<a href="${safeUrl}"${titleAttr} target="_blank" rel="noopener noreferrer">${renderedInner}</a>`,
        );
        return `\uE001LK${idx}\uE002`;
      }
      return fullMatch;
    },
  );

  // 5d. Autolinks: <https://...>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, (_m, url) => {
    const idx = linkTokens.length;
    const safeUrl = escapeAttr(url);
    linkTokens.push(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`,
    );
    return `\uE001LK${idx}\uE002`;
  });

  // 6. Safe Whitelisted HTML tags preservation
  const rawHtmlTokens: string[] = [];
  const allowedTagRegex =
    /<\/?(kbd|span|font|b|i|u|s|del|strong|em|sub|sup|br|a|mark)(?:\s+[^>]*)?\/?>/gi;
  s = s.replace(allowedTagRegex, (match) => {
    const idx = rawHtmlTokens.length;
    if (/^<kbd\b/i.test(match)) {
      match = match.replace(
        /<kbd>/i,
        '<kbd style="background: rgba(128,128,128,0.25); border: 1px solid rgba(128,128,128,0.4); border-radius: 3px; box-shadow: 0 1px 0 rgba(0,0,0,0.2); font-family: monospace; font-size: 11px; padding: 1px 5px;">',
      );
    }
    rawHtmlTokens.push(match);
    return `\uE001HT${idx}\uE002`;
  });

  // 7. Escape remaining characters for safe HTML output
  s = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  // 8. Bold & Italic & Strikethrough formatting
  // Bold + Italic: ***text*** or ___text___
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/___([^_\n]+?)___/g, "<strong><em>$1</em></strong>");

  // Bold: **text** (allowing single * inside, e.g. for italic)
  s = s.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__((?:[^_]|_(?!_))+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  s = s.replace(/(^|[^*])\*([^*\n\r]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(
    /(^|[^_A-Za-z0-9])_([^_\n\r]+?)_(?![_A-Za-z0-9])/g,
    "$1<em>$2</em>",
  );

  // Strikethrough: ~~text~~
  s = s.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");

  // 9. Restore preserved tokens in reverse nesting order
  rawHtmlTokens.forEach((tag, idx) => {
    s = s.replace(`\uE001HT${idx}\uE002`, tag);
  });
  linkTokens.forEach((lk, idx) => {
    s = s.replace(`\uE001LK${idx}\uE002`, lk);
  });
  footnoteTokens.forEach((fn, idx) => {
    s = s.replace(`\uE001FN${idx}\uE002`, fn);
  });
  inlineMaths.forEach((m, idx) => {
    s = s.replace(`\uE001IM${idx}\uE002`, m);
  });
  codeSpanHtmls.forEach((c, idx) => {
    s = s.replace(`\uE001IC${idx}\uE002`, c);
  });
  escapes.forEach((esc, idx) => {
    s = s.replace(`\uE001ESC${idx}\uE002`, escapeHtml(esc));
  });

  return s;
}

export function renderMarkdownTable(
  tableLines: string[],
  ctx: ParserContext = new ParserContext(),
): string {
  if (tableLines.length < 2) return tableLines.join("\n");

  const parseRow = (line: string): string[] => {
    let protectedLine = line.replace(/\\\|/g, "\uE002PIPE_ESC\uE003");
    const { text: noCodePipes, spans } = extractCodeSpans(protectedLine);
    let trimmed = noCodePipes.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

    return trimmed.split("|").map((cell) => {
      let restored = cell;
      spans.forEach((span, idx) => {
        restored = restored.replace(`\uE001IC${idx}\uE002`, `\`${span}\``);
      });
      restored = restored.replace(/\uE002PIPE_ESC\uE003/g, "\\|");
      return restored.trim();
    });
  };

  const headerCells = parseRow(tableLines[0]);
  const alignRow = parseRow(tableLines[1]);

  const isSeparator = alignRow.every((c) => /^:?-+:?$/.test(c));
  if (!isSeparator) {
    return tableLines.join("\n");
  }

  const alignments = alignRow.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

  const bodyRows = tableLines.slice(2).map(parseRow);

  const allText = tableLines.join(" ");
  const isTableRtl = isPersian(allText);
  const tableDir = isTableRtl ? "rtl" : "ltr";
  const defaultAlign = isTableRtl ? "right" : "left";

  let out = `<div dir="${tableDir}" style="overflow-x: auto; margin: 10px 0;"><table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; border: 1px solid #555; width: 100%; text-align: ${defaultAlign}; font-size: 13px;">`;

  out += `<thead style="background-color: rgba(128, 128, 128, 0.2);"><tr>`;
  headerCells.forEach((cell, idx) => {
    const colAlign =
      alignments[idx] || (isPersian(cell) ? "right" : defaultAlign);
    const rendered = renderInlineMarkdown(cell, ctx);
    out += `<th style="border: 1px solid #555; padding: 6px 10px; text-align: ${colAlign};">${rendered}</th>`;
  });
  out += `</tr></thead><tbody>`;

  bodyRows.forEach((row, rowIdx) => {
    const bg =
      rowIdx % 2 === 1 ? "background-color: rgba(128, 128, 128, 0.08);" : "";
    out += `<tr style="${bg}">`;
    headerCells.forEach((_, idx) => {
      const cell = row[idx] || "";
      const colAlign =
        alignments[idx] || (isPersian(cell) ? "right" : defaultAlign);
      const rendered = renderInlineMarkdown(cell, ctx);
      out += `<td style="border: 1px solid #555; padding: 6px 10px; text-align: ${colAlign};">${rendered}</td>`;
    });
    out += `</tr>`;
  });

  out += `</tbody></table></div>`;
  return out;
}

/**
 * GFM Alert definitions
 */
interface GfmAlertConfig {
  icon: string;
  labelEn: string;
  labelFa: string;
  borderColor: string;
  bgColor: string;
  textColor: string;
}

const GFM_ALERTS: Record<string, GfmAlertConfig> = {
  NOTE: {
    icon: "ℹ️",
    labelEn: "Note",
    labelFa: "نکته",
    borderColor: "#0969da",
    bgColor: "rgba(9, 105, 218, 0.08)",
    textColor: "#2f81f7",
  },
  TIP: {
    icon: "💡",
    labelEn: "Tip",
    labelFa: "پیشنهاد",
    borderColor: "#1a7f37",
    bgColor: "rgba(26, 127, 55, 0.08)",
    textColor: "#3fb950",
  },
  IMPORTANT: {
    icon: "🟣",
    labelEn: "Important",
    labelFa: "مهم",
    borderColor: "#8250df",
    bgColor: "rgba(130, 80, 223, 0.08)",
    textColor: "#a371f7",
  },
  WARNING: {
    icon: "⚠️",
    labelEn: "Warning",
    labelFa: "هشدار",
    borderColor: "#d29922",
    bgColor: "rgba(210, 153, 34, 0.08)",
    textColor: "#d29922",
  },
  CAUTION: {
    icon: "🛑",
    labelEn: "Caution",
    labelFa: "احتیاط",
    borderColor: "#cf222e",
    bgColor: "rgba(207, 34, 46, 0.08)",
    textColor: "#f85149",
  },
};

/**
 * Recursive Block Markdown Parser
 */
export function parseMarkdownBlocks(
  lines: string[],
  ctx: ParserContext,
  depth = 0,
): string {
  if (depth > 20) return ""; // Recursion guard

  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 1. Skip completely empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // 2. Fenced Code Block: ``` or ~~~
    const fenceMatch = rawLine.match(/^(\s*)(```|~~~)(\w*)/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2];
      const lang = fenceMatch[3] || "";
      const indent = fenceMatch[1].length;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const curLine = lines[i];
        if (new RegExp(`^\\s*${fenceChar}\\s*$`).test(curLine)) {
          i++;
          break;
        }
        let lineContent = curLine;
        if (indent > 0 && lineContent.startsWith(" ".repeat(indent))) {
          lineContent = lineContent.slice(indent);
        }
        codeLines.push(lineContent);
        i++;
      }
      const code = escapeHtml(codeLines.join("\n"));
      output.push(
        `<div dir="ltr" style="direction: ltr; text-align: left; margin: 8px 0;"><pre dir="ltr" style="direction: ltr; text-align: left;"><code${
          lang ? ` class="language-${lang}"` : ""
        } dir="ltr" style="direction: ltr; text-align: left;">${code}</code></pre></div>`,
      );
      continue;
    }

    // 3. Display Math Block: $$
    if (trimmed === "$$") {
      const mathLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim() === "$$") i++;
      const latex = mathLines.join("\n");
      const escapedLatex = escapeHtml(latex);
      output.push(
        `<div data-mx-math="${escapeAttr(latex)}" dir="ltr" style="direction: ltr; text-align: left; overflow-x: auto; margin: 10px 0; padding: 8px 12px; background: rgba(128,128,128,0.08); border-radius: 4px; font-family: monospace;">$$${escapedLatex}$$</div>`,
      );
      continue;
    }

    // 4. HTML <details> block
    if (trimmed.startsWith("<details>") || trimmed.startsWith("<details ")) {
      const detailsLines: string[] = [];
      while (i < lines.length) {
        detailsLines.push(lines[i]);
        if (lines[i].includes("</details>")) {
          i++;
          break;
        }
        i++;
      }
      const fullDetails = detailsLines.join("\n");
      const summaryMatch = fullDetails.match(
        /<summary\b[^>]*>([\s\S]*?)<\/summary>/i,
      );
      let summaryHtml = "Details";
      let innerContent = fullDetails
        .replace(/<details\b[^>]*>/i, "")
        .replace(/<\/details>/i, "");
      if (summaryMatch) {
        summaryHtml = renderInlineMarkdown(summaryMatch[1].trim(), ctx);
        innerContent = innerContent.replace(summaryMatch[0], "");
      }
      const parsedInner = parseMarkdownBlocks(
        innerContent.split("\n"),
        ctx,
        depth + 1,
      );
      const isRtl = isPersian(summaryHtml);
      output.push(
        `<details dir="${isRtl ? "rtl" : "ltr"}" style="margin: 8px 0; padding: 6px 12px; border: 1px solid rgba(128,128,128,0.3); border-radius: 6px; background: rgba(128,128,128,0.04);"><summary style="cursor: pointer; font-weight: bold; padding: 4px 0;">${summaryHtml}</summary><div style="margin-top: 8px;">${parsedInner}</div></details>`,
      );
      continue;
    }

    // 5. Headings: # to ######
    const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const rtl = isPersian(text);
      const dir = rtl ? "rtl" : "ltr";
      const align = rtl ? "right" : "left";
      const rendered = renderInlineMarkdown(text, ctx);
      output.push(
        `<h${level} dir="${dir}" style="text-align: ${align}; margin: 12px 0 6px 0;">${rendered}</h${level}>`,
      );
      i++;
      continue;
    }

    // 6. Horizontal Rule: ---, ***, ___ (at least 3 characters)
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      output.push(
        `<hr style="border: 0; border-top: 1px solid rgba(128,128,128,0.3); margin: 12px 0;"/>`,
      );
      i++;
      continue;
    }

    // 7. Markdown Tables: lines starting and ending with |
    if (
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      trimmed.length > 2
    ) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (cur.startsWith("|") && cur.endsWith("|") && cur.length > 2) {
          tableLines.push(cur);
          i++;
        } else {
          break;
        }
      }
      if (tableLines.length >= 2 && tableLines[1].includes("-")) {
        output.push(renderMarkdownTable(tableLines, ctx));
      } else {
        tableLines.forEach((tl) => {
          output.push(`<p>${renderInlineMarkdown(tl, ctx)}</p>`);
        });
      }
      continue;
    }

    // 8. Blockquotes: lines starting with optional whitespace + >
    if (/^\s*>\s?/.test(rawLine)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (/^\s*>\s?/.test(cur)) {
          quoteLines.push(cur.replace(/^\s*>\s?/, ""));
          i++;
        } else if (quoteLines.length > 0 && cur.trim() === "") {
          if (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
            quoteLines.push("");
            i++;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      let isAlert = false;
      let alertConfig: GfmAlertConfig | null = null;
      if (quoteLines.length > 0) {
        const alertMatch = quoteLines[0]
          .trim()
          .match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*(.*))?$/i);
        if (alertMatch) {
          isAlert = true;
          const alertType = alertMatch[1].toUpperCase();
          alertConfig = GFM_ALERTS[alertType] || GFM_ALERTS.NOTE;
          if (alertMatch[2]) {
            quoteLines[0] = alertMatch[2];
          } else {
            quoteLines.shift();
          }
        }
      }

      const parsedQuote = parseMarkdownBlocks(quoteLines, ctx, depth + 1);
      const isRtl = isPersian(quoteLines.join(" "));
      const dir = isRtl ? "rtl" : "ltr";
      const borderSide = isRtl ? "border-right" : "border-left";
      const paddingSide = isRtl ? "padding-right" : "padding-left";

      if (isAlert && alertConfig) {
        const alertLabel = isRtl ? alertConfig.labelFa : alertConfig.labelEn;
        output.push(
          `<blockquote dir="${dir}" style="${borderSide}: 4px solid ${alertConfig.borderColor}; ${paddingSide}: 12px; margin: 8px 0; background: ${alertConfig.bgColor}; border-radius: 4px; padding-top: 6px; padding-bottom: 6px;"><div style="font-weight: bold; color: ${alertConfig.textColor}; margin-bottom: 4px;">${alertConfig.icon} ${alertLabel}</div>${parsedQuote}</blockquote>`,
        );
      } else {
        output.push(
          `<blockquote dir="${dir}" style="${borderSide}: 3px solid rgba(128,128,128,0.5); ${paddingSide}: 10px; margin: 8px 0; background: rgba(128,128,128,0.05); border-radius: 3px; font-style: normal;">${parsedQuote}</blockquote>`,
        );
      }
      continue;
    }

    // 9. Lists: Unordered (- * +) or Ordered (1. 2.)
    const listMatch = rawLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const isOrdered = /^\d+\./.test(listMatch[2]);
      const baseIndent = listMatch[1].length;
      const tag = isOrdered ? "ol" : "ul";

      interface ParsedItem {
        firstLine: string;
        continuationLines: string[];
      }
      const items: ParsedItem[] = [];
      let currentItem: ParsedItem = {
        firstLine: listMatch[3],
        continuationLines: [],
      };
      items.push(currentItem);
      i++;

      while (i < lines.length) {
        const cur = lines[i];
        const curTrim = cur.trim();
        if (!curTrim) {
          if (i + 1 < lines.length && /^\s*[-*+\d]/.test(lines[i + 1])) {
            currentItem.continuationLines.push("");
            i++;
            continue;
          } else {
            break;
          }
        }

        const nextItemMatch = cur.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (nextItemMatch) {
          const nextIndent = nextItemMatch[1].length;
          const nextIsOrdered = /^\d+\./.test(nextItemMatch[2]);
          if (nextIndent === baseIndent && nextIsOrdered === isOrdered) {
            currentItem = {
              firstLine: nextItemMatch[3],
              continuationLines: [],
            };
            items.push(currentItem);
            i++;
            continue;
          }
        }

        const lineIndent = cur.match(/^(\s*)/)![1].length;
        if (lineIndent > baseIndent) {
          const stripLen = Math.min(lineIndent, baseIndent + 2);
          currentItem.continuationLines.push(cur.slice(stripLen));
          i++;
        } else {
          break;
        }
      }

      let listHtml = `<${tag} style="margin: 6px 0; padding-inline-start: 22px;">`;
      items.forEach((item) => {
        let text = item.firstLine;
        let isTask = false;
        let taskChecked = false;

        const taskMatch = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          isTask = true;
          taskChecked = taskMatch[1].toLowerCase() === "x";
          text = taskMatch[2];
        }

        let renderedFirst = renderInlineMarkdown(text, ctx);
        if (isTask) {
          const checkboxIcon = taskChecked
            ? `<span style="color: #2ea043; font-weight: bold; margin-inline-end: 4px;">☑</span>`
            : `<span style="color: #888; margin-inline-end: 4px;">☐</span>`;
          renderedFirst = `${checkboxIcon} ${renderedFirst}`;
        }

        let innerContent = "";
        if (item.continuationLines.length > 0) {
          innerContent = parseMarkdownBlocks(
            item.continuationLines,
            ctx,
            depth + 1,
          );
        }

        const isRtl = isPersian(text);
        const dir = isRtl ? "rtl" : "ltr";
        listHtml += `<li dir="${dir}" style="margin: 3px 0;">${renderedFirst}${innerContent}</li>`;
      });
      listHtml += `</${tag}>`;
      output.push(listHtml);
      continue;
    }

    // 10. Paragraphs: Consecutive non-empty lines
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (!curTrim) break;
      if (
        /^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?|```|~~~|\$\$|(?:[-*_]\s*){3,}$)/.test(
          curTrim,
        ) ||
        (curTrim.startsWith("|") && curTrim.endsWith("|")) ||
        curTrim.startsWith("<details")
      ) {
        break;
      }
      paragraphLines.push(curTrim);
      i++;
    }

    if (paragraphLines.length > 0) {
      const combined = paragraphLines.join(" ");
      const rtl = isPersian(combined);
      const dir = rtl ? "rtl" : "ltr";
      const align = rtl ? "right" : "left";
      const rendered = renderInlineMarkdown(combined, ctx);
      output.push(
        `<p dir="${dir}" style="text-align: ${align}; margin: 6px 0;">${rendered}</p>`,
      );
    }
  }

  return output.join("\n");
}

/**
 * Top-Level Markdown to Matrix HTML Converter
 */
export function markdownToMatrixHtml(md: string): string {
  if (!md || !md.trim()) return "";

  const ctx = new ParserContext();

  // 1. Extract and process YAML Frontmatter at start of document
  let workingText = md;
  let frontmatterHtml = "";
  const frontmatterMatch = workingText.match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/,
  );
  if (frontmatterMatch) {
    const rawFm = frontmatterMatch[1].trim();
    workingText = workingText.slice(frontmatterMatch[0].length);
    const fmPairs: string[] = [];
    rawFm.split("\n").forEach((line) => {
      const kv = line.match(/^([^:]+):\s*(.*)$/);
      if (kv) {
        fmPairs.push(
          `<strong>${escapeHtml(kv[1].trim())}:</strong> ${escapeHtml(kv[2].trim().replace(/^["']|["']$/g, ""))}`,
        );
      }
    });
    if (fmPairs.length > 0) {
      frontmatterHtml = `<div style="font-size: 11px; padding: 4px 8px; margin-bottom: 8px; background: rgba(128,128,128,0.1); border-radius: 4px; border: 1px solid rgba(128,128,128,0.2);">${fmPairs.join(" &bull; ")}</div>`;
    }
  }

  // 2. Extract Link Reference Definitions: [id]: url "optional title"
  const lines = workingText.split(/\r?\n/);
  const remainingLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const linkRefMatch = line.match(
      /^\[([^\]]+)\]:\s*(\S+)(?:\s+["'(](.*?)["')])?\s*$/,
    );
    if (linkRefMatch) {
      ctx.linkRefs.set(linkRefMatch[1].trim().toLowerCase(), {
        url: linkRefMatch[2],
        title: linkRefMatch[3],
      });
      continue;
    }
    // Extract Footnote Definitions: [^id]: text
    const fnMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (fnMatch) {
      const fnId = fnMatch[1].trim();
      let fnText = fnMatch[2].trim();
      while (i + 1 < lines.length && /^\s{2,4}\S/.test(lines[i + 1])) {
        i++;
        fnText += " " + lines[i].trim();
      }
      ctx.footnotes.set(fnId, { id: fnId, text: fnText });
      continue;
    }
    remainingLines.push(line);
  }

  // 3. Parse Document Blocks
  const mainHtml = parseMarkdownBlocks(remainingLines, ctx);

  // 4. Render Footnotes Section if any were used
  let footnotesHtml = "";
  if (ctx.usedFootnotes.size > 0 && ctx.footnotes.size > 0) {
    const fnItems: string[] = [];
    ctx.usedFootnotes.forEach((id) => {
      const def = ctx.footnotes.get(id);
      if (def) {
        const renderedFn = renderInlineMarkdown(def.text, ctx);
        const safeId = encodeURIComponent(id);
        fnItems.push(
          `<li id="fn-${safeId}" style="margin: 4px 0;">${renderedFn} <a href="#fnref-${safeId}" style="text-decoration: none;">↩</a></li>`,
        );
      }
    });
    if (fnItems.length > 0) {
      footnotesHtml = `<hr style="border: 0; border-top: 1px solid rgba(128,128,128,0.3); margin: 16px 0 8px 0;"/><section class="footnotes" style="font-size: 0.9em; opacity: 0.85;"><ol style="padding-inline-start: 20px;">${fnItems.join(
        "",
      )}</ol></section>`;
    }
  }

  return (frontmatterHtml + mainHtml + footnotesHtml).trim();
}
