/**
 * Google Recorder API Client
 *
 * Direct HTTP calls to the Recorder gRPC-web API.
 * Uses SAPISIDHASH authentication extracted from browser cookies.
 */

import { createHash } from 'node:crypto';
import type {
  AuthData,
  Recording,
  Transcript,
  TranscriptSegment,
  RecordingListResponse,
  TranscriptionResponse,
} from './types.js';
import { loadAuth } from './auth.js';

const API_BASE =
  'https://pixelrecorder-pa.clients6.google.com/$rpc/java.com.google.wireless.android.pixel.recorder.protos.PlaybackService';
const ORIGIN = 'https://recorder.google.com';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Authentication
// ============================================================================

/**
 * Compute SAPISIDHASH for Google API authentication.
 * Format: SAPISIDHASH <timestamp>_<sha1(timestamp + " " + sapisid + " " + origin)>
 */
function computeSapisidHash(sapisid: string, origin: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;
  const hash = createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

/**
 * Try to refresh cookies from Chrome automatically.
 * Returns fresh AuthData on success, null on failure.
 */
async function tryAutoRefresh(authUser: number): Promise<AuthData | null> {
  try {
    const { extractChromeCookiesSilent } = await import('./chrome-cookies.js');
    const ok = await extractChromeCookiesSilent(authUser);
    if (ok) {
      return loadAuth();
    }
  } catch {
    // Chrome cookie extraction not available (not macOS, Chrome not installed, etc.)
  }
  return null;
}

/**
 * Make a single authenticated API request.
 */
function makeApiRequest<T>(
  endpoint: string,
  body: unknown[],
  auth: AuthData
): Promise<Response> {
  const url = `${API_BASE}/${endpoint}`;
  const authHeader = computeSapisidHash(auth.sapisid, ORIGIN);

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'X-Goog-Api-Key': auth.apiKey,
      'Authorization': authHeader,
      'X-Goog-AuthUser': String(auth.authUser),
      'X-User-Agent': 'grpc-web-javascript/0.1',
      'Origin': ORIGIN,
      'Referer': ORIGIN + '/',
      'Cookie': auth.cookies,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Make an authenticated API request with automatic cookie refresh on 401.
 */
async function apiRequest<T>(
  endpoint: string,
  body: unknown[],
  auth: AuthData,
  onAuthRefreshed?: (newAuth: AuthData) => void
): Promise<T> {
  let response = await makeApiRequest(endpoint, body, auth);

  // On 401, try to auto-refresh cookies from Chrome and retry
  if (response.status === 401) {
    const freshAuth = await tryAutoRefresh(auth.authUser);
    if (freshAuth) {
      process.stderr.write('Cookies expired — refreshed automatically from Chrome.\n');
      onAuthRefreshed?.(freshAuth);
      response = await makeApiRequest(endpoint, body, freshAuth);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse API response: ${text.substring(0, 200)}`);
  }
}

// ============================================================================
// Public API
// ============================================================================

export class RecorderAPI {
  private auth: AuthData | null = null;

  constructor() {
    this.auth = loadAuth();
  }

  isAuthenticated(): boolean {
    return this.auth !== null && !!this.auth.sapisid;
  }

  /** Called when auto-refresh produces new auth — updates the in-memory copy. */
  private onAuthRefreshed = (newAuth: AuthData): void => {
    this.auth = newAuth;
  };

  private ensureAuth(): AuthData {
    if (!this.auth || !this.auth.sapisid) {
      throw new Error(
        'Not authenticated. Run `google-recorder auth --chrome` to set up authentication.'
      );
    }
    if (!this.auth.apiKey) {
      throw new Error(
        'No API key configured. Extract it from Chrome DevTools:\n' +
        '  1. Open recorder.google.com, open DevTools (Network tab)\n' +
        '  2. Find the "X-Goog-Api-Key" header in any request to pixelrecorder-pa\n' +
        '  3. Run: google-recorder auth --api-key <key>'
      );
    }
    return this.auth;
  }

  /**
   * List recordings, most recent first.
   * @param limit Maximum number of recordings to return (default 50)
   */
  async listRecordings(limit: number = 50): Promise<Recording[]> {
    const auth = this.ensureAuth();

    // GetRecordingList request: [[{"1": timestamp_seconds}], page_size]
    const nowSeconds = Math.floor(Date.now() / 1000);
    const response = await apiRequest<RecordingListResponse>(
      'GetRecordingList',
      [[{ '1': nowSeconds }], limit],
      auth,
      this.onAuthRefreshed
    );

    if (!response || !response[0]) {
      return [];
    }

    return response[0].slice(0, limit).map((item) => {
      const [id, title, createdTimestamp, durationTimestamp, , , location, , , , , , , webId] = item;
      const createdMs = parseInt(createdTimestamp[0]) * 1000 + Math.floor(createdTimestamp[1] / 1000000);
      const durationMs = parseInt(durationTimestamp[0]) * 1000 + Math.floor(durationTimestamp[1] / 1000000);

      return {
        id: (webId as string) || id,
        deviceId: id,
        title: title || new Date(createdMs).toLocaleString(),
        date: new Date(createdMs).toISOString(),
        duration: formatDuration(durationMs),
        durationMs,
        location: location || undefined,
        hasTranscript: true,
      };
    });
  }

  /**
   * Get the transcript for a specific recording.
   * @param recordingId UUID of the recording (web ID)
   */
  async getTranscript(recordingId: string): Promise<Transcript | null> {
    if (!UUID_REGEX.test(recordingId)) {
      throw new Error(`Invalid recording ID format: ${recordingId}. Expected UUID.`);
    }

    const auth = this.ensureAuth();

    const response = await apiRequest<TranscriptionResponse>(
      'GetTranscription',
      [recordingId],
      auth,
      this.onAuthRefreshed
    );

    if (!response || !response[0] || response[0].length === 0) {
      return null;
    }

    const segments: TranscriptSegment[] = [];
    let currentSpeaker = -1;
    let currentText = '';
    let currentStartTime = '00:00';

    for (const segment of response[0]) {
      const [words, speakerId] = segment;

      if (speakerId !== currentSpeaker && currentText) {
        segments.push({
          speaker: `Speaker ${currentSpeaker + 1}`,
          text: currentText.trim(),
          startTime: currentStartTime,
        });
        currentText = '';
      }

      if (speakerId !== currentSpeaker) {
        currentSpeaker = speakerId;
        currentStartTime = words[0] ? formatTime(parseInt(words[0][2])) : '00:00';
      }

      for (const word of words) {
        const [text, formatted] = word;
        const wordText = formatted || text;
        currentText += wordText + ' ';
      }
    }

    if (currentText) {
      segments.push({
        speaker: `Speaker ${currentSpeaker + 1}`,
        text: currentText.trim(),
        startTime: currentStartTime,
      });
    }

    const rawText = segments
      .map((s) => `[${s.speaker}] (${s.startTime})\n${s.text}`)
      .join('\n\n');

    return {
      recordingId,
      recordingTitle: '',
      segments,
      rawText,
    };
  }

  /**
   * Search recordings by title (client-side filter).
   */
  async searchRecordings(query: string, limit: number = 20): Promise<Recording[]> {
    const all = await this.listRecordings(100);
    const lowerQuery = query.toLowerCase();
    return all
      .filter((r) => r.title.toLowerCase().includes(lowerQuery))
      .slice(0, limit);
  }

  /**
   * Download audio for a recording.
   * Uses the usercontent.recorder.google.com download endpoint.
   * Returns raw audio bytes and content type.
   */
  async getAudio(recordingId: string): Promise<{ data: Buffer; contentType: string; filename: string }> {
    if (!UUID_REGEX.test(recordingId)) {
      throw new Error(`Invalid recording ID format: ${recordingId}. Expected UUID.`);
    }

    let auth = this.ensureAuth();

    const makeAudioRequest = (a: AuthData) => {
      const url = `https://usercontent.recorder.google.com/download/playback/${recordingId}?authuser=${a.authUser}&download=true`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Cookie': a.cookies,
          'Referer': ORIGIN + '/',
        },
        redirect: 'follow',
      });
    };

    let response = await makeAudioRequest(auth);

    // On 401 or 404 (audio endpoint returns 404 for expired cookies), auto-refresh
    if (response.status === 401 || response.status === 404) {
      const freshAuth = await tryAutoRefresh(auth.authUser);
      if (freshAuth) {
        process.stderr.write('Cookies expired — refreshed automatically from Chrome.\n');
        this.auth = freshAuth;
        auth = freshAuth;
        response = await makeAudioRequest(auth);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Audio download failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') || 'audio/mp4';
    const contentDisposition = response.headers.get('content-disposition') || '';

    // Extract filename from Content-Disposition header if present
    let filename = `${recordingId}.m4a`;
    const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
    if (filenameMatch) {
      filename = filenameMatch[1];
    }

    const data = Buffer.from(await response.arrayBuffer());

    return { data, contentType, filename };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

let apiInstance: RecorderAPI | null = null;

export function getRecorderAPI(): RecorderAPI {
  if (!apiInstance) {
    apiInstance = new RecorderAPI();
  }
  return apiInstance;
}
