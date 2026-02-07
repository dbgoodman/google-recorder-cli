#!/usr/bin/env node
/**
 * Google Recorder CLI
 *
 * Download transcripts and audio from Google Recorder via the web API.
 */

import { Command } from 'commander';
import { RecorderAPI } from './api.js';
import { runAuthCommand, getAuthFilePath, loadAuth } from './auth.js';
import { browserAuth, refreshCookies } from './browser-auth.js';
import { extractChromeCookies } from './chrome-cookies.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const program = new Command();

program
  .name('google-recorder')
  .description('CLI tool for downloading transcripts and audio from Google Recorder')
  .version('1.0.0');

// ============================================================================
// auth
// ============================================================================

program
  .command('auth')
  .description('Set up or test authentication with Google Recorder')
  .option('--check', 'Test existing authentication')
  .option('--chrome', 'Extract cookies from Chrome automatically (recommended)')
  .option('--browser', 'Authenticate via Playwright browser (persistent login)')
  .option('--refresh', 'Headless cookie refresh via Playwright (no browser window)')
  .option('--api-key <key>', 'Set the API key (from X-Goog-Api-Key header in DevTools)')
  .option('--authuser <n>', 'Google account index for multi-account users (default: 0)')
  .action(async (options) => {
    const authUser = options.authuser !== undefined ? parseInt(options.authuser) : (loadAuth()?.authUser ?? 0);

    if (options.apiKey) {
      // Just update the API key in existing auth
      const { saveApiKey } = await import('./auth.js');
      saveApiKey(options.apiKey);
      console.log('API key saved.');
      return;
    }

    if (options.chrome) {
      await extractChromeCookies(authUser);
    } else if (options.browser) {
      await browserAuth(authUser);
    } else if (options.refresh) {
      console.log('Refreshing cookies headlessly...');
      const ok = await refreshCookies(authUser);
      if (ok) {
        console.log('Cookies refreshed successfully.');
      } else {
        console.log('Headless refresh failed. Run `google-recorder auth --browser` to log in.');
        process.exit(1);
      }
    } else {
      await runAuthCommand(options);
    }
  });

// ============================================================================
// list
// ============================================================================

program
  .command('list')
  .description('List recent recordings')
  .option('-n, --limit <n>', 'Maximum number of recordings', '20')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const api = new RecorderAPI();
    const limit = parseInt(options.limit);
    const recordings = await api.listRecordings(limit);

    if (options.json) {
      console.log(JSON.stringify(recordings, null, 2));
      return;
    }

    if (recordings.length === 0) {
      console.log('No recordings found.');
      return;
    }

    console.log(`Found ${recordings.length} recording(s):\n`);
    for (const r of recordings) {
      const date = new Date(r.date).toLocaleString();
      const loc = r.location ? ` | ${r.location}` : '';
      console.log(`  ${r.id}`);
      console.log(`    ${r.title}`);
      console.log(`    ${date} | ${r.duration}${loc}`);
      console.log();
    }
  });

// ============================================================================
// info
// ============================================================================

program
  .command('info <id>')
  .description('Show detailed information about a recording')
  .option('--json', 'Output as JSON')
  .action(async (id, options) => {
    const api = new RecorderAPI();
    const recordings = await api.listRecordings(100);
    const recording = recordings.find((r) => r.id === id || r.deviceId === id);

    if (!recording) {
      console.error(`Recording not found: ${id}`);
      console.error('Use `google-recorder list` to see available recordings.');
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(recording, null, 2));
      return;
    }

    console.log('Recording Details');
    console.log('=================');
    console.log(`ID:       ${recording.id}`);
    if (recording.deviceId && recording.deviceId !== recording.id) {
      console.log(`Device:   ${recording.deviceId}`);
    }
    console.log(`Title:    ${recording.title}`);
    console.log(`Date:     ${new Date(recording.date).toLocaleString()}`);
    console.log(`Duration: ${recording.duration}`);
    if (recording.location) {
      console.log(`Location: ${recording.location}`);
    }
    console.log(`Has transcript: ${recording.hasTranscript}`);
  });

// ============================================================================
// transcript
// ============================================================================

program
  .command('transcript <id>')
  .description('Download transcript for a single recording')
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('--json', 'Output as JSON (with speaker segments)')
  .option('--plain', 'Output plain text without speaker labels')
  .action(async (id, options) => {
    const api = new RecorderAPI();
    const transcript = await api.getTranscript(id);

    if (!transcript) {
      console.error(`No transcript found for recording: ${id}`);
      process.exit(1);
    }

    let output: string;

    if (options.json) {
      output = JSON.stringify(transcript, null, 2);
    } else if (options.plain) {
      output = transcript.segments.map((s) => s.text).join('\n\n');
    } else {
      output = transcript.rawText;
    }

    if (options.output) {
      writeFileSync(options.output, output);
      console.error(`Transcript saved to ${options.output}`);
    } else {
      console.log(output);
    }
  });

// ============================================================================
// search
// ============================================================================

program
  .command('search <query>')
  .description('Search recordings by title')
  .option('-n, --limit <n>', 'Maximum results', '20')
  .option('--json', 'Output as JSON')
  .action(async (query, options) => {
    const api = new RecorderAPI();
    const limit = parseInt(options.limit);
    const recordings = await api.searchRecordings(query, limit);

    if (options.json) {
      console.log(JSON.stringify(recordings, null, 2));
      return;
    }

    if (recordings.length === 0) {
      console.log(`No recordings matching "${query}".`);
      return;
    }

    console.log(`Found ${recordings.length} recording(s) matching "${query}":\n`);
    for (const r of recordings) {
      const date = new Date(r.date).toLocaleString();
      console.log(`  ${r.id}`);
      console.log(`    ${r.title}`);
      console.log(`    ${date} | ${r.duration}`);
      console.log();
    }
  });

// ============================================================================
// download
// ============================================================================

program
  .command('download')
  .description('Bulk download transcripts for multiple recordings')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-n, --limit <n>', 'Maximum recordings to process', '50')
  .option('--since <date>', 'Only recordings after this date (ISO 8601 or YYYY-MM-DD)')
  .option('--format <fmt>', 'Output format: txt or json', 'txt')
  .option('--json', 'Alias for --format json')
  .option('--skip-existing', 'Skip recordings that already have a transcript file', false)
  .action(async (options) => {
    const api = new RecorderAPI();
    const limit = parseInt(options.limit);
    const outDir = resolve(options.output);
    const format = options.json ? 'json' : options.format;

    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    console.log(`Fetching recording list (limit: ${limit})...`);
    let recordings = await api.listRecordings(limit);

    if (options.since) {
      const sinceDate = new Date(options.since);
      if (isNaN(sinceDate.getTime())) {
        console.error(`Invalid date: ${options.since}`);
        process.exit(1);
      }
      recordings = recordings.filter((r) => new Date(r.date) >= sinceDate);
    }

    console.log(`Found ${recordings.length} recording(s) to download.\n`);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const recording of recordings) {
      const safeTitle = recording.title.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 80);
      const dateStr = new Date(recording.date).toISOString().split('T')[0];
      const ext = format === 'json' ? 'json' : 'txt';
      const filename = `${dateStr} ${safeTitle}.${ext}`;
      const filepath = join(outDir, filename);

      if (options.skipExisting && existsSync(filepath)) {
        skipped++;
        continue;
      }

      process.stdout.write(`  Downloading: ${recording.title.substring(0, 60)}...`);

      try {
        const transcript = await api.getTranscript(recording.id);
        if (!transcript) {
          console.log(' no transcript');
          skipped++;
          continue;
        }

        let content: string;
        if (format === 'json') {
          content = JSON.stringify({
            recording: {
              id: recording.id,
              title: recording.title,
              date: recording.date,
              duration: recording.duration,
            },
            transcript,
          }, null, 2);
        } else {
          content = `Recording: ${recording.title}\n`;
          content += `Date: ${new Date(recording.date).toLocaleString()}\n`;
          content += `Duration: ${recording.duration}\n`;
          content += `ID: ${recording.id}\n\n`;
          content += '=== Transcript ===\n\n';
          content += transcript.rawText;
        }

        writeFileSync(filepath, content);
        console.log(' done');
        downloaded++;
      } catch (error) {
        console.log(` FAILED: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Downloaded: ${downloaded}`);
    console.log(`Skipped:    ${skipped}`);
    console.log(`Failed:     ${failed}`);
    console.log(`Output dir: ${outDir}`);
  });

// ============================================================================
// audio
// ============================================================================

program
  .command('audio <id>')
  .description('Download audio for a recording')
  .option('-o, --output <file>', 'Output file path (default: server-provided filename or <id>.m4a)')
  .action(async (id, options) => {
    const api = new RecorderAPI();

    const result = await api.getAudio(id);
    const outputPath = options.output || result.filename;
    writeFileSync(outputPath, result.data);

    const sizeMB = (result.data.length / (1024 * 1024)).toFixed(1);
    console.log(`Audio saved to ${outputPath} (${sizeMB} MB, ${result.contentType})`);
  });

// ============================================================================
// download-audio
// ============================================================================

program
  .command('download-audio')
  .description('Bulk download audio files for multiple recordings')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-n, --limit <n>', 'Maximum recordings to process', '50')
  .option('--since <date>', 'Only recordings after this date (ISO 8601 or YYYY-MM-DD)')
  .option('--skip-existing', 'Skip recordings that already have an audio file', false)
  .action(async (options) => {
    const api = new RecorderAPI();
    const limit = parseInt(options.limit);
    const outDir = resolve(options.output);

    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    console.log(`Fetching recording list (limit: ${limit})...`);
    let recordings = await api.listRecordings(limit);

    if (options.since) {
      const sinceDate = new Date(options.since);
      if (isNaN(sinceDate.getTime())) {
        console.error(`Invalid date: ${options.since}`);
        process.exit(1);
      }
      recordings = recordings.filter((r) => new Date(r.date) >= sinceDate);
    }

    console.log(`Found ${recordings.length} recording(s) to download.\n`);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const recording of recordings) {
      const safeTitle = recording.title.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 80);
      const dateStr = new Date(recording.date).toISOString().split('T')[0];
      const filename = `${dateStr} ${safeTitle}.m4a`;
      const filepath = join(outDir, filename);

      if (options.skipExisting && existsSync(filepath)) {
        skipped++;
        continue;
      }

      process.stdout.write(`  Downloading: ${recording.title.substring(0, 60)}...`);

      try {
        const result = await api.getAudio(recording.id);
        writeFileSync(filepath, result.data);
        const sizeMB = (result.data.length / (1024 * 1024)).toFixed(1);
        console.log(` done (${sizeMB} MB)`);
        downloaded++;
      } catch (error) {
        console.log(` FAILED: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Downloaded: ${downloaded}`);
    console.log(`Skipped:    ${skipped}`);
    console.log(`Failed:     ${failed}`);
    console.log(`Output dir: ${outDir}`);
  });

// ============================================================================
// config
// ============================================================================

program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    const authFile = getAuthFilePath();
    console.log('Configuration');
    console.log('=============');
    console.log(`Auth file: ${authFile}`);
    console.log(`Auth file exists: ${existsSync(authFile)}`);

    if (existsSync(authFile)) {
      try {
        const { readFileSync } = await import('node:fs');
        const data = JSON.parse(readFileSync(authFile, 'utf-8'));
        console.log(`Auth user: ${data.authUser ?? 0}`);
        console.log(`Saved at: ${data.savedAt}`);
        console.log(`Has cookies: ${!!data.cookies}`);
        console.log(`Has SAPISID: ${!!data.sapisid}`);
      } catch {
        console.log('(Could not read auth file)');
      }
    }
  });

program.parse();
