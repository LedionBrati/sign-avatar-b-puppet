// puppet/src/player.ts, aliased in vite.config.ts and bundled as a lazy chunk (three.js included). Typed by the shape
// app/core needs, so the web typecheck does not compile the puppet sources.
declare module "@signlayer/signer-player" {
  import type { SignerPlayerModule } from "@signlayer/core";
  export const SignerPlayer: SignerPlayerModule["SignerPlayer"];
}
