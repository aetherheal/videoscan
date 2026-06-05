// Shared types that flow between pipeline layers.
//
// Layer 3 (ASR) → WhisperTranscript
// Layer 4 (judgment) → ClipSpec[]  (the build manifest)
// Layer 5 (ffmpeg) consumes ClipSpec[]

export interface WhisperWord {
  start: number; // seconds
  end: number; // seconds
  word: string;
}

export interface WhisperSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  words: WhisperWord[];
}

export interface WhisperTranscript {
  source_file: string;
  language: string;
  duration: number; // seconds
  segments: WhisperSegment[];
}

// Optional context Layer 3 may hand to Layer 4 (per the INPUT CONTRACT).
export interface VideoContext {
  title?: string;
  shoot_date?: string;
  series?: string;
}
