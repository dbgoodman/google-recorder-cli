/**
 * Google Recorder CLI - Type Definitions
 */

// ============================================================================
// Public Types
// ============================================================================

export interface Recording {
  id: string;         // Web ID (UUID) for API calls
  deviceId?: string;  // Device-generated ID
  title: string;
  date: string;       // ISO 8601 string
  duration: string;   // Human-readable (e.g., "5:23" or "1:02:15")
  durationMs: number; // Duration in milliseconds
  location?: string;
  hasTranscript: boolean;
}

export interface Transcript {
  recordingId: string;
  recordingTitle: string;
  segments: TranscriptSegment[];
  rawText: string;
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  startTime?: string;
}

export interface AuthData {
  sapisid: string;
  cookies: string;
  authUser: number;    // X-Goog-AuthUser index (for multi-account)
  apiKey: string;      // X-Goog-Api-Key (extracted from Chrome or DevTools)
  savedAt: string;
}

// ============================================================================
// Internal API Response Types (JSON-encoded protobuf from gRPC-web)
// ============================================================================

// GetRecordingList response:
// [[recordings], pagination_token]
// Each recording: [id, title, [created_sec, created_nano], [duration_sec, duration_nano], lat, lng, location, ...]
export type RecordingListResponse = [
  Array<[
    string,           // [0] recording ID (device UUID)
    string,           // [1] title
    [string, number], // [2] created timestamp [seconds_string, nanoseconds]
    [string, number], // [3] duration [seconds_string, nanoseconds]
    number,           // [4] latitude
    number,           // [5] longitude
    string,           // [6] location name
    unknown,          // [7]
    unknown,          // [8] audio format info
    unknown,          // [9] tags
    unknown,          // [10] speaker segments
    string,           // [11] some ID
    unknown,          // [12]
    string,           // [13] web ID (UUID for API calls)
    ...unknown[]
  ]>,
  number?  // pagination token
];

// GetTranscription response:
// [[[segments], ...]]
// Each segment: [[words], segment_speaker_id, language]
// NOTE: as of ~2026-07 the segment-level speaker_id is always 0. The real
// per-turn diarization moved INTO each word's last field: word[6] = [group, speakerId].
// Each word: [text, formatted_text, start_ms_str, end_ms_str, null, null, [group, speakerId]]
export type TranscriptionResponse = [
  Array<[
    Array<[string, string | null, string, string, unknown, unknown, [number, number] | unknown]>,
    number,  // legacy segment-level speaker ID (now always 0)
    string,  // language code
  ]>
];
