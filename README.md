# google-recorder-cli

CLI tool for downloading transcripts and audio from [Google Recorder](https://recorder.google.com) via its web API.

Google Recorder is a voice recording app on Pixel phones that automatically transcribes recordings and syncs them to the cloud. This tool lets you download transcripts and audio files programmatically from the command line.

## Features

- List and search recordings
- Download individual or bulk transcripts
- Download audio files (m4a)
- Output in plain text or JSON format
- Speaker-labeled transcript segments with timestamps
- Configurable multi-account support

## Requirements

- Node.js 20 or later
- A Google account with recordings synced to [recorder.google.com](https://recorder.google.com)

## Installation

```bash
git clone https://github.com/dylantmoore/google-recorder-cli.git
cd google-recorder-cli
npm install
npm run build
```

To install globally (makes `google-recorder` available anywhere):

```bash
npm link
```

Or run directly without installing globally:

```bash
node dist/cli.js <command>
```

## Authentication Setup

The tool needs Google cookies from Chrome to authenticate. There are three methods:

### Method 1: Automatic extraction from Chrome (recommended, macOS only)

This reads cookies directly from Chrome's local database. No manual steps needed after initial Keychain approval.

```bash
google-recorder auth --chrome
# With specific account index:
google-recorder auth --chrome --authuser 1
```

On first run, macOS will ask for Keychain access to "Chrome Safe Storage" — click **Always Allow** so it doesn't prompt again. After that, `auth --chrome` works silently and can be run any time to refresh cookies.

### Method 2: Playwright browser login (cross-platform)

Opens a Chrome window with a persistent profile. You log in once; subsequent runs reuse the session.

```bash
google-recorder auth --browser
# Headless refresh (after initial login):
google-recorder auth --refresh
```

### Method 3: Manual cookie paste

Copy cookies from Chrome DevTools:

1. Open [recorder.google.com](https://recorder.google.com) in Chrome
2. Open DevTools (`Cmd+Option+I` on Mac, `F12` on Windows/Linux)
3. Go to the **Network** tab, refresh the page
4. Click any request to `pixelrecorder-pa.clients6.google.com`
5. In **Headers** → **Request Headers**, find **Cookie**
6. Right-click the value and select **Copy value**
7. Run and paste:

```bash
google-recorder auth
```

### Verify authentication

```bash
google-recorder auth --check
```

### Multi-account users

If you're signed into multiple Google accounts in Chrome, specify the account index. The index corresponds to `authuser` in Google URLs (0 for first account, 1 for second, etc.).

```bash
google-recorder auth --chrome --authuser 1
```

### Auth storage

Credentials are stored at `~/.config/google-recorder/auth.json` with restricted permissions (owner-only read/write). The file contains your browser cookies, so treat it as sensitive.

### Cookie expiration

Google cookies expire periodically. When authentication fails, just re-run your preferred auth method. With `--chrome`, this is a single command.

## Commands

### `auth` — Set up authentication

```bash
# Automatic extraction from Chrome (recommended, macOS)
google-recorder auth --chrome

# Playwright browser login (cross-platform)
google-recorder auth --browser

# Headless cookie refresh (after Playwright login)
google-recorder auth --refresh

# Manual cookie paste
google-recorder auth

# With specific account index (works with all methods)
google-recorder auth --chrome --authuser 1

# Test existing authentication
google-recorder auth --check
```

### `list` — List recent recordings

```bash
# List 20 most recent recordings (default)
google-recorder list

# List more recordings
google-recorder list --limit 50

# Output as JSON
google-recorder list --json
```

### `info <id>` — Show recording details

```bash
google-recorder info <recording-uuid>

# JSON output
google-recorder info <recording-uuid> --json
```

### `transcript <id>` — Download a single transcript

```bash
# Print to stdout
google-recorder transcript <recording-uuid>

# Save to file
google-recorder transcript <recording-uuid> -o transcript.txt

# JSON output (includes speaker segments and timing)
google-recorder transcript <recording-uuid> --json

# Plain text (no speaker labels)
google-recorder transcript <recording-uuid> --plain
```

### `audio <id>` — Download audio for a recording

```bash
# Download with server-provided filename (e.g., "Feb 5 at 12-07 PM.m4a")
google-recorder audio <recording-uuid>

# Save to specific file
google-recorder audio <recording-uuid> -o meeting.m4a
```

Audio files are downloaded as m4a (MPEG-4 audio) from `usercontent.recorder.google.com`.

### `search <query>` — Search recordings by title

```bash
google-recorder search "meeting notes"

# Limit results
google-recorder search "meeting" --limit 5

# JSON output
google-recorder search "meeting" --json
```

### `download` — Bulk download transcripts

```bash
# Download to current directory
google-recorder download

# Download to specific directory
google-recorder download -o ./transcripts

# Limit number of recordings
google-recorder download --limit 100

# Only recordings after a specific date
google-recorder download --since 2025-01-01

# Skip recordings already downloaded
google-recorder download --skip-existing

# JSON format
google-recorder download --format json

# Combined
google-recorder download -o ./transcripts --limit 50 --since 2025-12-01 --skip-existing
```

### `download-audio` — Bulk download audio files

```bash
# Download to current directory
google-recorder download-audio

# Download to specific directory
google-recorder download-audio -o ./audio

# Limit number of recordings
google-recorder download-audio --limit 10

# Only recordings after a specific date
google-recorder download-audio --since 2025-01-01

# Skip recordings already downloaded
google-recorder download-audio --skip-existing

# Combined
google-recorder download-audio -o ./audio --limit 20 --since 2025-12-01 --skip-existing
```

### `config` — Show current configuration

```bash
google-recorder config
```

## Transcript Format

### Text format (default)

```
Recording: Feb 5 at 12:07 PM
Date: 2/5/2026, 12:07:30 PM
Duration: 33:12
ID: bf3451e0-4ea6-424e-8e77-fbef4c0fe17c

=== Transcript ===

[Speaker 1] (00:00)
Hello, welcome to today's meeting...

[Speaker 2] (01:23)
Thanks for having me...
```

### JSON format

```json
{
  "recording": {
    "id": "bf3451e0-...",
    "title": "Feb 5 at 12:07 PM",
    "date": "2026-02-05T22:07:30.207Z",
    "duration": "33:12"
  },
  "transcript": {
    "recordingId": "bf3451e0-...",
    "segments": [
      {
        "speaker": "Speaker 1",
        "text": "Hello, welcome to today's meeting...",
        "startTime": "00:00"
      }
    ],
    "rawText": "..."
  }
}
```

## New Machine Setup

1. Install Node.js 20+ (via [nvm](https://github.com/nvm-sh/nvm), [Homebrew](https://brew.sh), or [nodejs.org](https://nodejs.org))
2. Clone and build this repo:
   ```bash
   git clone https://github.com/dylantmoore/google-recorder-cli.git
   cd google-recorder-cli
   npm install
   npm run build
   ```
3. Authenticate (see [Authentication Setup](#authentication-setup)):
   ```bash
   # macOS (recommended):
   google-recorder auth --chrome --authuser 0
   # Other platforms:
   google-recorder auth --browser
   ```
4. Verify:
   ```bash
   google-recorder auth --check
   google-recorder list --limit 3
   ```

## Troubleshooting

### "Not authenticated" error
Run `google-recorder auth` to set up or refresh your cookies.

### "API request failed: 401"
Your cookies have expired. Re-authenticate by running `google-recorder auth` again.

### "API request failed: 403"
Wrong account index. Try different `--authuser` values (0, 1, 2, etc.) when running `google-recorder auth --authuser N`.

### "Audio download failed: 404"
Your cookies may need refreshing. Audio downloads use a different Google endpoint (`usercontent.recorder.google.com`) than transcripts and may be more sensitive to cookie freshness. Re-authenticate with `google-recorder auth`.

### No recordings shown
Make sure your recordings are synced to the cloud. Open [recorder.google.com](https://recorder.google.com) in your browser to verify they appear there.

### "Invalid recording ID format"
Recording IDs must be UUIDs (e.g., `bf3451e0-4ea6-424e-8e77-fbef4c0fe17c`). Use `google-recorder list` to find valid IDs.

## How It Works

The tool uses two Google APIs, both authenticated with browser cookies:

### Transcript API (gRPC-web)

Communicates with `pixelrecorder-pa.clients6.google.com` using JSON-encoded protobuf payloads and SAPISIDHASH authentication (a timestamp-based HMAC using your SAPISID cookie).

Two RPC methods are available on the `PlaybackService`:
- **GetRecordingList** — Returns metadata for all recordings (title, date, duration, location)
- **GetTranscription** — Returns the full transcript with speaker diarization and word-level timestamps

### Audio Download API (HTTP)

Downloads audio files from `usercontent.recorder.google.com` via simple GET requests:

```
GET /download/playback/{recording-id}?authuser={N}&download=true
```

Returns m4a audio files with the original filename in the `Content-Disposition` header.

## License

MIT
