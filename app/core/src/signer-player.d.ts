// Types of "@flux/signer-player", i.e. puppet/src/player.ts (the instant 3D signer, three.js). The web and extension
// bundlers alias it to the puppet source and bundle it as a lazy chunk; their typechecks map it here instead (web:
// tsconfig paths, extension: the prepare:tsconfig hook in wxt.config.ts), typed by the shape Signer3D needs, so they
// never compile the puppet sources.
import type { SignerPlayerModule } from "./signer3d.ts";

export declare const SignerPlayer: SignerPlayerModule["SignerPlayer"];
