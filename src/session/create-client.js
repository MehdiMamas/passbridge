import { ApplePasswords } from "../apple/protocol.js";
import { createMockClient } from "./mock-client.js";
import { MOCK_KIND } from "./mock-kind.js";

// the mock answers the same calls with the same shapes, so callers are typed against the real client.
// the mock is not an instance of ApplePasswords, so it is cast
/** @returns {ApplePasswords} */
export function createClient() {
  if (MOCK_KIND) return /** @type {ApplePasswords} */ (/** @type {unknown} */ (createMockClient(MOCK_KIND)));
  return new ApplePasswords();
}
