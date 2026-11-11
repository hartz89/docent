// Light or dark. The page follows the system setting until the reader picks a theme in the top
// bar; that choice is remembered per browser. The inline script in index.html applies the same
// rule before the first paint, so the page never flashes the wrong theme. Keep the two in step.
import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
type Choice = Theme | 'system';

const KEY = 'docent:theme';
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
const listeners = new Set<() => void>();

let choice: Choice = readChoice();
/** What the toggle renders from. Replaced, never mutated, so React sees each change. */
let state = { choice, system: systemTheme() };

function readChoice(): Choice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    // Storage can be blocked (private windows, strict settings). Then the system decides.
    return 'system';
  }
}

function systemTheme(): Theme {
  return systemLight.matches ? 'light' : 'dark';
}

function apply() {
  state = { choice, system: systemTheme() };
  document.documentElement.dataset.theme = choice === 'system' ? state.system : choice;
  for (const listener of listeners) listener();
}

function choose(next: Choice) {
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Not remembered, but this page still switches.
  }
  apply();
}

systemLight.addEventListener('change', apply);
// A choice made in another tab applies here too.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  choice = readChoice();
  apply();
});
apply();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Each click shows a different theme where it can: from "system" it goes to the opposite of what
 * the system shows, then to the other explicit theme (which matches the system), then back.
 */
function nextChoice(current: Choice, system: Theme): Choice {
  const opposite: Theme = system === 'light' ? 'dark' : 'light';
  if (current === 'system') return opposite;
  if (current === opposite) return system;
  return 'system';
}

const LABEL: Record<Choice, string> = {
  system: 'Theme: matches your system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/** The top bar's theme switch. Its icon shows the current choice; each click moves to the next. */
export function ThemeToggle() {
  const { choice: current, system } = useSyncExternalStore(subscribe, () => state);
  const next = nextChoice(current, system);
  const label = `${LABEL[current]}. Switch to ${next === 'system' ? 'your system setting' : next}.`;
  return (
    <button
      type="button"
      className="icon-button"
      onClick={() => choose(next)}
      aria-label={label}
      title={label}
    >
      <ThemeIcon choice={current} />
    </button>
  );
}

function ThemeIcon({ choice }: { choice: Choice }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
  };
  if (choice === 'light') {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z" />
      </svg>
    );
  }
  // Following the system: half light, half dark.
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </svg>
  );
}
