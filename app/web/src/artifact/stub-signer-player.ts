// The standalone artifact build has no 3D signer (no server for the avatar and motions): keep three.js out of it.
export const SignerPlayer = {
  create(): Promise<never> { return Promise.reject(new Error("no 3D signer in the artifact build")); },
};
