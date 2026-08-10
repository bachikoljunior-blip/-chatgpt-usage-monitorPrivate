#!/usr/bin/env node

// Markdown -> a ProseMirror document, and back to plain text for comparison.
//
// state/gumroad-rich-content.json settled that a ONE-PARAGRAPH document created over
// the API comes back carrying its page. The offer that route exists for is not one
// paragraph: codex/outbox/payload-01.md is ten sections of Japanese markdown with
// headings and fenced code blocks, about 10KB. Whether THAT survives is a different
// question — node types the deployment does not know are the ordinary way a rich
// text API drops content, and it drops it silently.
//
// So the conversion is deliberately narrow. Three node types and no marks:
//
//   heading (level 1-3) · paragraph · codeBlock
//
// Everything else degrades to a paragraph carrying its own source text rather than
// being dropped. A converter that discards what it does not understand produces a
// listing that looks fine and is missing pieces, and the whole route was elected
// because a fact about our own request had been written down as a fact about the API.
//
// The pairing that matters is toProseMirrorDoc + plainTextOf. Sending a document and
// reading it back is only a measurement if the read-back can be COMPARED to the
// source, and comparing rendered HTML to markdown compares two conversions. Reducing
// both ends to their text content compares the one thing a buyer cares about: is the
// text there.

/** Split a markdown source into blocks, keeping fenced code intact. */
export function blocksOf(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let fence = null;
  let code = [];

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // Inside a fence, only the SAME fence character at the same length closes it.
      // Treating any ``` as a closer breaks a block that quotes a shorter fence.
      if (fenceMatch && fenceMatch[1].startsWith(fence.marker[0]) && fenceMatch[1].length >= fence.marker.length && !fenceMatch[2].trim()) {
        blocks.push({ type: "code", text: code.join("\n"), language: fence.language });
        fence = null;
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      fence = { marker: fenceMatch[1], language: fenceMatch[2].trim() || null };
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      // Levels beyond 3 are clamped rather than dropped: a deployment that only
      // knows h1-h3 would otherwise lose the line entirely.
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 3), text: inlineText(heading[2]) });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  // An unterminated fence is kept as code rather than discarded. The payload comes
  // from a model and a truncated answer is a real possibility; losing its tail
  // silently is the failure this file exists to avoid.
  if (fence) blocks.push({ type: "code", text: code.join("\n"), language: fence.language, unterminated: true });
  flushParagraph();
  return blocks;
}

/**
 * Strip the inline markers this payload actually uses. No marks are emitted — bold
 * that arrives as literal asterisks reads as a typo, and bold that is dropped reads
 * as prose. Removing the markers keeps the text and loses only the weight.
 */
export function inlineText(s) {
  return String(s ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+?)\*/g, "$1$2")
    .replace(/`([^`]+?)`/g, "$1")
    .trim();
}

const textNode = (text) => (text ? [{ type: "text", text }] : []);

/** The ProseMirror doc for one markdown source. */
export function toProseMirrorDoc(markdown) {
  const content = [];
  for (const b of blocksOf(markdown)) {
    if (b.type === "heading") {
      content.push({ type: "heading", attrs: { level: b.level }, content: textNode(b.text) });
    } else if (b.type === "code") {
      content.push({
        type: "codeBlock",
        attrs: { language: b.language },
        content: textNode(b.text),
      });
    } else {
      const text = inlineText(b.text);
      if (text) content.push({ type: "paragraph", content: textNode(text) });
    }
  }
  // An empty doc must not be sent as a valid one. A page that renders blank is a
  // product with no content, and it would read back as a landed page.
  return { type: "doc", content };
}

/**
 * Every text node in a ProseMirror tree, joined. Used on BOTH ends: on the doc we
 * sent and on whatever the API hands back, so the comparison is between texts and
 * not between two renderings.
 */
export function plainTextOf(node) {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(plainTextOf).join("\n");
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  if (node.type === "text" && typeof node.text === "string") return node.text;
  const kids = node.content ?? node.description ?? null;
  return kids ? plainTextOf(kids) : "";
}

/** Normalised for comparison: whitespace differences are not content loss. */
export const normalise = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * What survived. Reported as three numbers rather than a boolean because "some of
 * it came back" is the answer that actually happens and the one a boolean hides.
 */
export function compareRoundTrip(sentDoc, returnedPages) {
  const sent = normalise(plainTextOf(sentDoc));
  const got = normalise(plainTextOf(returnedPages));
  const shorter = Math.min(sent.length, got.length);
  let same = 0;
  while (same < shorter && sent[same] === got[same]) same += 1;
  return {
    sent_chars: sent.length,
    returned_chars: got.length,
    identical: sent.length > 0 && sent === got,
    common_prefix_chars: same,
    // Where they part company, in the source's own words, so a truncation at a
    // size limit is legible as a size limit instead of as "it did not match".
    diverges_at: sent === got ? null : sent.slice(Math.max(0, same - 40), same + 40),
  };
}
