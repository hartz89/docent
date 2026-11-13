import { useQuery } from '@tanstack/react-query';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { fileTextQuery } from './api.ts';
import { DefinitionPopover, type Found, type JumpTo, lookUp } from './definition-popover.tsx';
import { highlight, type Token } from './highlight.ts';
import { type JumpTarget, targetAt } from './jump.ts';

export type Range = { startLine: number; endLine: number };

type Props = {
  path: string;
  side: 'old' | 'new';
  /** Every range this stop cites in this file. */
  cited: readonly Range[];
  /** The range to bring into view, or null to show the top of the file. */
  focus: Range | null;
  /** Line numbers changed by the PR on this side: added at head, removed at base. */
  changed: ReadonlySet<number>;
  /**
   * Moves to the stop's next (1) or previous (-1) citation. Returns false when there is none,
   * and the arrow keys then scroll the file instead. Absent when no citation is in focus.
   */
  onStep: ((delta: 1 | -1) => boolean) | undefined;
  /** Opens the place a jump to definition or an import found. */
  onJump: (to: JumpTo) => void;
};

/** The modifier key for a jump, as this platform's keyboards print it. */
const MOD_LABEL = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Room left around a citation when ↑ ↓ reveal its edges. */
const REVEAL_PADDING = 48;

/** A read-only view of one file, with the PR's changes and the stop's citations marked. */
export function CodeView({ path, side, cited, focus, changed, onStep, onJump }: Props) {
  const text = useQuery(fileTextQuery(path, side));
  const highlighted = useQuery({
    queryKey: ['highlight', side, path],
    queryFn: () => highlight(path, text.data ?? ''),
    enabled: text.data !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const lines = highlighted.data;

  const scroller = useRef<HTMLElement>(null);
  const focusStart = focus?.startLine ?? null;
  const focusEnd = focus?.endLine ?? null;
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !lines) return;
    if (focusStart === null || focusEnd === null) {
      box.scrollTop = 0;
      return;
    }
    const first = box.querySelector<HTMLElement>(`[data-line="${focusStart}"]`);
    const last = box.querySelector<HTMLElement>(`[data-line="${focusEnd}"]`) ?? first;
    if (!first || !last) return;
    const span = last.offsetTop + last.offsetHeight - first.offsetTop;
    // Center the cited range, or put its start a little below the top if it's taller than the view.
    const target =
      span < box.clientHeight * 0.8
        ? first.offsetTop - (box.clientHeight - span) / 2
        : first.offsetTop - 48;
    box.scrollTop = Math.max(0, target);
  }, [lines, focusStart, focusEnd]);

  // ↓ reads on through the citation in focus while any of it is below the view; once its end is
  // in view (with some room), the next ↓ moves to the stop's next citation. ↑ mirrors that. Past
  // the first or last citation, or with no citation in focus, the arrows scroll the file.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const box = scroller.current;
      if (!box) return;
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      const step = Math.round(box.clientHeight * 0.6);
      const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';
      const first = focusStart === null ? null : lineAt(box, focusStart);
      const last = focusEnd === null ? null : (lineAt(box, focusEnd) ?? first);
      if (first && last) {
        if (down) {
          const want = last.offsetTop + last.offsetHeight + REVEAL_PADDING;
          if (want > box.scrollTop + box.clientHeight + 1) {
            box.scrollTo({
              top: Math.min(want - box.clientHeight, box.scrollTop + step),
              behavior,
            });
            return;
          }
        } else {
          const want = first.offsetTop - REVEAL_PADDING;
          if (want < box.scrollTop - 1) {
            box.scrollTo({ top: Math.max(want, box.scrollTop - step), behavior });
            return;
          }
        }
        // A held key reads on but doesn't race through the stop's citations.
        if (event.repeat) return;
        if (onStep?.(down ? 1 : -1)) return;
      }
      box.scrollBy({ top: down ? step : -step, behavior });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusStart, focusEnd, onStep]);

  // Jump to definition. A ⌘-click (Ctrl-click elsewhere) on a name or an import looks it up, and
  // so do Enter and F12 with the caret or selection on one. Plain clicks are left alone, so text
  // still selects as usual.
  const [popover, setPopover] = useState<{ found: Found; at: Box } | null>(null);
  const closePopover = useCallback(() => setPopover(null), []);
  const [hovering, setHovering] = useState(false);
  const lookups = useRef(0);
  // A new file closes the old file's popover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path and side are the triggers.
  useEffect(() => setPopover(null), [path, side]);

  const jump = async (hit: Hit) => {
    const id = ++lookups.current;
    const name = hit.target.kind === 'symbol' ? hit.target.name : hit.target.spec;
    setPopover({ found: { kind: 'loading', name }, at: hit.box });
    const found = await lookUp(hit.target, { path, side, line: hit.line });
    if (id !== lookups.current) return;
    if ('path' in found) {
      setPopover(null);
      onJump(found);
    } else {
      setPopover({ found, at: hit.box });
    }
  };

  const onMouseDown = (event: ReactMouseEvent) => {
    // Keep the selection as it was: a ⌘-click is a jump, not a click into the text.
    if (isJumpClick(event)) event.preventDefault();
  };
  const onClick = (event: ReactMouseEvent) => {
    if (!isJumpClick(event)) return;
    const hit = hitAtPoint(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    void jump(hit);
  };
  const clearHover = useCallback(() => {
    setHovering(false);
    CSS.highlights?.delete('jump');
  }, []);
  const onMouseMove = (event: ReactMouseEvent) => {
    const hit = isJumpClick(event) ? hitAtPoint(event.clientX, event.clientY) : null;
    if (!hit) return clearHover();
    setHovering(true);
    if (typeof Highlight !== 'undefined') CSS.highlights?.set('jump', new Highlight(hit.range));
  };
  // Letting go of ⌘ takes the underline away.
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') clearHover();
    };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearHover);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearHover);
      clearHover();
    };
  }, [clearHover]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== 'F12') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const hit = hitAt(range.startContainer, range.startOffset);
    if (!hit) return;
    event.preventDefault();
    void jump(hit);
  };

  const isCited = (line: number) => cited.some((r) => line >= r.startLine && line <= r.endLine);
  const changeClass = side === 'new' ? 'added' : 'removed';
  const changeMark = side === 'new' ? '+' : '−';

  return (
    <>
      {/* A labelled region with a tab stop: it scrolls from the keyboard, and Enter or F12 jump
          from the caret. The mouse handlers add ⌘-click; plain clicks and selection are untouched. */}
      <section
        className="code-scroll"
        ref={scroller}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region needs a tab stop.
        tabIndex={0}
        aria-label={`${path}, ${MOD_LABEL}-click a name, or select it and press Enter, to jump to its definition`}
        data-jump={hovering ? '' : undefined}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseLeave={clearHover}
        onKeyDown={onKeyDown}
        onScroll={closePopover}
      >
        {!lines && !text.isError && <p className="code-message">Opening {path}…</p>}
        {text.isError && (
          <p className="code-message" role="alert">
            Couldn't open {path}: {text.error.message}
          </p>
        )}
        {lines && (
          <div className="code fade-in">
            {lines.map((tokens, index) => {
              const line = index + 1;
              const isChanged = changed.has(line);
              const classes = ['line', isChanged ? changeClass : '', isCited(line) ? 'cited' : '']
                .filter(Boolean)
                .join(' ');
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional by nature.
                <div key={index} className={classes} data-line={line}>
                  <span className="line-number">{line}</span>
                  <span className="line-mark">{isChanged ? changeMark : ''}</span>
                  <span className="line-text">
                    {tokens.map((token, t) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional too.
                      <span key={t} style={tokenStyle(token)}>
                        {token.text}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <div className="legend" aria-hidden="true">
        {changed.size > 0 && (
          <span>
            <i className={`swatch ${changeClass}`} />
            {side === 'new' ? 'Added in this PR' : 'Removed by this PR'}
          </span>
        )}
        {cited.length > 0 && (
          <span>
            <i className="swatch cited" />
            Cited by this stop
          </span>
        )}
        <span className="legend-keys">
          <kbd>←</kbd> <kbd>→</kbd> stops · <kbd>↑</kbd> <kbd>↓</kbd> read on
        </span>
        <span className="legend-keys">
          <kbd>{MOD_LABEL}</kbd> click or <kbd>Enter</kbd> on a name · its definition
        </span>
      </div>
      {popover && (
        <DefinitionPopover
          found={popover.found}
          at={popover.at}
          onPick={(to) => {
            setPopover(null);
            onJump(to);
          }}
          onClose={closePopover}
        />
      )}
    </>
  );
}

/** Both themes' colors ride along as CSS variables; styles.css picks the one for the page's theme. */
function tokenStyle({ dark, light }: Token): CSSProperties | undefined {
  if (!dark && !light) return undefined;
  return { '--token-dark': dark, '--token-light': light } as CSSProperties;
}

const lineAt = (box: HTMLElement, line: number) =>
  box.querySelector<HTMLElement>(`[data-line="${line}"]`);

/** A box on screen, in viewport coordinates. */
type Box = { left: number; top: number; bottom: number };
/** What a jump starts from: the target, its line, and where it sits on screen. */
type Hit = { target: JumpTarget; line: number; range: TextRange; box: Box };
/** The DOM's Range; this file's own Range is a span of lines. */
type TextRange = globalThis.Range;

const isJumpClick = (event: ReactMouseEvent) =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.button === 0;

/** The name or import under the pointer, if the pointer is on it, not just near it. */
function hitAtPoint(x: number, y: number): Hit | null {
  const caret = caretAt(x, y);
  if (!caret) return null;
  const hit = hitAt(caret.node, caret.offset);
  if (!hit) return null;
  const inside = [...hit.range.getClientRects()].some(
    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
  );
  return inside ? hit : null;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const at = document.caretPositionFromPoint(x, y);
    return at ? { node: at.offsetNode, offset: at.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The target at a point in the text: a node and an offset, as a caret or selection gives. */
function hitAt(node: Node, offset: number): Hit | null {
  const element = node instanceof Element ? node : node.parentElement;
  const text = element?.closest<HTMLElement>('.line-text');
  const line = text?.closest<HTMLElement>('.line');
  if (!text || !line) return null;
  const before = document.createRange();
  before.setStart(text, 0);
  before.setEnd(node, offset);
  const target = targetAt(text.textContent ?? '', before.toString().length);
  if (!target) return null;
  const range = rangeIn(text, target.start, target.end);
  if (!range) return null;
  const { left, top, bottom } = range.getBoundingClientRect();
  return { target, line: Number(line.dataset.line), range, box: { left, top, bottom } };
}

/** A range over characters `start` to `end` of an element's text. */
function rangeIn(element: HTMLElement, start: number, end: number): TextRange | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= seen + length) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}
