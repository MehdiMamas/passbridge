// where releases come from. release builds keep null, so GitHub and the pinned key are used; test builds
// replace this module with a local server and a test key (releaseSource in scripts/build.mjs)

/** @type {{ latestUrl: string, publicKey: string } | null} */
export const RELEASE_SOURCE = null;
