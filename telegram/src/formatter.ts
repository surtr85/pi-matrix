export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

export function stripHtmlToPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ""));
}

export function cleanAssistantText(rawText: string): string {
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, "");
  return cleaned.trim();
}

/**
 * Robust Telegram HTML Formatter:
 * Converts Markdown to Telegram-compliant HTML subset:
 * <b>, <i>, <u>, <s>, <span>, <tg-spoiler>, <a>, <code>, <pre>, <blockquote>
 */
export function markdownToTelegramHtml(input: string): string {
  // 1. Extract and format code blocks first
  const codeBlocks: string[] = [];
  let text = input.replace(
    /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const idx = codeBlocks.length;
      const escapedCode = escapeHtml(code);
      codeBlocks.push(
        `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapedCode}</code></pre>`,
      );
      return `\uE000TGCB${idx}\uE001`;
    },
  );

  // 2. Extract and format inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\uE000TGIC${idx}\uE001`;
  });

  // 3. Preserve any pre-existing valid Telegram HTML tags
  const preservedTags: string[] = [];
  const tagRegex =
    /<\/?(?:b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|tg-emoji|code|pre|blockquote)(?:\s+[^>]*)?>|<a\s+(?:[^>]*?\s+)?href="[^"]*"(?:\s+[^>]*)?>|<\/a>/gi;
  text = text.replace(tagRegex, (match) => {
    const idx = preservedTags.length;
    preservedTags.push(match);
    return `\uE000TGPT${idx}\uE001`;
  });

  // 4. Preserve existing valid HTML entities (like &lt; &gt; &amp;)
  const preservedEntities: string[] = [];
  text = text.replace(/&(?:amp|lt|gt|quot|#039|#x?[0-9a-fA-F]+);/g, (match) => {
    const idx = preservedEntities.length;
    preservedEntities.push(match);
    return `\uE000TGPE${idx}\uE001`;
  });

  // 5. Blockquotes: > quote
  text = text.replace(/(?:^>[^\n]*(?:\n|$))+/gm, (match) => {
    const content = match
      .split("\n")
      .map((line) => line.replace(/^>\s?/, "").trimEnd())
      .join("\n")
      .trim();
    return `\uE000TGQS\uE001${content}\uE000TGQE\uE001\n`;
  });

  // 6. Headers: #, ##, ###
  text = text.replace(
    /^#{1,6}\s+(.*)$/gm,
    "\uE000TGHS\uE001$1\uE000TGHE\uE001",
  );

  // 7. Escape remaining raw HTML special characters
  text = escapeHtml(text);

  // 8. Convert Header & Quote placeholders to actual tags
  text = text.replace(
    /\uE000TGHS\uE001([\s\S]*?)\uE000TGHE\uE001/g,
    "<b>$1</b>",
  );
  text = text.replace(
    /\uE000TGQS\uE001([\s\S]*?)\uE000TGQE\uE001/g,
    "<blockquote>$1</blockquote>",
  );

  // 9. Restore preserved entities
  text = text.replace(
    /\uE000TGPE(\d+)\uE001/g,
    (_m, idx) => preservedEntities[Number(idx)],
  );

  // 10. Markdown links: [title](url) (supporting http, https, file, etc.)
  const links: string[] = [];
  text = text.replace(
    /\[([^\]]+)\]\(((?:https?|file):\/\/[^\s)]+)\)/g,
    (_match, title, url) => {
      const idx = links.length;
      links.push(`<a href="${url}">${title}</a>`);
      return `\uE000TGLK${idx}\uE001`;
    },
  );

  // 11. Markdown bold, italic, strikethrough
  text = text.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__((?:[^_]|_(?!_))+?)__/g, "<b>$1</b>");
  text = text.replace(/(^|[^*])\*([^*\n\r]+)\*(?!\*)/g, "$1<i>$2</i>");
  text = text.replace(
    /(^|[^_A-Za-z0-9])_([^_\n\r]+)_(?![_A-Za-z0-9])/g,
    "$1<i>$2</i>",
  );
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  // 12. Markdown Table fallback for Telegram: Format tables cleanly as monospace preformatted blocks
  const rawLines = text.split("\n");
  const processedBlocks: string[] = [];
  let currentTable: string[] = [];

  const flushTable = () => {
    if (currentTable.length > 0) {
      if (
        currentTable.length >= 2 &&
        currentTable[0].includes("|") &&
        currentTable[1].includes("|")
      ) {
        const tableText = currentTable.join("\n");
        processedBlocks.push(`<pre>${tableText}</pre>`);
      } else {
        processedBlocks.push(...currentTable);
      }
      currentTable = [];
    }
  };

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      trimmed.length > 2
    ) {
      currentTable.push(trimmed);
    } else {
      flushTable();
      processedBlocks.push(line);
    }
  }
  flushTable();
  text = processedBlocks.join("\n");

  // 13. Restore preserved HTML tags
  text = text.replace(
    /\uE000TGPT(\d+)\uE001/g,
    (_m, idx) => preservedTags[Number(idx)],
  );

  // 14. Restore links
  text = text.replace(
    /\uE000TGLK(\d+)\uE001/g,
    (_m, idx) => links[Number(idx)],
  );

  // 15. Restore code blocks & inline code
  text = text.replace(
    /\uE000TGCB(\d+)\uE001/g,
    (_m, idx) => codeBlocks[Number(idx)],
  );
  text = text.replace(
    /\uE000TGIC(\d+)\uE001/g,
    (_m, idx) => inlineCodes[Number(idx)],
  );

  return text;
}
