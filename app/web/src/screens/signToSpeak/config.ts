// Sign -> speak tuning (screens/SignToSpeak.tsx and its hooks in this folder).

/** Below this the top-3 chips get a "not sure" hint. */
export const LOW = 0.35;
/** Open vocabulary: a sign is only taken when the recognizer is at least this sure. */
export const MIN_CONF = 0.25;
/** The segmenter needs ~this much stillness before it ends a segment (the rest timer counts from before it). */
export const END_LAG_MS = 300;
/** Hands rested this long (nothing still being read) -> speak. */
export const REST_MS = 900;
/** At rest, wait this long for the model's sentence, then speak the local one. */
export const WAIT_MS = 1200;
/** Spoken at this many signs even without a rest. */
export const CAP = 8;
/** Guesses per sign sent to /api/compose (with their scores): the sentence model picks the combination that makes sense. */
export const TOP_OPTIONS = 3;
/** Conversation turns sent with every compose call. */
export const HISTORY_TURNS = 10;
/** Sentences this screen spoke that go with every compose call as context. */
export const SAID_CONTEXT = 2;
/** Sentences kept in the "Said" sheet. */
export const SAID_HISTORY = 8;
/** Timeout of the API client (recognize, compose, health). */
export const CLIENT_TIMEOUT_MS = 12_000;
/** Natural voice (/api/speak) not back by then -> the device voice. */
export const VOICE_MS = 12_000;
/** "Speaking" ends after this long at the latest: SPEAK_MS + SPEAK_CHAR_MS per character. */
export const SPEAK_MS = 2500;
export const SPEAK_CHAR_MS = 70;
export const NOT_SURE = "Not sure about that one. Tap the right word below.";
