# google-recorder-cli

CLI to download transcripts and audio from Google Recorder (recorder.google.com) via its
private gRPC-web API. TypeScript / Node ESM. Globally linked as `google-recorder`.

## Build & install
- `npm run build` → compiles `src/` to `dist/` via `tsc`. **`dist/` is gitignored** (source-only
  repo); build locally after cloning.
- Global command: `npm link` from this directory (`google-recorder` bin → `dist/cli.js`).
  **Always link from `~/google-recorder-cli`.** A stale link previously pointed at a deleted
  `/tmp/google-recorder-cli` copy and silently broke the command.
- If `node_modules/.bin/tsc` errors with `Cannot find module '../lib/tsc.js'`, the bin was
  copied instead of symlinked — fix: `ln -sf ../typescript/bin/tsc node_modules/.bin/tsc`.

## Auth architecture (the important part)
Auth is **cookie-based** (SAPISIDHASH computed over the user's Google cookies). Cookies are
cached at `~/.config/google-recorder/auth.json` (**outside the repo — never commit it**).

Cookies come from a **dedicated, persistent Playwright Chrome profile** at
`~/.config/google-recorder/browser-profile` — NOT the macOS Keychain and NOT the user's
everyday Chrome. Flow:

1. **One-time login:** `google-recorder auth` opens a Chrome window; user signs in. This account
   is **UH Mānoa SSO** (IdP redirect + Duo), so the sign-in can take a while. `browser-auth.ts`
   polls for the `SAPISID` cookie on the Recorder app, then saves.
2. **Silent refresh on 401:** `api.ts` → `tryAutoRefresh` → `refreshCookies` launches that profile
   **headless** and re-grabs cookies. It also completes a **silent SSO re-auth** (the IdP
   auto-asserts while the profile's Duo device-trust holds, ~30 days) by polling ~40s for the
   signed-in state.
3. **One-tap interactive fallback:** if silent refresh fails **and** running in a TTY,
   `tryInteractiveRelogin` auto-opens the login window (usually just a Duo tap — account
   remembered, no password). In **non-TTY/background** runs it does NOT fire — the command exits
   with a "run `google-recorder auth`" message; surface that to the user, don't retry blindly.

### Why the Keychain path was removed
The old `auth --chrome` decrypted Chrome's cookie DB with the Keychain "Chrome Safe Storage"
key. On Chrome 127+ cookies use app-bound (`v20`) encryption it can't decrypt, and every read
prompted for the macOS password (the original bug: ~4 prompts per session). Removed entirely;
`--chrome` is now a deprecated alias for the browser login. `chrome-cookies.ts` and the
`better-sqlite3` dependency are gone.

### Env vars
- `GOOGLE_RECORDER_LOGIN_TIMEOUT_MS` — interactive login wait (default `600000`; `0` = unlimited;
  use for slow SSO/Duo).
- `GOOGLE_RECORDER_NO_AUTO_LOGIN=1` — disable the auto one-tap re-login window.
- `CLI_SHARED_CHROME_USER_DATA_DIR` / `CLI_SHARED_CHROME_PROFILE` — point auth at a shared Chrome
  profile dir (optional; also enables the `chatgpt-bridge` daemon CDP refresh path).

## Key files
- `src/cli.ts` — commander CLI: `auth`, `list`, `search`, `transcript`, `audio`, `download`,
  `download-audio`, `info`, `config`.
- `src/api.ts` — `RecorderAPI`: SAPISIDHASH signing, gRPC-web calls, 401 → refresh → retry.
- `src/auth.ts` — `auth.json` load/save, `testAuth`, manual cookie-paste flow (`auth --manual`).
- `src/browser-auth.ts` — Playwright persistent-profile login + headless/silent refresh.
- `src/types.ts` — gRPC-web response shapes (loosely typed; the API returns positional arrays).

## Verifying
`google-recorder auth --check` (tests the saved session, no browser) then
`google-recorder list --limit 3`. **No prompts of any kind should appear.**

## Gotchas
- `auth.json` holds live cookies — sensitive; lives outside the repo; never commit.
- Re-login is needed only when the dedicated profile's Duo device-trust lapses (~monthly),
  **not** on cookie expiry (those refresh silently).
- A phone notification for re-login events (Telegram / Pushover / WhatsApp-via-Baileys) was
  researched and intentionally **deferred** — silent refresh covers ~30-day stretches, so it
  wasn't worth the always-on infra. Revisit only if re-auth proves frequent in practice.
