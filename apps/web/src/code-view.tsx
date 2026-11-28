import { lineCount } from '@docent/core';
import { useQuery } from '@tanstack/react-query';
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
import { ReferencesPanel } from './references-panel.tsx';

export type Range = { startLine: number; endLine: number };

type Props = {
  path: string;
  side: 'old' | 'new';
  /** Every range this stop cites in this file. */
  cited: readonly Range[];
  /** The range to bring into view, or null to show the top of the file. */
  focus: Range | null;
  /**
   * Lines a phrase of the stop points at, while it's hovered or focused: marked, and scrolled
   * into view only if they're not in view already.
   */
  named: Range | null;
  /** Line numbers changed by the PR on this side: added at head, removed at base. */
  changed: ReadonlySet<number>;
  /** Changed lines on this side that no stop cites and no script proved (the ledger's rest). */
  offRoute: ReadonlySet<number>;
  /**
   * Moves to the stop's next (1) or previous (-1) citation. Returns false when there is none,
   * and the arrow keys then scroll the file instead. Absent when no citation is in focus.
   */
  onStep: ((delta: 1 | -1) => boolean) | undefined;
  /** Opens the place a jump to definition, an import or a reference found. */
  onJump: (to: JumpTo) => void;
  /** Opens a comment on a line: a "+" shows in the gutter on hover. Absent once comments close. */
  onComment?: ((line: number) => void) | undefined;
  /** What sits under a line, like GitHub: the reviewer's drafts and the open composer. */
  below?: ((line: number) => ReactNode) | undefined;
  /** The line a comment is being written on. */
  commentLine?: number | null | undefined;
};

/** The modifier key for a jump, as this platform's keyboards print it. */
const MOD_LABEL = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Room left around a citation when ↑ ↓ reveal its edges. */
const REVEAL_PADDING = 48;

/** A file's text, and its lines as colored tokens: fetched once, shared by every view of it. */
export function useFile(path: string, side: 'old' | 'new') {
  const text = useQuery(fileTextQuery(path, side));
  const highlighted = useQuery({
    queryKey: ['highlight', side, path],
    queryFn: async () => {
      const source = text.data ?? '';
      // Only the file's real lines: a final newline doesn't add an empty one to comment on.
      return (await highlight(path, source)).slice(0, lineCount(source));
    },
    enabled: text.data !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // The cached array itself, so effects keyed on it run once per file, not once per render.
  return { text, lines: highlighted.data };
}

/** One line's tokens, colored for both themes. */
export function LineTokens({ tokens }: { tokens: readonly Token[] }) {
  return tokens.map((token, t) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional.
    <span key={t} style={tokenStyle(token)}>
      {token.text}
    </span>
  ));
}

/** A read-only view of one file, with the PR's changes and the stop's citations marked. */
export function CodeView({
  path,
  side,
  cited,
  focus,
  named,
  changed,
  offRoute,
  onStep,
  onJump,
  onComment,
  below,
  commentLine,
}: Props) {
  const { text, lines } = useFile(path, side);

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

  const namedStart = named?.startLine ?? null;
  const namedEnd = named?.endLine ?? null;
  useEffect(() => {
    const box = scroller.current;
    if (!box || !lines || namedStart === null || namedEnd === null) return;
    const first = lineAt(box, namedStart);
    const last = lineAt(box, namedEnd) ?? first;
    if (!first || !last) return;
    const top = first.offsetTop;
    const bottom = last.offsetTop + last.offsetHeight;
    if (top >= box.scrollTop && bottom <= box.scrollTop + box.clientHeight) return;
    const span = bottom - top;
    const target =
      span < box.clientHeight * 0.8 ? top - (box.clientHeight - span) / 2 : top - REVEAL_PADDING;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ top: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' });
  }, [lines, namedStart, namedEnd]);

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
  const [popover, setPopover] = useState<{ found: Found; hit: Hit } | null>(null);
  // The name whose references are listed under the code. The list stays as files change, so
  // the reviewer can open one result after another.
  const [references, setReferences] = useState<string | null>(null);
  const closeReferences = useCallback(() => {
    setReferences(null);
    scroller.current?.focus({ preventScroll: true });
  }, []);
  const [hovering, setHovering] = useState(false);
  const lookups = useRef(0);
  // Closing also drops a lookup still under way, so its answer can't land after the reviewer
  // has moved on.
  const closePopover = useCallback(() => {
    lookups.current += 1;
    setPopover(null);
  }, []);
  // A new file, a new stop or leaving the code view closes the popover and its lookup.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path and side are the triggers.
  useEffect(() => closePopover, [path, side, closePopover]);

  const findReferences = (name: string) => {
    closePopover();
    setReferences(name);
  };

  const jump = async (hit: Hit) => {
    if (hit.wants === 'references') {
      if (hit.target.kind === 'symbol') findReferences(hit.target.name);
      return;
    }
    const id = ++lookups.current;
    const name = hit.target.kind === 'symbol' ? hit.target.name : hit.target.spec;
    setPopover({ found: { kind: 'loading', name }, hit });
    const found = await lookUp(hit.target, { path, side, line: hit.line });
    if (id !== lookups.current) return;
    if ('path' in found) {
      setPopover(null);
      onJump(found);
    } else {
      setPopover({ found, hit });
    }
  };

  const onMouseDown = (event: ReactMouseEvent) => {
    // Keep the selection as it was: a ⌘-click is a jump, not a click into the text.
    if (clickWants(event)) event.preventDefault();
  };
  const onClick = (event: ReactMouseEvent) => {
    const wants = clickWants(event);
    if (!wants) return;
    const hit = hitAtPoint(event.clientX, event.clientY, wants);
    if (!hit) return;
    event.preventDefault();
    void jump(hit);
  };
  const clearHover = useCallback(() => {
    setHovering(false);
    CSS.highlights?.delete('jump');
  }, []);
  const onMouseMove = (event: ReactMouseEvent) => {
    const wants = clickWants(event);
    const hit = wants ? hitAtPoint(event.clientX, event.clientY, wants) : null;
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
  // Enter or F12 jumps to the definition; with Shift, they list the references.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== 'F12') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Enter in a comment under a line is the reviewer's typing, never a jump.
    if ((event.target as HTMLElement).closest('textarea, input, button')) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const wants = event.shiftKey ? 'references' : 'definition';
    const hit = hitAt(range.startContainer, range.startOffset, wants);
    if (!hit) return;
    event.preventDefault();
    void jump(hit);
  };

  const isCited = (line: number) => cited.some((r) => line >= r.startLine && line <= r.endLine);
  const isNamed = (line: number) =>
    named !== null && line >= named.startLine && line <= named.endLine;
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
        aria-label={`${path}, ${MOD_LABEL}-click a name, or select it and press Enter, to jump to its definition. Add Shift to list its references.`}
        data-jump={hovering ? '' : undefined}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseLeave={clearHover}
        onKeyDown={onKeyDown}
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
              const classes = [
                'line',
                isChanged ? changeClass : '',
                isCited(line) ? 'cited' : '',
                isNamed(line) ? 'named' : '',
                isChanged && offRoute.has(line) ? 'off-route' : '',
                commentLine === line ? 'commenting' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional by nature.
                <Fragment key={index}>
                  <div className={classes} data-line={line}>
                    {onComment && (
                      <button
                        type="button"
                        className="add-comment"
                        aria-label={`Comment on line ${line}`}
                        // Out of the tab order: a file has a button per line. Click to comment.
                        tabIndex={-1}
                        onClick={() => onComment(line)}
                      >
                        +
                      </button>
                    )}
                    <span className="line-number">{line}</span>
                    <span className="line-mark">{isChanged ? changeMark : ''}</span>
                    <span className="line-text">
                      <LineTokens tokens={tokens} />
                    </span>
                  </div>
                  {below?.(line)}
                </Fragment>
              );
            })}
          </div>
        )}
      </section>
      {references && (
        <ReferencesPanel
          key={references}
          name={references}
          current={{ path, line: side === 'new' ? (focus?.startLine ?? null) : null }}
          onOpen={onJump}
          onClose={closeReferences}
        />
      )}
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
        {named && (
          <span>
            <i className="swatch named" />
            Named in the text
          </span>
        )}
        {offRoute.size > 0 && (
          <span>
            <i className="swatch off-route" />
            Not on the route
          </span>
        )}
        <span className="legend-keys">
          <kbd>←</kbd> <kbd>→</kbd> stops · <kbd>↑</kbd> <kbd>↓</kbd> read on
        </span>
        <span className="legend-keys">
          <kbd>{MOD_LABEL}</kbd> click or <kbd>Enter</kbd> on a name · its definition
        </span>
        <span className="legend-keys">
          add <kbd>⇧</kbd> · its references
        </span>
      </div>
      {popover && (
        <DefinitionPopover
          found={popover.found}
          at={popover.hit.box}
          name={popover.hit.range}
          onPick={(to) => {
            setPopover(null);
            onJump(to);
          }}
          onReferences={findReferences}
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
/** What a click or key asks for: a name's definition, or every use of it. */
type Wants = 'definition' | 'references';
/** What a jump starts from: the target, its line, where it sits on screen, and what's wanted. */
type Hit = { target: JumpTarget; line: number; range: TextRange; box: Box; wants: Wants };
/** The DOM's Range; this file's own Range is a span of lines. */
type TextRange = globalThis.Range;

/** ⌘-click (Ctrl-click elsewhere) is a jump; with Shift, the references. Else null. */
const clickWants = (event: ReactMouseEvent): Wants | null => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.button !== 0) return null;
  return event.shiftKey ? 'references' : 'definition';
};

/** The name or import under the pointer, if the pointer is on it, not just near it. */
function hitAtPoint(x: number, y: number, wants: Wants): Hit | null {
  const caret = caretAt(x, y);
  if (!caret) return null;
  const hit = hitAt(caret.node, caret.offset, wants);
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

/**
 * The target at a point in the text: a node and an offset, as a caret or selection gives. Only
 * a name has references; an import specifier doesn't.
 */
function hitAt(node: Node, offset: number, wants: Wants): Hit | null {
  const element = node instanceof Element ? node : node.parentElement;
  const text = element?.closest<HTMLElement>('.line-text');
  const line = text?.closest<HTMLElement>('.line');
  if (!text || !line) return null;
  const before = document.createRange();
  before.setStart(text, 0);
  before.setEnd(node, offset);
  const target = targetAt(text.textContent ?? '', before.toString().length);
  if (!target || (wants === 'references' && target.kind !== 'symbol')) return null;
  const range = rangeIn(text, target.start, target.end);
  if (!range) return null;
  const { left, top, bottom } = range.getBoundingClientRect();
  return { target, line: Number(line.dataset.line), range, box: { left, top, bottom }, wants };
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
