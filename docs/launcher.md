# The launcher: opening a tour from a link

`docent serve` runs a small server on a fixed localhost port. A link to it opens a PR's tour from any page, such as a brief, with no terminal:

```
http://127.0.0.1:4917/open?pr=https://github.com/hartz89/docent/pull/52
```

The link shows a confirm page. It names the PR and says what opening it costs: **"Cached, no cost"** when a tour for the PR's current head is already written, or **"About $1 to write"** when it isn't. Nothing starts until you click **Start the review**. The launcher then starts a review server for that PR (or reuses the one already running at that commit) and sends your browser to it.

Code: [`apps/server/src/launcher.ts`](../apps/server/src/launcher.ts) (the HTTP app and its defenses) and [`apps/server/src/serve-cli.ts`](../apps/server/src/serve-cli.ts) (config, port, start and stop).

## Using it

```bash
pnpm docent serve              # run it in this terminal
pnpm docent serve --stop       # stop the one on the configured port
pnpm docent serve --help
```

**Keep links cheap with `--prepare`.** `pnpm docent review <pr-url> --prepare` writes the tour to the cache. The confirm page then says "Cached, no cost", and the tour opens at once. A push changes the head, so prepare again after one.

**A brief links to each PR's tour** with the URL above, the PR's URL in `pr=`. The PR URL may be URL-encoded or not.

## Config

One JSON file: `$DOCENT_CONFIG` if set, otherwise `~/.config/docent/config.json` (or `$XDG_CONFIG_HOME/docent/config.json`).

```json
{ "allowedRepos": ["hartz89/docent"], "port": 4917 }
```

- **`allowedRepos`:** the only repositories a link may open, as `owner/name`. Matching ignores case, like GitHub. A PR in any other repo gets a refusal page that says how to add it. **With no config file, the default is the repository Docent itself was cloned from** (its `origin` remote), or nothing if that can't be read. Restart the launcher after changing it.
- **`port`:** defaults to 4917. `--port` overrides it.

## Starting it at login on macOS

Docent doesn't install this for you. Save the template below as `~/Library/LaunchAgents/dev.docent.launcher.plist`, and fill in the two paths: `which node` for the first, and your Docent checkout for the second. Build first (`pnpm build`), since it runs the built `dist/cli.js`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.docent.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/node</string>
    <string>/ABSOLUTE/PATH/TO/docent/apps/server/dist/cli.js</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart after a crash, but not after a clean stop (docent serve --stop). -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- gh and git must be on PATH. Add Homebrew's folder if that's where yours are. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/docent-launcher.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/docent-launcher.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.docent.launcher.plist   # start now and at every login
launchctl bootout gui/$(id -u)/dev.docent.launcher                                  # stop, and don't start at login
```

`docent serve --stop` also works. It sends SIGTERM to the PID the launcher wrote to `<cache>/launcher-<port>.pid`, after checking that PID still runs `cli.js serve`. The launcher exits cleanly, so launchd leaves it stopped until the next login.

## Can a claude.ai artifact open the link?

**Yes, in a new tab.** Tested on 2026-11-10 in Chrome. A private claude.ai artifact held two links to a running launcher, one with `target="_blank"` and one without. Both opened `http://127.0.0.1:<port>/open?...` in a new tab, and the confirm page loaded there. Clicking **Start the review** landed on the tour. The artifact runs in a sandboxed frame, so even a plain link leaves it for a new tab, which is what the launcher needs: its pages refuse to be framed.

Not tested: Safari and Firefox, and Chrome's Private Network Access rules, which may later ask before a public site navigates to localhost. Top-level navigations aren't covered by them today.

## Threat model

The launcher is the only Docent server that other websites are meant to link to. So assume a hostile page knows the port and can make your browser load any launcher URL, in a tab, a frame, an image or a form.

**What an attacker wants:** to start reviews (spending your money and running agents), to steal a review's per-launch token (and so drive that review's API, which can post a GitHub review as you), or to learn about your PRs.

| Attack | Defense |
| --- | --- |
| A link or hidden request starts a review | `GET /open` only renders the confirm page. Only a `POST` starts one. |
| A hostile page submits the `POST` | The `POST` must carry `Origin` equal to the launcher's own origin, and `Sec-Fetch-Site: same-origin` when the browser sends it. It must also carry a CSRF token: an HMAC of the PR URL under a secret made fresh each launch. The token is only in the confirm page, which other origins can't read: there's no CORS, framing is refused, and COOP cuts the opener's handle to the tab. |
| DNS rebinding (`evil.example` resolves to 127.0.0.1) | The launcher binds 127.0.0.1 only. Every request's `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`, checked both in the URL and in the raw header. |
| Clickjacking the confirm button | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Against a pop-up opened under the cursor ("double-clickjacking"), the button ignores clicks for its first 0.8 s on screen. |
| Stealing the review token | It appears only in the `303` redirect after a valid confirm, as a URL fragment, which browsers never send to servers or in a `Referer`. Every launcher response is `Referrer-Policy: no-referrer`, except the confirm page itself, which is `same-origin`: under `no-referrer`, browsers send `Origin: null` on the page's own POST, which would break the Origin check. The token is never logged. |
| Making the launcher hit GitHub in the background | `GET /open` refuses loads that aren't a page in a tab (`Sec-Fetch-Dest` other than `document`), and lookups are reused for 30 s. |
| Opening a PR from a repo you don't trust | Only `allowedRepos`. The check happens before anything asks GitHub about the PR. |
| Spending money by repeated confirms | At most 5 new reviews start in any 5 minutes. Reopening a running review is free. At most 10 run at once; the least recently opened closes first. |
| Running the PR's code | Nothing new. The review server reads the PR as before: a hardened checkout, never executed. |

**What it does not defend against:**
- **Anything running as you on this machine.** Local processes can call the launcher like a browser can. They can already read your `gh` login and the review servers' memory, so the launcher adds nothing for them.
- **You clicking confirm on a page you didn't mean to open.** The worst case is a review of a PR in a repo you allowed, at about $1, and within the rate limit.
- **A PR title that misleads.** The title is the PR author's text. It's escaped, so it can't inject markup, but it can still lie. The page also shows the repo, the number and the head commit.
