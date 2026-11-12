import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  createLauncher,
  MAX_LOOKUPS,
  MAX_OPEN_REVIEWS,
  MAX_STARTS,
  type PrPreview,
  START_WINDOW_MS,
} from './launcher.ts';

// The launcher in-process. Its two boundaries are faked: reading a PR from GitHub, and starting a
// review server. Each test gets a fresh launcher, so starts and the rate limit don't leak.
const port = 4917;
const own = `http://127.0.0.1:${port}`;
const prUrl = 'https://github.com/hartz89/docent/pull/7';
const reviewToken = 'review-token-must-stay-secret';

function setup(overrides: Partial<PrPreview> = {}) {
  const previewed: string[] = [];
  const started: PrPreview[] = [];
  /** Origins of the review servers the launcher closed. */
  const closed: string[] = [];
  /** Origins of review servers whose tour has failed. */
  const failed = new Set<string>();
  let clock = 0;
  const heads = new Map<string, string>();
  const headOf = (url: string) => heads.get(url) ?? 'a'.repeat(40);
  const launcher = createLauncher({
    port,
    allowedRepos: ['hartz89/Docent'],
    configPath: '/home/me/.config/docent/config.json',
    now: () => clock,
    preview: async (url) => {
      previewed.push(url);
      const number = Number(url.split('/').at(-1));
      return {
        url,
        repo: 'hartz89/docent',
        number,
        title: 'Open a tour from a link',
        author: 'docent-builder',
        fromFork: false,
        head: headOf(url),
        cached: false,
        ...overrides,
      };
    },
    start: async (pr) => {
      started.push(pr);
      const origin = `http://127.0.0.1:${5000 + started.length}`;
      return {
        origin,
        token: reviewToken,
        close: async () => {
          closed.push(origin);
        },
        failed: () => failed.has(origin),
      };
    },
  });
  const { app } = launcher;
  return {
    app,
    previewed,
    started,
    closed,
    failed,
    tick: (ms: number) => {
      clock += ms;
    },
    setHead: (url: string, head: string) => heads.set(url, head),
    openPage: (url = prUrl, headers: Record<string, string> = {}) =>
      app.request(`${own}/open?pr=${encodeURIComponent(url)}`, { headers }),
    /** Loads the confirm page and returns the CSRF token embedded in it. */
    csrf: async (url = prUrl) => {
      const html = await (await app.request(`${own}/open?pr=${encodeURIComponent(url)}`)).text();
      return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
    },
    /** Posts the confirm form. Unless the test says otherwise, it names the PR's current head. */
    confirm: (form: Record<string, string>, headers: Record<string, string> = { Origin: own }) =>
      app.request(`${own}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ head: headOf(form.pr ?? ''), ...form }).toString(),
      }),
  };
}

describe('GET /open shows a confirm page and does nothing else', () => {
  test('names the PR and the cost of writing its tour, and starts nothing', async () => {
    const { openPage, started } = setup();

    const res = await openPage();
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Open a tour from a link');
    expect(html).toContain('hartz89/docent · #7');
    expect(html).toContain('About $1 to write.');
    expect(html).toContain('<form method="post" action="/open">');
    expect(started).toEqual([]);
  });

  test('names who wrote the PR, and says when it comes from a fork', async () => {
    const { openPage } = setup({ author: 'stranger', fromFork: true });

    const html = await (await openPage()).text();

    expect(html).toContain('by <strong class="author">stranger</strong>');
    expect(html).toContain('from a fork');
  });

  test('the button starts disabled, armed only by a script the page’s CSP allows by hash', async () => {
    const { openPage } = setup();

    const res = await openPage();
    const html = await res.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');

    expect(html).toContain('<button type="submit" disabled>');
    expect(res.headers.get('content-security-policy')).toContain(`script-src 'sha256-${hash}'`);
  });

  test('says a cached tour costs nothing', async () => {
    const { openPage } = setup({ cached: true });

    expect(await (await openPage()).text()).toContain('Cached, no cost.');
  });

  test('loading it many times still starts nothing', async () => {
    const { openPage, started } = setup();

    for (let i = 0; i < 5; i++) expect((await openPage()).status).toBe(200);

    expect(started).toEqual([]);
  });

  test('refuses image, script and fetch loads, so other sites cannot make it look PRs up', async () => {
    const { openPage, previewed } = setup();

    for (const dest of ['image', 'script', 'empty', 'iframe']) {
      expect((await openPage(prUrl, { 'Sec-Fetch-Dest': dest })).status).toBe(403);
    }
    expect((await openPage(prUrl, { 'Sec-Fetch-Mode': 'no-cors' })).status).toBe(403);
    expect((await openPage(prUrl, { 'Sec-Purpose': 'prefetch' })).status).toBe(403);
    expect((await openPage(prUrl, { 'Sec-Purpose': 'prefetch;prerender' })).status).toBe(403);
    expect(
      (await openPage(prUrl, { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' }))
        .status,
    ).toBe(200);
    expect(previewed).toHaveLength(1);
  });

  test('runs only a few PR lookups at once, so a flood of links cannot hammer GitHub', async () => {
    const { app } = createLauncher({
      port,
      allowedRepos: ['hartz89/docent'],
      configPath: '/config.json',
      preview: () => new Promise(() => {}), // GitHub never answers.
      start: () => Promise.reject(new Error('never')),
    });
    const open = (n: number) =>
      app.request(`${own}/open?pr=https://github.com/hartz89/docent/pull/${n}`);

    for (let n = 1; n <= MAX_LOOKUPS; n++) void open(n);
    const res = await open(MAX_LOOKUPS + 1);

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('The launcher is busy');
  });

  test('a lookup GitHub never answers gives up, and frees its slot', async () => {
    const { app } = createLauncher({
      port,
      allowedRepos: ['hartz89/docent'],
      configPath: '/config.json',
      lookupTimeoutMs: 20,
      preview: () => new Promise(() => {}), // GitHub never answers.
      start: () => Promise.reject(new Error('never')),
    });
    const open = (n: number) =>
      app.request(`${own}/open?pr=https://github.com/hartz89/docent/pull/${n}`);

    const hung = await Promise.all(Array.from({ length: MAX_LOOKUPS }, (_, i) => open(i + 1)));
    expect(hung.map((r) => r.status)).toEqual(Array(MAX_LOOKUPS).fill(502));
    expect(await hung[0]?.text()).toContain('answer within 0.02 seconds');

    // The slots are free again: the next link is looked up, not refused as busy.
    expect((await open(MAX_LOOKUPS + 1)).status).toBe(502);
  });

  test('names a GitHub app author as a bot', async () => {
    const { openPage } = setup({ author: 'app/docent-builder' });

    expect(await (await openPage()).text()).toContain('docent-builder (bot)');
  });

  test('escapes the PR title, which the PR author controls', async () => {
    const { openPage } = setup({ title: '<img src=x onerror=alert(1)> & "quotes"' });

    const html = await (await openPage()).text();

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
  });

  test('answers a link that is not a pull request with a plain refusal', async () => {
    const { openPage, previewed } = setup();

    const res = await openPage('https://evil.example/hartz89/docent/pull/7');

    expect(res.status).toBe(400);
    expect(previewed).toEqual([]);
  });
});

describe('only allowed repositories open', () => {
  test('refuses a PR in any other repo, without asking GitHub about it', async () => {
    const { openPage, previewed } = setup();

    const res = await openPage('https://github.com/someone/else/pull/1');
    const html = await res.text();

    expect(res.status).toBe(403);
    expect(html).toContain("Docent doesn't open links for someone/else");
    expect(html).toContain('/home/me/.config/docent/config.json');
    expect(previewed).toEqual([]);
  });

  test('matches repo names the way GitHub does, ignoring case', async () => {
    const { openPage } = setup();

    expect((await openPage('https://github.com/HARTZ89/docent/pull/7')).status).toBe(200);
  });

  test('a confirm for another repo is refused even with a valid-looking token', async () => {
    const { confirm, csrf, started } = setup();
    const token = await csrf();

    const res = await confirm({ pr: 'https://github.com/someone/else/pull/7', csrf: token });

    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });
});

describe('confirming starts the review and hands the browser its token', () => {
  test('redirects to the review server with its token in the fragment', async () => {
    const { confirm, csrf, started } = setup();

    const res = await confirm({ pr: prUrl, csrf: await csrf() });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`http://127.0.0.1:5001/#token=${reviewToken}`);
    expect(started.map((pr) => pr.url)).toEqual([prUrl]);
  });

  test('reuses the running review for the same commit; after a push, starts afresh and closes the old one', async () => {
    const { confirm, csrf, started, closed, setHead, tick } = setup();
    const token = await csrf();

    await confirm({ pr: prUrl, csrf: token });
    await confirm({ pr: prUrl, csrf: token });
    expect(started).toHaveLength(1);

    setHead(prUrl, 'b'.repeat(40));
    tick(60_000); // Past the time a PR's preview is remembered.
    const res = await confirm({ pr: prUrl, csrf: await csrf() });

    expect(res.headers.get('location')).toBe(`http://127.0.0.1:5002/#token=${reviewToken}`);
    expect(started.map((pr) => pr.head)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(closed).toEqual(['http://127.0.0.1:5001']);
  });

  test('a page shown before a push starts nothing, and shows the new commit and its cost', async () => {
    const { confirm, csrf, started, setHead, tick } = setup();
    const stale = await csrf();

    setHead(prUrl, 'b'.repeat(40));
    tick(60_000);
    const res = await confirm({ pr: prUrl, head: 'a'.repeat(40), csrf: stale });
    const html = await res.text();

    expect(res.status).toBe(409);
    expect(html).toContain('The pull request changed since that page opened.');
    expect(html).toContain('bbbbbbb');
    expect(started).toEqual([]);
  });

  test('reopening a review whose tour failed starts it again', async () => {
    const { confirm, csrf, started, failed, closed } = setup();
    const token = await csrf();
    await confirm({ pr: prUrl, csrf: token });

    failed.add('http://127.0.0.1:5001');
    const res = await confirm({ pr: prUrl, csrf: token });

    expect(res.headers.get('location')).toBe(`http://127.0.0.1:5002/#token=${reviewToken}`);
    expect(started).toHaveLength(2);
    expect(closed).toEqual(['http://127.0.0.1:5001']);
  });

  test('keeps a bounded number of reviews open, closing the least recently opened', async () => {
    const { confirm, csrf, closed, tick } = setup();
    const urls = Array.from(
      { length: MAX_OPEN_REVIEWS + 1 },
      (_, i) => `https://github.com/hartz89/docent/pull/${i + 1}`,
    );
    for (const url of urls.slice(0, MAX_OPEN_REVIEWS)) {
      tick(START_WINDOW_MS); // Clear of the rate limit.
      await confirm({ pr: url, csrf: await csrf(url) });
    }
    // Reopen the first, so the second becomes the least recently opened.
    tick(1);
    await confirm({ pr: urls[0] ?? '', csrf: await csrf(urls[0]) });
    expect(closed).toEqual([]);

    tick(START_WINDOW_MS);
    const last = urls.at(-1) ?? '';
    await confirm({ pr: last, csrf: await csrf(last) });

    expect(closed).toEqual(['http://127.0.0.1:5002']);
  });

  test('starts at most a few new reviews in a short window, so a runaway page cannot spend money', async () => {
    const { confirm, csrf, started, tick } = setup();
    const urls = Array.from(
      { length: MAX_STARTS + 1 },
      (_, i) => `https://github.com/hartz89/docent/pull/${i + 1}`,
    );

    const statuses: number[] = [];
    for (const url of urls)
      statuses.push((await confirm({ pr: url, csrf: await csrf(url) })).status);

    expect(statuses).toEqual([...Array(MAX_STARTS).fill(303), 429]);
    expect(started).toHaveLength(MAX_STARTS);

    tick(5 * 60_000);
    const last = urls.at(-1) ?? '';
    expect((await confirm({ pr: last, csrf: await csrf(last) })).status).toBe(303);
  });
});

describe('a hostile page cannot start a review', () => {
  test('refuses a POST from another site, even carrying a real token', async () => {
    const { confirm, csrf, started } = setup();
    const token = await csrf();

    const res = await confirm({ pr: prUrl, csrf: token }, { Origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });

  test('refuses a POST with no Origin, or from a sandboxed frame (Origin: null)', async () => {
    const { confirm, csrf, started } = setup();
    const token = await csrf();

    expect((await confirm({ pr: prUrl, csrf: token }, {})).status).toBe(403);
    expect((await confirm({ pr: prUrl, csrf: token }, { Origin: 'null' })).status).toBe(403);
    expect(started).toEqual([]);
  });

  test('refuses a POST whose Fetch Metadata says it came from another site', async () => {
    const { confirm, csrf, started } = setup();
    const token = await csrf();

    const res = await confirm(
      { pr: prUrl, csrf: token },
      { Origin: own, 'Sec-Fetch-Site': 'cross-site' },
    );

    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });

  test('refuses a POST from another local server on a different port', async () => {
    const { confirm, csrf, started } = setup();

    const res = await confirm(
      { pr: prUrl, csrf: await csrf() },
      { Origin: 'http://127.0.0.1:5173' },
    );

    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });

  test.each([
    ['missing', {}],
    ['empty', { csrf: '' }],
    ['wrong', { csrf: 'x'.repeat(43) }],
  ])('refuses a same-origin POST with a %s CSRF token', async (_, form) => {
    const { confirm, started } = setup();

    const res = await confirm({ pr: prUrl, ...form });

    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });

  test("refuses one PR's CSRF token for another PR", async () => {
    const { confirm, csrf, started } = setup();
    const other = 'https://github.com/hartz89/docent/pull/8';

    const res = await confirm({ pr: other, csrf: await csrf(prUrl) });

    expect(res.status).toBe(403);
    expect(started).toEqual([]);
  });

  test("refuses another launcher's CSRF token", async () => {
    const first = setup();
    const second = setup();

    const res = await second.confirm({ pr: prUrl, csrf: await first.csrf() });

    expect(res.status).toBe(403);
    // The page says what happened, and links back to a fresh confirm page.
    expect(await res.text()).toContain(`href="/open?pr=${encodeURIComponent(prUrl)}"`);
    expect(second.started).toEqual([]);
  });
});

describe('DNS rebinding: only requests that name our own host are served', () => {
  test('refuses a request for another host name that points at 127.0.0.1', async () => {
    const { app, previewed } = setup();

    const res = await app.request(`http://evil.example:${port}/open?pr=${prUrl}`);

    expect(res.status).toBe(403);
    expect(previewed).toEqual([]);
  });

  test('refuses a request whose Host header names another site', async () => {
    const { app } = setup();

    const res = await app.request(`${own}/`, { headers: { Host: `evil.example:${port}` } });

    expect(res.status).toBe(403);
  });

  test('refuses our host name on the wrong port', async () => {
    const { app } = setup();

    expect((await app.request('http://127.0.0.1:80/')).status).toBe(403);
  });

  test('accepts localhost as well as 127.0.0.1', async () => {
    const { app } = setup();

    expect((await app.request(`http://localhost:${port}/`)).status).toBe(200);
    expect((await app.request(`${own}/`)).status).toBe(200);
  });
});

describe('every response is locked down', () => {
  test('framing is forbidden and no Referer reaches another origin, on every response', async () => {
    const { app, openPage, confirm, csrf } = setup();
    const confirmPage = await openPage();
    const responses = [
      confirmPage,
      await openPage('https://github.com/someone/else/pull/1'),
      await app.request(`http://evil.example:${port}/`),
      await confirm({ pr: prUrl }, { Origin: 'https://evil.example' }),
      await confirm({ pr: prUrl, csrf: await csrf() }),
      await app.request(`${own}/nowhere`),
    ];

    for (const res of responses) {
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      // The confirm page sends a Referer only to itself, so its POST carries a real Origin
      // (browsers send `Origin: null` under no-referrer). Everything else, the redirect to the
      // review included, sends none at all.
      expect(res.headers.get('referrer-policy')).toBe(
        res === confirmPage ? 'same-origin' : 'no-referrer',
      );
    }
  });

  test('the review token appears only in the redirect after a same-origin confirm', async () => {
    const { app, openPage, confirm, csrf } = setup();
    const token = await csrf();
    // Start a review first, so a leak would have something to leak.
    expect((await confirm({ pr: prUrl, csrf: token })).status).toBe(303);

    const crossOrigin = [
      await openPage(),
      await openPage(prUrl, { Origin: 'https://evil.example' }),
      await app.request(`${own}/`),
      await confirm({ pr: prUrl, csrf: token }, { Origin: 'https://evil.example' }),
      await confirm({ pr: prUrl, csrf: token }, { Origin: own, 'Sec-Fetch-Site': 'cross-site' }),
      await confirm({ pr: prUrl, csrf: 'nope' }),
    ];

    for (const res of crossOrigin) {
      expect(await res.text()).not.toContain(reviewToken);
      expect([...res.headers].join('\n')).not.toContain(reviewToken);
    }
  });
});
