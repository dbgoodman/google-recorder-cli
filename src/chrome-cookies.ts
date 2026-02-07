/**
 * Chrome Cookie Extractor for macOS
 *
 * Reads and decrypts cookies from the local Chrome cookie database.
 * Uses the Chrome Safe Storage key from the macOS Keychain.
 *
 * This allows extracting fresh Google cookies without manual DevTools work.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import Database from 'better-sqlite3';
import { loadAuth, saveAuth, testAuth } from './auth.js';

const CHROME_COOKIES_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'Default',
  'Cookies'
);

const CONFIG_DIR = join(homedir(), '.config', 'google-recorder');

// Google domains whose cookies we need (host_key in Chrome DB uses leading dot for domain cookies)
const GOOGLE_DOMAINS = [
  '.google.com',
  'accounts.google.com',
];

/**
 * Get the Chrome Safe Storage encryption key from macOS Keychain.
 * This may prompt the user for Keychain access (password or Touch ID).
 */
function getChromeEncryptionKey(): string {
  // Use spawnSync with stdio inherit for stderr so macOS Keychain dialogs can appear
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', 'Chrome Safe Storage',
    '-w',
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'], // inherit stderr so dialogs work
    timeout: 60000,
  });

  if (result.status !== 0 || !result.stdout?.trim()) {
    if (result.error) {
      throw new Error(`Keychain access error: ${result.error.message}`);
    }
    throw new Error(
      'Could not read Chrome Safe Storage key from Keychain.\n' +
      'A macOS dialog should have appeared asking for permission.\n' +
      'If no dialog appeared, try running this command in Terminal:\n' +
      '  security find-generic-password -s "Chrome Safe Storage" -w'
    );
  }

  return result.stdout.trim();
}

/**
 * Derive the AES key from Chrome's Safe Storage password.
 * Chrome on macOS uses PBKDF2 with 1003 iterations.
 */
function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * Decrypt a Chrome cookie value.
 * Encrypted values start with 'v10' (3 bytes) followed by AES-128-CBC ciphertext.
 * IV is 16 bytes of 0x20 (spaces).
 */
function decryptCookieValue(encryptedValue: Buffer, key: Buffer): string {
  if (encryptedValue.length <= 3) {
    return '';
  }

  // Check for 'v10' prefix (Chrome macOS encryption version)
  const version = encryptedValue.subarray(0, 3).toString('utf-8');
  if (version !== 'v10') {
    // Unencrypted cookie
    return encryptedValue.toString('utf-8');
  }

  const ciphertext = encryptedValue.subarray(3);
  const iv = Buffer.alloc(16, 0x20); // 16 bytes of spaces

  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Newer Chrome versions prepend a 32-byte binding prefix to the cookie value.
    // Skip it to get the actual value.
    if (decrypted.length > 32) {
      const withPrefix = decrypted.subarray(32).toString('utf-8');
      // Verify this looks like a printable cookie value
      if (/^[\x20-\x7E]+$/.test(withPrefix)) {
        return withPrefix;
      }
    }
    // Fallback: try without skipping prefix (older Chrome)
    return decrypted.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Core cookie extraction logic. Returns true on success.
 */
function extractCookiesCore(authUser: number): boolean {
  if (!existsSync(CHROME_COOKIES_PATH)) {
    return false;
  }

  const password = getChromeEncryptionKey();
  const key = deriveKey(password);

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const tempDb = join(CONFIG_DIR, '.cookies-temp.db');
  copyFileSync(CHROME_COOKIES_PATH, tempDb);

  try {
    const db = new Database(tempDb, { readonly: true });

    const domainClauses = GOOGLE_DOMAINS.map((d) => `host_key = '${d}'`).join(' OR ');
    const query = `SELECT host_key, name, encrypted_value, path, is_secure, is_httponly, expires_utc FROM cookies WHERE ${domainClauses}`;

    const rows = db.prepare(query).all() as Array<{
      host_key: string;
      name: string;
      encrypted_value: Buffer;
      path: string;
      is_secure: number;
      is_httponly: number;
      expires_utc: number;
    }>;

    db.close();

    if (rows.length === 0) return false;

    const cookieParts: string[] = [];
    const seen = new Set<string>();
    let hasSapisid = false;

    for (const row of rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);

      const value = decryptCookieValue(row.encrypted_value, key);
      if (!value) continue;

      cookieParts.push(`${row.name}=${value}`);
      if (row.name === 'SAPISID') hasSapisid = true;
    }

    if (!hasSapisid) return false;

    const cookieString = cookieParts.join('; ');
    saveAuth(cookieString, authUser);
    return true;
  } finally {
    if (existsSync(tempDb)) {
      unlinkSync(tempDb);
    }
  }
}

/**
 * Extract Google cookies from Chrome — interactive version with console output.
 */
export async function extractChromeCookies(authUser: number): Promise<void> {
  console.log('Chrome Cookie Extraction');
  console.log('========================\n');

  if (!existsSync(CHROME_COOKIES_PATH)) {
    console.error('Chrome cookie database not found at:');
    console.error(`  ${CHROME_COOKIES_PATH}`);
    console.error('\nMake sure Google Chrome is installed and you have visited recorder.google.com.');
    process.exit(1);
  }

  console.log('Reading Chrome encryption key from Keychain...');
  console.log('(You may see a macOS dialog asking for Keychain access — please approve it)\n');

  const ok = extractCookiesCore(authUser);
  if (!ok) {
    console.error('Failed to extract cookies. Make sure you are logged in to Google in Chrome.');
    process.exit(1);
  }

  console.log('Cookies saved.\n');

  console.log('Testing authentication...');
  const valid = await testAuth();
  if (valid) {
    console.log('Authentication successful!');
  } else {
    console.log('Warning: Authentication test failed.');
    console.log('Make sure you have visited recorder.google.com recently in Chrome.');
  }
}

/**
 * Silent cookie extraction — used by auto-refresh on API 401.
 * Returns true on success, false on any failure (never throws).
 */
export async function extractChromeCookiesSilent(authUser: number): Promise<boolean> {
  try {
    return extractCookiesCore(authUser);
  } catch {
    return false;
  }
}
