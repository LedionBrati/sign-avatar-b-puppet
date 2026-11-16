// puppet/src/player.ts, aliased in wxt.config.ts and bundled as a lazy chunk (three.js included). Typed by the shape
// app/core needs, so the extension typecheck does not compile the puppet sources.
declare module "@signlayer/signer-player" {
  import type { SignerPlayerModule } from "@signlayer/core";
  export const SignerPlayer: SignerPlayerModule["SignerPlayer"];
}
