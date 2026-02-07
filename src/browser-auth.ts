/**
 * Browser-based authentication using Playwright.
 *
 * Uses a persistent Chrome profile so you only need to log in once.
 * Subsequent runs extract fresh cookies automatically without manual intervention.
 */

import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { saveAuth, testAuth } from './auth.js';

const CONFIG_DIR = join(homedir(), '.config', 'google-recorder');
const PROFILE_DIR = join(CONFIG_DIR, 'browser-profile');
const RECORDER_URL = 'https://recorder.google.com';

/**
 * Extract cookies from a Playwright browser context and save them.
 */
async function extractAndSaveCookies(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  authUser: number
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
    console.log('No cookies found. Login may not have completed.');
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
    console.log('SAPISID cookie not found. Login may not have completed.');
    return false;
  }

  saveAuth(cookieString, authUser);
  return true;
}

/**
 * Open Chrome with a persistent profile, log in if needed, and extract cookies.
 */
export async function browserAuth(authUser: number): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  console.log('Launching Chrome...\n');

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
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
      console.log('Not logged in. Please sign in to Google in the browser window.');
      console.log('Waiting up to 3 minutes...\n');

      // If we're on the /about page, the user needs to click "Go to Recorder"
      // which will redirect to Google sign-in
      if (currentUrl.includes('/about')) {
        console.log('Tip: Click the "Go to Recorder" button on the page to start sign-in.');
      }

      try {
        // Wait for the user to end up on the recordings page (not /about)
        await page.waitForFunction(
          () => {
            const url = window.location.href;
            return url.includes('recorder.google.com') &&
              !url.includes('/about') &&
              !url.includes('accounts.google.com');
          },
          { timeout: 180000 }
        );
      } catch {
        console.error('Login timed out. Please try again.');
        await context.close();
        process.exit(1);
      }

      console.log('Login detected. Waiting for page to load...');
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
  if (!existsSync(PROFILE_DIR)) {
    return false;
  }

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch {
    return false;
  }

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(RECORDER_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // If we landed on the login page, headless refresh won't work
    if (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
      return false;
    }

    const saved = await extractAndSaveCookies(context, authUser);
    return saved;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}
