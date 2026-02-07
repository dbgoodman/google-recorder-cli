/**
 * Google Recorder CLI - Authentication
 *
 * Manages cookie-based authentication for the Google Recorder API.
 * Cookies are extracted from Chrome DevTools and stored locally.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as readline from 'node:readline';
import type { AuthData } from './types.js';

const CONFIG_DIR = join(homedir(), '.config', 'google-recorder');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');

// ============================================================================
// Auth File Operations
// ============================================================================

export function getAuthFilePath(): string {
  return AUTH_FILE;
}

export function loadAuth(): AuthData | null {
  if (!existsSync(AUTH_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(AUTH_FILE, 'utf-8');
    const data = JSON.parse(content);
    // Handle legacy format (authUser might not exist)
    if (data.authUser === undefined) {
      data.authUser = 0;
    }
    return data as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(cookies: string, authUser: number, apiKey?: string): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  const sapisidMatch = cookies.match(/SAPISID=([^;]+)/);
  if (!sapisidMatch) {
    throw new Error('SAPISID cookie not found in provided cookies');
  }

  // Preserve existing apiKey if not provided
  const existingAuth = loadAuth();
  const resolvedApiKey = apiKey || existingAuth?.apiKey || '';

  if (!resolvedApiKey) {
    console.log('\nNote: No API key set. You can extract it from Chrome DevTools:');
    console.log('  Look for the "X-Goog-Api-Key" header in requests to pixelrecorder-pa.clients6.google.com');
    console.log('  Then run: google-recorder auth --api-key <key>\n');
  }

  const data: AuthData = {
    sapisid: sapisidMatch[1],
    cookies,
    authUser,
    apiKey: resolvedApiKey,
    savedAt: new Date().toISOString(),
  };

  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function saveApiKey(apiKey: string): void {
  const auth = loadAuth();
  if (!auth) {
    console.error('No auth file found. Run `google-recorder auth --chrome` first.');
    process.exit(1);
  }
  auth.apiKey = apiKey;
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

// ============================================================================
// Auth Testing
// ============================================================================

export async function testAuth(): Promise<boolean> {
  const auth = loadAuth();
  if (!auth) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const hash = createHash('sha1')
    .update(`${timestamp} ${auth.sapisid} https://recorder.google.com`)
    .digest('hex');

  try {
    const response = await fetch(
      'https://pixelrecorder-pa.clients6.google.com/$rpc/java.com.google.wireless.android.pixel.recorder.protos.PlaybackService/GetRecordingList',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json+protobuf',
          'X-Goog-Api-Key': auth.apiKey,
          'Authorization': `SAPISIDHASH ${timestamp}_${hash}`,
          'X-Goog-AuthUser': String(auth.authUser),
          'Origin': 'https://recorder.google.com',
          'Cookie': auth.cookies,
        },
        body: JSON.stringify([[{ '1': timestamp }], 1]),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Interactive Auth Command
// ============================================================================

export async function runAuthCommand(options: { check?: boolean; authuser?: string }): Promise<void> {
  console.log('Google Recorder Authentication');
  console.log('==============================\n');

  if (options.check) {
    const auth = loadAuth();
    if (!auth) {
      console.log('No authentication found.');
      console.log(`Auth file: ${AUTH_FILE}`);
      console.log('\nRun `google-recorder auth` to authenticate.');
      process.exit(1);
    }

    console.log(`Auth file: ${AUTH_FILE}`);
    console.log(`Auth user: ${auth.authUser}`);
    console.log(`Saved at: ${auth.savedAt}`);
    console.log('\nTesting authentication...');

    const valid = await testAuth();
    if (valid) {
      console.log('Authentication is valid.');
    } else {
      console.log('Authentication is invalid or expired.');
      console.log('Run `google-recorder auth` to re-authenticate.');
      process.exit(1);
    }
    return;
  }

  // Determine authUser
  const authUser = options.authuser !== undefined ? parseInt(options.authuser) : 0;
  if (isNaN(authUser) || authUser < 0) {
    console.error('Error: --authuser must be a non-negative integer');
    process.exit(1);
  }

  console.log('To authenticate, copy your cookies from Chrome DevTools:\n');
  console.log('1. Open https://recorder.google.com in Chrome');
  console.log('2. Open DevTools (Cmd+Option+I on Mac, F12 on Windows)');
  console.log('3. Go to the Network tab and refresh the page');
  console.log('4. Click any request to pixelrecorder-pa.clients6.google.com');
  console.log('5. In the Headers tab, find "Cookie" under Request Headers');
  console.log('6. Right-click the cookie value and select "Copy value"');
  console.log('7. Paste below and press Enter\n');

  if (authUser !== 0) {
    console.log(`Using auth user index: ${authUser}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Cookies: ', async (cookies) => {
    rl.close();

    if (!cookies.trim()) {
      console.log('No cookies provided. Exiting.');
      process.exit(1);
    }

    try {
      saveAuth(cookies.trim(), authUser);
      console.log(`\nCookies saved to ${AUTH_FILE}`);
      console.log(`Auth user index: ${authUser}`);

      console.log('\nTesting authentication...');
      const valid = await testAuth();
      if (valid) {
        console.log('Authentication successful!');
      } else {
        console.log('Authentication test failed. Cookies may be invalid.');
        console.log('\nTroubleshooting:');
        console.log('- Make sure you copied the full Cookie header value');
        console.log('- Check that you are logged in at recorder.google.com');
        console.log('- If you have multiple Google accounts, use --authuser N');
        console.log('  to set the correct account index (0, 1, 2, etc.)');
        process.exit(1);
      }
    } catch (error) {
      console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });
}
