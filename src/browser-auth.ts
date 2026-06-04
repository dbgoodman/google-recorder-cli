/**
 * Browser-based authentication using Playwright.
 *
 * Uses a persistent Chrome profile so you only need to log in once.
 * Subsequent runs extract fresh cookies automatically without manual intervention.
 */

import { chromium } from 'playwright-core';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { saveAuth, testAuth } from './auth.js';

const CONFIG_DIR = join(homedir(), '.config', 'google-recorder');
const RECORDER_URL = 'https://recorder.google.com';
// Generous window so SSO redirects + 2FA/Duo can be completed at the user's pace.
// Override with GOOGLE_RECORDER_LOGIN_TIMEOUT_MS (0 = wait indefinitely).
const LOGIN_TIMEOUT_MS = (() => {
  const v = process.env.GOOGLE_RECORDER_LOGIN_TIMEOUT_MS?.trim();
  if (v === undefined || v === '') return 600000; // 10 minutes
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 600000;
})();
const BRIDGE_HOME = process.env.CHATGPT_BRIDGE_HOME?.trim()
  ? resolve(process.env.CHATGPT_BRIDGE_HOME)
  : join(homedir(), '.chatgpt-bridge');
const BRIDGE_DAEMON_PATH = join(BRIDGE_HOME, 'daemon.json');

function getProfileDir(): string {
  const shared = process.env.CLI_SHARED_CHROME_USER_DATA_DIR?.trim();
  return shared ? resolve(shared) : join(CONFIG_DIR, 'browser-profile');
}

function getProfileName(): string {
  return process.env.CLI_SHARED_CHROME_PROFILE?.trim() || 'Default';
}

type CookieSource = {
  cookies(urls?: string[]): Promise<Array<{ name: string; value: string }>>;
};

function readBridgeDaemonState(): { port: number; profileDir: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(BRIDGE_DAEMON_PATH, 'utf8')) as Partial<{
      port: number;
      profileDir: string;
    }>;
    if (typeof parsed.port !== 'number' || typeof parsed.profileDir !== 'string') {
      return null;
    }
    return { port: parsed.port, profileDir: resolve(parsed.profileDir) };
  } catch {
    return null;
  }
}

/**
 * Extract cookies from a Playwright browser context and save them.
 */
async function extractAndSaveCookies(
  context: CookieSource,
  authUser: number,
  quiet = false
): Promise<boolean> {
  // Get cookies from all relevant Google domains
  const cookies = await context.cookies([
    'https://recorder.google.com',
    'https://pixelrecorder-pa.clients6.google.com',
    'https://usercontent.recorder.google.com',
    'https://google.com',
    'https://accounts.google.com',
  ]);

  if (cookies.length === 0) {
    if (!quiet) console.log('No cookies found. Login may not have completed.');
    return false;
  }

  // Build cookie string (deduplicate by name)
  const seen = new Set<string>();
  const cookieParts: string[] = [];
  for (const cookie of cookies) {
    if (!seen.has(cookie.name)) {
      seen.add(cookie.name);
      cookieParts.push(`${cookie.name}=${cookie.value}`);
    }
  }
  const cookieString = cookieParts.join('; ');

  // Check for SAPISID (required for gRPC API auth)
  const hasSapisid = cookies.some((c) => c.name === 'SAPISID');
  if (!hasSapisid) {
    if (!quiet) console.log('SAPISID cookie not found. Login may not have completed.');
    return false;
  }

  saveAuth(cookieString, authUser);
  return true;
}

async function refreshCookiesFromBridgeDaemon(authUser: number): Promise<boolean> {
  const bridge = readBridgeDaemonState();
  if (!bridge) return false;

  const profileDir = resolve(getProfileDir());
  if (bridge.profileDir !== profileDir) return false;

  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${bridge.port}`);
    const context = browser.contexts()[0];
    if (!context) return false;
    return await extractAndSaveCookies(context, authUser, true);
  } catch {
    return false;
  }
}

/**
 * Open Chrome with a persistent profile, log in if needed, and extract cookies.
 */
export async function browserAuth(authUser: number): Promise<void> {
  const profileDir = getProfileDir();
  const profileName = getProfileName();
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  console.log('Opening a Chrome window for a one-time Google login.');
  console.log('After this, the CLI refreshes itself silently — no password prompts.\n');

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${profileName}`,
      ],
      viewport: { width: 1280, height: 800 },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('channel') || msg.includes('chrome') || msg.includes('executable')) {
      console.error('Could not find Chrome. Make sure Google Chrome is installed.');
      console.error('On macOS: Install from https://www.google.com/chrome/');
      process.exit(1);
    }
    throw error;
  }

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(RECORDER_URL, { waitUntil: 'domcontentloaded' });

    // Wait for page to settle
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const currentUrl = page.url();

    // Check if we need to log in:
    // - Google login/accounts page
    // - recorder.google.com/about (landing page for non-logged-in users)
    // - No cookies at all
    const needsLogin =
      currentUrl.includes('accounts.google.com') ||
      currentUrl.includes('signin') ||
      currentUrl.includes('/about') ||
      (await context.cookies()).length === 0;

    if (needsLogin) {
      const minutes = LOGIN_TIMEOUT_MS === 0 ? 0 : Math.round(LOGIN_TIMEOUT_MS / 60000);
      console.log('Not logged in. Please sign in to Google in the browser window.');
      console.log(
        minutes === 0
          ? 'Take your time — waiting until you finish. Complete any SSO / 2FA steps.\n'
          : `Take your time (up to ${minutes} minutes) — complete any SSO / 2FA steps.\n`
      );

      // If we're on the /about page, the user needs to click "Go to Recorder"
      // which will redirect to Google sign-in
      if (currentUrl.includes('/about')) {
        console.log('Tip: Click the "Go to Recorder" button on the page to start sign-in.');
      }

      // Poll for the signed-in state by looking for the SAPISID cookie while on
      // the Recorder app. This is robust to the unpredictable SSO redirect chain
      // (IdP -> accounts.google.com -> recorder) and to the page navigating.
      const deadline = LOGIN_TIMEOUT_MS === 0 ? Infinity : Date.now() + LOGIN_TIMEOUT_MS;
      let loggedIn = false;
      while (Date.now() < deadline) {
        let hasSapisid = false;
        try {
          const cks = await context.cookies(['https://recorder.google.com', 'https://www.google.com']);
          hasSapisid = cks.some((c) => c.name === 'SAPISID' && !!c.value);
        } catch {
          // The window/context was closed before sign-in completed.
          console.error(
            '\nThe sign-in window closed before login finished.\n' +
            'Run `google-recorder auth` again and keep the window open until your recordings appear.'
          );
          process.exit(1);
        }

        let url = '';
        try { url = page.url(); } catch { /* between navigations */ }

        if (hasSapisid && url.includes('recorder.google.com') && !url.includes('/about')) {
          loggedIn = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!loggedIn) {
        console.error(
          '\nTimed out waiting for sign-in. No problem — just run `google-recorder auth` again.\n' +
          'For an unlimited window, set GOOGLE_RECORDER_LOGIN_TIMEOUT_MS=0.'
        );
        await context.close();
        process.exit(1);
      }

      console.log('Login detected. Finishing up...');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    } else {
      console.log('Already logged in to Google Recorder.');
    }

    // Small delay to ensure all cookies are set
    await page.waitForTimeout(2000);

    // Extract and save cookies
    console.log('Extracting cookies...');
    const saved = await extractAndSaveCookies(context, authUser);

    if (!saved) {
      console.error('\nFailed to extract cookies. Please try again.');
      await context.close();
      process.exit(1);
    }

    console.log('Cookies saved.\n');

    // Test the saved cookies
    console.log('Testing authentication...');
    const valid = await testAuth();
    if (valid) {
      console.log('Authentication successful!');
    } else {
      console.log('Warning: Authentication test failed.');
      console.log('The cookies were saved but may not be fully valid yet.');
      console.log('Try running `google-recorder auth --check` in a moment.');
    }
  } finally {
    await context.close();
  }
}

/**
 * Headless cookie refresh — no user interaction needed.
 * Uses the existing browser profile to grab fresh cookies.
 * Returns true if successful, false if login is needed.
 */
export async function refreshCookies(authUser: number): Promise<boolean> {
  const bridged = await refreshCookiesFromBridgeDaemon(authUser);
  if (bridged) {
    return true;
  }

  const profileDir = getProfileDir();
  const profileName = getProfileName();
  if (!existsSync(profileDir)) {
    return false;
  }

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${profileName}`,
      ],
    });
  } catch {
    return false;
  }

  try {
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(RECORDER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { /* navigation may be interrupted by SSO redirects */ }

    // Allow a *silent* SSO redirect chain to complete: when the Google session
    // has expired but this profile's UH IdP session + remembered Duo device are
    // still valid, navigating to Recorder re-establishes the Google session with
    // no human interaction. We poll for the signed-in state and grab cookies as
    // soon as it appears. Returns fast in the common case (just-expired cookies);
    // waits longer only while a silent re-auth is actually in progress.
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      let hasSapisid = false;
      try {
        const cks = await context.cookies(['https://recorder.google.com', 'https://www.google.com']);
        hasSapisid = cks.some((c) => c.name === 'SAPISID' && !!c.value);
      } catch {
        return false;
      }
      let url = '';
      try { url = page.url(); } catch { /* between navigations */ }
      if (hasSapisid && url.includes('recorder.google.com') && !url.includes('/about')) {
        return await extractAndSaveCookies(context, authUser, true);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Still not signed in after the silent attempt — a fresh interactive login is needed.
    return false;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}
