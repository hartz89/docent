// The launcher: `docent serve` keeps it running on a fixed localhost port, so a link in a brief can
// open a review without a terminal. Any website can link here, so it does as little as it can:
// - GET /open only shows a confirm page. It never starts anything.
// - A click on that page (a same-origin POST carrying the page's CSRF token) starts the review,
//   then redirects the browser to it with that review's per-launch token.
// See docs/launcher.md for the threat model.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { parsePrUrl } from './github.ts';

/** What the confirm page shows about a PR. Read from GitHub (or a fixture); never acted on. */
export type PrPreview = {
  /** The PR's canonical URL: https://github.com/<owner>/<name>/pull/<number>. */
  url: string;
  repo: string;
  number: number;
  title: string;
  /** The PR author's login. Anyone can open a PR on a public repo, so the page says who did. */
  author: string;
  /** The head branch lives in a fork, not in the repo itself. */
  fromFork: boolean;
  head: string;
  /** A finished tour for this head commit is in the cache, so opening it costs nothing. */
  cached: boolean;
};

/** A running review server, as `startServer` returns it, plus whether its tour failed. */
export type OpenedReview = {
  origin: string;
  token: string;
  close: () => Promise<void>;
  /** The tour failed, so reopening should start afresh rather than show the failure again. */
  failed: () => boolean;
};

export type LauncherOptions = {
  /** The launcher's own port. Requests must name it in their Host. */
  port: number;
  /** `owner/name` pairs that links may open. Anything else gets a refusal page. */
  allowedRepos: readonly string[];
  /** Where the allow list lives, so the refusal page can say how to change it. */
  configPath: string;
  /** Reads a PR's title and head, and whether its tour is cached. Must not start anything. */
  preview: (url: string) => Promise<PrPreview>;
  /** Starts a review server for a PR. Called only after a confirmed POST. */
  start: (pr: PrPreview) => Promise<OpenedReview>;
  /** The clock, for the rate limit. */
  now?: () => number;
  /** Where to say that a review server was closed to make room. */
  log?: (line: string) => void;
};

/** What a fresh tour costs, roughly, on the default model. Shown on the confirm page. */
export const ESTIMATED_TOUR_USD = 1;
/** At most this many new reviews start in any window of START_WINDOW_MS. Reopening is free. */
export const MAX_STARTS = 5;
export const START_WINDOW_MS = 5 * 60_000;
/** Open review servers beyond this close, least recently opened first. */
export const MAX_OPEN_REVIEWS = 10;
/** How long a PR's preview is reused, so reloads and the confirm click don't re-ask GitHub. */
const PREVIEW_TTL_MS = 30_000;
/** At most this many PR lookups run at once; more get a "busy" page. */
export const MAX_LOOKUPS = 4;

/**
 * Arms the confirm button. It stays disabled (no click, no Enter) until this tab is visible and
 * focused and has seen the reviewer's pointer or keys for half a second, and it disarms whenever
 * the tab loses focus. A page that pops up over this one and asks for a double click, closing
 * itself on the first, can't land the second click on an armed button.
 */
const ARM_SCRIPT = `const b = document.querySelector('button[type=submit]');
let timer;
const disarm = () => { b.disabled = true; clearTimeout(timer); timer = undefined; };
const arm = () => {
  if (document.visibilityState !== 'visible' || !document.hasFocus() || timer || !b.disabled) return;
  timer = setTimeout(() => { b.disabled = false; }, 500);
};
addEventListener('pointermove', arm);
addEventListener('keydown', arm);
addEventListener('blur', disarm);
document.addEventListener('visibilitychange', disarm);`;
const ARM_SCRIPT_HASH = `sha256-${createHash('sha256').update(ARM_SCRIPT).digest('base64')}`;

/**
 * Headers on every launcher response, unless a route sets its own. No framing (clickjacking),
 * no scripts, no Referer, no caching (the confirm page holds a CSRF token), and no other origin
 * may embed or open-and-read what we send. Forms may post to ourselves, and the confirm redirect may go to a review server
 * on another 127.0.0.1 port (Chrome applies form-action to redirects).
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': `default-src 'none'; script-src '${ARM_SCRIPT_HASH}'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'`,
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

type Entry = { head: string; review: Promise<OpenedReview>; opened: number };

export function createLauncher(options: LauncherOptions) {
  const { port, configPath, preview, start } = options;
  const now = options.now ?? Date.now;
  const allowed = new Set(options.allowedRepos.map((repo) => repo.toLowerCase()));
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  // Per process: a token from an earlier launch, or from another machine, never validates. It
  // binds the commit the page showed, so a click never starts a head whose cost it didn't state.
  const secret = randomBytes(32);
  const csrfFor = (pr: { url: string; head: string }) =>
    createHmac('sha256', secret).update(`${pr.url}\n${pr.head}`).digest('base64url');

  const previews = new Map<string, { at: number; pr: Promise<PrPreview> }>();
  let lookups = 0;
  /** The PR's preview, reused for a short while. 'busy' when too many lookups are running. */
  const cachedPreview = (url: string): Promise<PrPreview> | 'busy' => {
    for (const [key, { at }] of previews) {
      if (now() - at >= PREVIEW_TTL_MS) previews.delete(key);
    }
    const hit = previews.get(url);
    if (hit) return hit.pr;
    if (lookups >= MAX_LOOKUPS) return 'busy';
    lookups++;
    const pr = preview(url);
    previews.set(url, { at: now(), pr });
    // A failed lookup isn't remembered, so a retry asks again.
    pr.catch(() => previews.delete(url)).finally(() => lookups--);
    return pr;
  };
  /** Looks the PR up, or returns a page saying why it couldn't. */
  const lookUp = async (url: string): Promise<PrPreview | { html: string; status: 502 | 503 }> => {
    const pending = cachedPreview(url);
    if (pending === 'busy') {
      return {
        status: 503,
        html: page(
          'Busy',
          `<h1>The launcher is busy</h1>
          <p>It's looking up several pull requests already. <a href="${escapeHtml(openLink(url))}">Try again</a> in a moment.</p>`,
        ),
      };
    }
    try {
      return await pending;
    } catch (error) {
      return { status: 502, html: couldNotRead(url, error) };
    }
  };

  const open = new Map<string, Entry>();
  let starts: number[] = [];

  /**
   * Reuses the PR's review server if it's at the same head and its tour hasn't failed. Otherwise
   * starts one, if the rate limit allows.
   */
  async function openReview(pr: PrPreview): Promise<OpenedReview | 'rate-limited'> {
    const existing = open.get(pr.url);
    if (existing?.head === pr.head) {
      existing.opened = now();
      try {
        const review = await existing.review;
        if (!review.failed()) return review;
      } catch {
        // It failed to start. Fall through and try again, which counts as a new start.
      }
    }
    starts = starts.filter((at) => now() - at < START_WINDOW_MS);
    if (starts.length >= MAX_STARTS) return 'rate-limited';
    starts.push(now());

    if (existing) void closeEntry(pr.url, existing);
    const entry: Entry = { head: pr.head, review: start(pr), opened: now() };
    open.set(pr.url, entry);
    entry.review.catch(() => open.get(pr.url) === entry && open.delete(pr.url));
    while (open.size > MAX_OPEN_REVIEWS) {
      const [oldestUrl, oldest] = [...open].sort(([, a], [, b]) => a.opened - b.opened)[0] ?? [];
      if (!oldestUrl || !oldest) break;
      options.log?.(
        `Closed the review of ${oldestUrl} to make room: at most ${MAX_OPEN_REVIEWS} stay open.`,
      );
      void closeEntry(oldestUrl, oldest);
    }
    return entry.review;
  }

  async function closeEntry(url: string, entry: Entry) {
    if (open.get(url) === entry) open.delete(url);
    try {
      await (await entry.review).close();
    } catch {}
  }

  const app = new Hono()
    .use(
      createMiddleware(async (c, next) => {
        await next();
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
          if (!c.res.headers.has(name)) c.header(name, value);
        }
      }),
    )
    // DNS rebinding: evil.example can resolve to 127.0.0.1, but its requests still name
    // evil.example. Check the Host header itself too, since an absolute-form request target
    // (GET http://127.0.0.1:<port>/ HTTP/1.1) would otherwise set the URL without it.
    .use(
      createMiddleware(async (c, next) => {
        const header = c.req.header('host');
        if (!hosts.has(new URL(c.req.url).host) || (header !== undefined && !hosts.has(header))) {
          return c.text(`Forbidden: open this through http://127.0.0.1:${port}`, 403);
        }
        await next();
      }),
    )
    .get('/', (c) =>
      c.html(
        page(
          'Docent launcher',
          `<h1>Docent is ready to open reviews</h1>
          <p>Open a pull request with a link like
          <code>http://127.0.0.1:${port}/open?pr=https://github.com/owner/repo/pull/1</code>.
          You'll be asked to confirm before anything starts.</p>`,
        ),
      ),
    )
    .get('/open', async (c) => {
      // Only a page load in a tab, never an image, script, fetch or prefetch: other sites can't
      // make the launcher look PRs up in the background. Browsers without Fetch Metadata skip
      // these checks; the lookup cap and the allow list still bound what they can cause.
      const dest = c.req.header('sec-fetch-dest');
      const mode = c.req.header('sec-fetch-mode');
      const purpose = c.req.header('sec-purpose') ?? c.req.header('purpose') ?? '';
      if (
        (dest !== undefined && dest !== 'document') ||
        (mode !== undefined && mode !== 'navigate') ||
        /prefetch|prerender/i.test(purpose)
      ) {
        return c.text('Forbidden: open this link in a browser tab', 403);
      }
      const target = checkTarget(c.req.query('pr'));
      if (target.refusal) return c.html(target.refusal.html, target.refusal.status);

      const pr = await lookUp(target.url);
      if ('html' in pr) return c.html(pr.html, pr.status);
      // The page's own POST must carry its real Origin, and under no-referrer browsers send
      // `Origin: null` instead. same-origin still sends nothing to any other origin.
      return c.html(confirmPage(pr, csrfFor(pr)), 200, { 'Referrer-Policy': 'same-origin' });
    })
    .post('/open', async (c) => {
      // Cross-site requests: a browser always sends Origin on a POST, and a page on another
      // site can't make it ours. Fetch Metadata, when present, must agree.
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      const ownOrigin = `http://${new URL(c.req.url).host}`;
      if (origin !== ownOrigin || (site !== undefined && site !== 'same-origin')) {
        return c.text('Forbidden: reviews start only from the launcher’s own confirm page', 403);
      }
      const form = await c.req.parseBody();
      const target = checkTarget(typeof form.pr === 'string' ? form.pr : undefined);
      if (target.refusal) return c.html(target.refusal.html, target.refusal.status);
      const head = typeof form.head === 'string' ? form.head : '';
      if (!sameSecret(form.csrf, csrfFor({ url: target.url, head }))) {
        return c.html(
          page(
            'Confirm page expired',
            `<h1>This confirm page has expired</h1>
            <p>The launcher restarted since it was opened, so nothing started.
            <a href="${escapeHtml(openLink(target.url))}">Open it again</a> to confirm.</p>`,
          ),
          403,
        );
      }

      const pr = await lookUp(target.url);
      if ('html' in pr) return c.html(pr.html, pr.status);
      if (pr.head !== head) {
        // Pushed to since the page was shown: its cost line may be wrong. Show the page again.
        return c.html(
          confirmPage(pr, csrfFor(pr), 'The pull request changed since that page opened.'),
          409,
          { 'Referrer-Policy': 'same-origin' },
        );
      }
      let review: OpenedReview | 'rate-limited';
      try {
        review = await openReview(pr);
      } catch (error) {
        return c.html(failedToStart(pr, error), 500);
      }
      if (review === 'rate-limited') {
        return c.html(
          page(
            'Too many reviews',
            `<h1>Too many reviews started just now</h1>
            <p>The launcher starts at most ${MAX_STARTS} reviews every ${START_WINDOW_MS / 60_000} minutes, so a runaway page can't spend money. Wait a few minutes, then
            <a href="${escapeHtml(openLink(pr.url))}">open it again</a>.</p>`,
          ),
          429,
        );
      }
      // The token rides in the fragment, which browsers never send to servers or in a Referer.
      return c.redirect(`${review.origin}/#token=${review.token}`, 303);
    });

  /** The PR URL, canonical, if it's a GitHub PR in an allowed repo. Otherwise a page saying no. */
  function checkTarget(
    raw: string | undefined,
  ):
    | { url: string; refusal?: never }
    | { url?: never; refusal: { html: string; status: 400 | 403 } } {
    const ref = raw ? parsePrUrl(raw) : null;
    if (!ref) {
      return {
        refusal: {
          status: 400,
          html: page(
            'Not a pull request',
            `<h1>That isn't a pull request link</h1>
            <p>Links to the launcher look like <code>/open?pr=https://github.com/owner/repo/pull/1</code>.</p>`,
          ),
        },
      };
    }
    const repo = `${ref.owner}/${ref.name}`;
    if (!allowed.has(repo.toLowerCase())) {
      return {
        refusal: {
          status: 403,
          html: page(
            'Repository not allowed',
            `<h1>Docent doesn't open links for ${escapeHtml(repo)}</h1>
            <p>Links can only open pull requests in the repositories on your allow list.
            To allow this one, add <code>"${escapeHtml(repo)}"</code> to <code>allowedRepos</code> in
            <code>${escapeHtml(configPath)}</code>, then restart the launcher.</p>
            ${allowed.size ? `<p class="quiet">Allowed now: ${[...options.allowedRepos].map(escapeHtml).join(', ')}.</p>` : '<p class="quiet">No repositories are allowed yet.</p>'}`,
          ),
        },
      };
    }
    return { url: `https://github.com/${repo}/pull/${ref.number}` };
  }

  return {
    app,
    /** Closes every review server the launcher started. */
    close: async () => {
      await Promise.all([...open].map(([url, entry]) => closeEntry(url, entry)));
    },
  };
}

function sameSecret(sent: unknown, expected: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The launcher's own link to a PR's confirm page. */
function openLink(url: string): string {
  return `/open?pr=${encodeURIComponent(url)}`;
}

function confirmPage(pr: PrPreview, csrf: string, notice?: string): string {
  const repo = escapeHtml(pr.repo);
  const cost = pr.cached
    ? `<p class="cost cached"><strong>Cached, no cost.</strong> A tour for this commit is already written.</p>`
    : `<p class="cost"><strong>About $${ESTIMATED_TOUR_USD} to write.</strong> No tour is cached for this commit yet, so Docent will write one on your Claude plan. That takes a few minutes.</p>`;
  return page(
    `Open ${pr.repo}#${pr.number}?`,
    `<h1>Open this review?</h1>
    ${notice ? `<p class="notice">${escapeHtml(notice)} Check it again before you start.</p>` : ''}
    <div class="pr">
      <div class="quiet">${repo} · #${pr.number} · <code>${escapeHtml(pr.head.slice(0, 7))}</code></div>
      <div class="title">${escapeHtml(pr.title)}</div>
      <div class="quiet">by <strong class="author">${escapeHtml(pr.author)}</strong>${pr.fromFork ? ' · <span class="fork">from a fork</span>' : ''}</div>
    </div>
    ${cost}
    <form method="post" action="/open">
      <input type="hidden" name="pr" value="${escapeHtml(pr.url)}">
      <input type="hidden" name="head" value="${escapeHtml(pr.head)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" disabled>Start the review</button>
    </form>
    <p class="quiet">A link opened this page. Nothing starts until you click. The title is the
    author's own words, so check who wrote it.</p>
    <noscript><p class="notice">The button needs JavaScript, which guards it against
    click tricks.</p></noscript>
    <script>${ARM_SCRIPT}</script>`,
  );
}

function couldNotRead(url: string, error: unknown): string {
  return page(
    'Could not read the pull request',
    `<h1>Couldn't read that pull request</h1>
    <p><code>${escapeHtml(url)}</code></p>
    <p class="quiet">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
  );
}

function failedToStart(pr: PrPreview, error: unknown): string {
  return page(
    'Could not start the review',
    `<h1>The review didn't start</h1>
    <p>${escapeHtml(pr.repo)}#${pr.number}: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
  );
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

/** A small self-contained page in the web app's colors. Its only script is ARM_SCRIPT. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Docent</title>
<style>
  /* The web app's palette (apps/web/src/styles.css): dark by default, paper and ink in light. */
  :root { color-scheme: dark; --ground: #12151a; --panel: #151920; --border: #252a33; --text: #dfe3e8; --muted: #8e97a3; --brass-text: #d9b06a; --brass-fill: #d9b06a; --brass-ink: #1b160d; --ok: #7fbf8e; }
  @media (prefers-color-scheme: light) { :root { color-scheme: light; --ground: #fcfbf8; --panel: #f5f3ee; --border: #e5e1d8; --text: #1d2126; --muted: #5e6570; --brass-text: #835710; --brass-fill: #94661a; --brass-ink: #fff; --ok: #287a41; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--ground); color: var(--text); font: 15px/1.55 system-ui, -apple-system, sans-serif; }
  main { width: 100%; max-width: 520px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  h1 { font: 500 24px/1.25 Georgia, serif; margin: 0 0 18px; }
  .pr { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
  .title { font-weight: 600; margin-top: 4px; overflow-wrap: anywhere; }
  .quiet { color: var(--muted); font-size: 13px; }
  .cost strong, .notice { color: var(--brass-text); }
  a { color: var(--brass-text); }
  .cost.cached strong { color: var(--ok); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
  button { font: inherit; font-weight: 600; color: var(--brass-ink); background: var(--brass-fill); border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer; }
  button:disabled { cursor: default; opacity: 0.55; }
  button:enabled:hover { filter: brightness(1.06); }
  .author { color: var(--text); font-weight: 600; }
  .fork { color: var(--brass-text); }
  button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
