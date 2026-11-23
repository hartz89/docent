import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer for the guide's answers and the PR's description: headings,
 * paragraphs, bullet and numbered lists, fenced code, `code`, **bold**, *italics* and links. It
 * builds React elements, never HTML strings, so the text can't inject markup. HTML comments (PR
 * templates are full of them) are dropped, and images show as their alt text, so a description
 * can't make the page fetch anything. Anything else shows as the plain text it is.
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text)}</>;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; text: string }
  | { kind: 'pre'; lines: string[]; open: boolean }
  | { kind: 'ul' | 'ol'; items: string[]; start: number };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

function blocks(text: string): ReactNode[] {
  const out: Block[] = [];
  const source = text.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '');
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    const last = out.at(-1);
    if (last?.kind === 'pre' && last.open) {
      if (FENCE.test(line)) last.open = false;
      else last.lines.push(raw);
      continue;
    }
    if (FENCE.test(line)) {
      out.push({ kind: 'pre', lines: [], open: true });
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (heading) {
      out.push({ kind: 'h', text: heading[1] ?? '' });
    } else if (line.trim() === '') {
      out.push({ kind: 'p', lines: [] });
    } else if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1] ?? '');
      else out.push({ kind: 'ul', items: [bullet[1] ?? ''], start: 1 });
    } else if (numbered) {
      if (last?.kind === 'ol') last.items.push(numbered[2] ?? '');
      else out.push({ kind: 'ol', items: [numbered[2] ?? ''], start: Number(numbered[1]) });
    } else if (last?.kind === 'p') {
      last.lines.push(line);
    } else if ((last?.kind === 'ul' || last?.kind === 'ol') && /^\s+/.test(raw)) {
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
      if (block.kind === 'h') {
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
          <p key={i} className="md-heading">
            {spans(block.text)}
          </p>
        );
      }
      if (block.kind === 'pre') {
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
          <pre key={i} className="md-code">
            <code>{block.lines.join('\n')}</code>
          </pre>
        );
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
    return <Fragment key={i}>{links(part)}</Fragment>;
  });
}

/** Links open in a new tab, and only for http(s); an image shows as its alt text. */
const LINK = /(!?\[[^\]]*\]\([^)\s]+\))/;
const LINK_PARTS = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/;

function links(text: string): ReactNode[] {
  return text.split(LINK).map((part, i) => {
    const link = LINK_PARTS.exec(part);
    if (!link) {
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      return <Fragment key={i}>{emphasis(part)}</Fragment>;
    }
    const [, bang, label = '', href = ''] = link;
    if (bang || !/^https?:\/\//i.test(href)) {
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      return <Fragment key={i}>{emphasis(label)}</Fragment>;
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: fragments are positional.
      <a key={i} href={href} target="_blank" rel="noreferrer">
        {emphasis(label)}
      </a>
    );
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
