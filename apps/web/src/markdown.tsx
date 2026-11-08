import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer for the guide's answers: paragraphs, bullet and numbered lists,
 * `code`, **bold** and *italics*. It builds React elements, never HTML strings, so the model's
 * text can't inject markup. Anything else shows as the plain text it is.
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text)}</>;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[]; start: number };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

function blocks(text: string): ReactNode[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const last = out.at(-1);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (line.trim() === '') {
      out.push({ kind: 'p', lines: [] });
    } else if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1] ?? '');
      else out.push({ kind: 'ul', items: [bullet[1] ?? ''], start: 1 });
    } else if (numbered) {
      if (last?.kind === 'ol') last.items.push(numbered[2] ?? '');
      else out.push({ kind: 'ol', items: [numbered[2] ?? ''], start: Number(numbered[1]) });
    } else if (last?.kind === 'p') {
      last.lines.push(line);
    } else if (last && /^\s+/.test(raw)) {
      // An indented line continues the last list item.
      last.items[last.items.length - 1] += ` ${line.trim()}`;
    } else {
      out.push({ kind: 'p', lines: [line] });
    }
  }
  return out
    .filter((block) => (block.kind === 'p' ? block.lines.length > 0 : true))
    .map((block, i) => {
      if (block.kind === 'p') {
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
        return <p key={i}>{spans(block.lines.join(' '))}</p>;
      }
      const items = block.items.map((item, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
        <li key={j}>{spans(item)}</li>
      ));
      return block.kind === 'ul' ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
        <ul key={i}>{items}</ul>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
        <ol key={i} start={block.start}>
          {items}
        </ol>
      );
    });
}

/** Inline code first (its contents stay literal), then bold and italics in the text between. */
export function spans(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
    return <Fragment key={i}>{emphasis(part)}</Fragment>;
  });
}

function emphasis(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
