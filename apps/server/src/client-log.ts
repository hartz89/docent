// What the web app may report for the run log: its own errors, and a few screen events. Each kind
// has a fixed set of fields with fixed limits, so a page can't fill the log with anything else.
// No keystrokes, no pointer movement, and never the page URL (its fragment holds the token).

const WIDTHS = ['<640', '640-1023', '1024-1439', '1440+'] as const;
const THEMES = ['light', 'dark'] as const;
const CHOICES = ['light', 'dark', 'system'] as const;
const SOURCES = ['window', 'promise', 'api'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Printable text: no control characters at all, not even newlines. */
const LINE = /^[^\p{Cc}]*$/u;

export type ClientEvent =
  | {
      kind: 'client.error';
      source: (typeof SOURCES)[number];
      message: string;
      stack?: string;
      method?: (typeof METHODS)[number];
      path?: string;
      status?: number;
    }
  | { kind: 'ui.stop'; stop: number; stopId: string }
  | { kind: 'ui.viewport'; width: (typeof WIDTHS)[number] }
  | { kind: 'ui.theme'; theme: (typeof THEMES)[number]; choice: (typeof CHOICES)[number] };

/** A ClientEvent with only its known fields, or why the body isn't one. */
export function clientEvent(body: unknown): ClientEvent | string {
  if (typeof body !== 'object' || body === null) return 'Send a JSON object';
  const b = body as Record<string, unknown>;
  switch (b.kind) {
    case 'client.error': {
      if (!oneOf(SOURCES, b.source)) return `source must be one of ${SOURCES.join(', ')}`;
      const message = text(b.message, 1000, true);
      if (message === null) return 'message must be a line of up to 1000 characters';
      const event: ClientEvent = { kind: 'client.error', source: b.source, message };
      if (b.stack !== undefined) {
        const stack = text(b.stack, 4000, false);
        if (stack === null) return 'stack must be text of up to 4000 characters';
        event.stack = stack;
      }
      if (b.method !== undefined) {
        if (!oneOf(METHODS, b.method)) return 'method must be an HTTP method';
        event.method = b.method;
      }
      if (b.path !== undefined) {
        const path = text(b.path, 300, true);
        if (path === null || !path.startsWith('/api/')) return 'path must be an /api/ path';
        event.path = path;
      }
      if (b.status !== undefined) {
        if (!Number.isInteger(b.status) || (b.status as number) < 0 || (b.status as number) > 599) {
          return 'status must be an HTTP status';
        }
        event.status = b.status as number;
      }
      return event;
    }
    case 'ui.stop': {
      const stopId = text(b.stopId, 100, true);
      if (!Number.isInteger(b.stop) || (b.stop as number) < 1 || (b.stop as number) > 1000) {
        return 'stop must be a stop number';
      }
      if (stopId === null) return 'stopId must be a line of up to 100 characters';
      return { kind: 'ui.stop', stop: b.stop as number, stopId };
    }
    case 'ui.viewport':
      if (!oneOf(WIDTHS, b.width)) return `width must be one of ${WIDTHS.join(', ')}`;
      return { kind: 'ui.viewport', width: b.width };
    case 'ui.theme':
      if (!oneOf(THEMES, b.theme) || !oneOf(CHOICES, b.choice)) {
        return 'Send a theme (light, dark) and a choice (light, dark, system)';
      }
      return { kind: 'ui.theme', theme: b.theme, choice: b.choice };
    default:
      return 'kind must be client.error, ui.stop, ui.viewport or ui.theme';
  }
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T);
}

/** The text if it's a string within the limit; single-line text may hold no control characters. */
function text(value: unknown, max: number, singleLine: boolean): string | null {
  if (typeof value !== 'string' || value.length > max) return null;
  if (singleLine && !LINE.test(value)) return null;
  return value;
}

/** At most `perMinute` reports in any one-minute window, and `total` for the whole launch. */
export class RateLimit {
  #perMinute: number;
  #left: number;
  #recent: number[] = [];

  constructor(perMinute: number, total: number) {
    this.#perMinute = perMinute;
    this.#left = total;
  }

  take(now: number): boolean {
    this.#recent = this.#recent.filter((t) => now - t < 60_000);
    if (this.#left <= 0 || this.#recent.length >= this.#perMinute) return false;
    this.#recent.push(now);
    this.#left--;
    return true;
  }
}
