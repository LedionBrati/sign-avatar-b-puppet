// Types for the modules the artifact build aliases in (vite.artifact.config.ts). Plain JS on the other side.

declare module "virtual:artifact-clips" {
  /** The bundled clips: `file` is relative to the page ("clips/HELLO.mp4"). Generated from the clip manifests. */
  export const CLIPS: { motion_id: string; gloss: string; file: string; duration_s: number }[];
}

declare module "@sl/translate" {
  export function translateRules(text: string, vocab: { motion_id: string; gloss: string }[], options?: Record<string, unknown>): ArtifactPlan;
  export interface ArtifactPlan { input_text: string; items: unknown[]; unsupported_tokens: string[]; ok: boolean; [k: string]: unknown }
}

declare module "@sl/sign" {
  import type { ArtifactPlan } from "@sl/translate";
  import type { PlaylistItem } from "@signlayer/core";
  export function planToPlaylist(plan: ArtifactPlan, clips: ArtifactClipSets): {
    words: string[]; playlist: PlaylistItem[]; unsupported: string[]; fingerspell: string[]; markers: { type: string; from: number; to: number }[];
  };
  export interface ArtifactClip { motion_id: string; gloss: string; url: string; duration_s: number }
  export interface ArtifactClipSets { signs: Map<string, ArtifactClip>; letters: Map<string, ArtifactClip> }
}

declare module "@sl/safety" {
  import type { SigningSafety } from "@signlayer/core";
  import type { ArtifactPlan } from "@sl/translate";
  import type { ArtifactClipSets } from "@sl/sign";
  export function assessSigning(text: string, plan: ArtifactPlan, clips: ArtifactClipSets): SigningSafety;
}
