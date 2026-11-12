import { type ReactNode, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Below this width the route leaves its column and opens as a drawer. Keep it in step with the
 * `max-width: 1199px` media queries in styles.css.
 */
export const DRAWER_QUERY = '(max-width: 1199px)';

/** Below this width the layout stacks for a phone. Keep it in step with `max-width: 799px`. */
export const STACKED_QUERY = '(max-width: 799px)';

/** Whether a media query matches, kept current as the window resizes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/**
 * The route as a slide-out drawer, for narrow windows. A modal <dialog> does the hard parts: it
 * keeps focus inside while open, closes on Esc, and hides the page behind it from screen readers.
 * Opening focuses the current stop; closing returns focus to whatever opened it.
 */
export function RouteDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const box = dialog.current;
    if (!box) return;
    if (open && !box.open) {
      opener.current = document.activeElement as HTMLElement | null;
      box.showModal();
      box.querySelector<HTMLElement>('[aria-current="step"]')?.focus();
    } else if (!open && box.open) {
      box.close();
    }
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is for the backdrop; keyboards close with Esc, or the close button.
    <dialog
      ref={dialog}
      className="route-drawer"
      aria-label="The route"
      onClose={() => {
        onClose();
        opener.current?.focus();
        opener.current = null;
      }}
      // A click on the backdrop lands on the dialog itself; clicks inside land on its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="route-drawer-body">
        <button
          type="button"
          className="icon-button route-drawer-close"
          aria-label="Close the route"
          onClick={onClose}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        {/* Unnamed: the dialog already carries the name, and saying it twice is noise. */}
        <nav>{children}</nav>
      </div>
    </dialog>
  );
}

/** The icon on every button that opens the route: a short list. */
export function RouteIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="3" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
    </svg>
  );
}
