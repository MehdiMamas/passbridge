import { ApplePasswords } from "../apple/protocol.js";
import { createMockClient } from "./mock-client.js";
import { MOCK_KIND } from "./mock-kind.js";

// the mock answers the same calls with the same shapes, so callers are typed against the real client.
// this file is not @ts-check, the mock is not an instance of ApplePasswords
/** @returns {ApplePasswords} */
export function createClient() {
  if (MOCK_KIND) return createMockClient(MOCK_KIND);
  return new ApplePasswords();
}
