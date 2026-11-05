/** @param {number} n */
function randBelow(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}
/** @param {string | string[]} set */
function pickFrom(set) {
  return set[randBelow(set.length)];
}

// apple's Strong Password (per rmondello): 20 chars, three CVCCVC syllables hyphenated, 1 upper + 1 digit
export function generateApplePassword() {
  const C = "bcdfghjkmnpqrstvwxz"; // no ambiguous 'l'
  const V = "aeiouy";
  const groups = [];
  for (let g = 0; g < 3; g++) {
    groups.push([pickFrom(C), pickFrom(V), pickFrom(C), pickFrom(C), pickFrom(V), pickFrom(C)]);
  }
  // digit goes either side of a hyphen or at the end, per apple
  const digitSlots = [[0, 5], [1, 0], [1, 5], [2, 0], [2, 5]];
  const [dg, dp] = digitSlots[randBelow(digitSlots.length)];
  groups[dg][dp] = String(randBelow(10));
  let ug, up;
  do {
    ug = randBelow(3);
    up = randBelow(6);
  } while (ug === dg && up === dp);
  groups[ug][up] = groups[ug][up].toUpperCase();
  return groups.map((g) => g.join("")).join("-");
}

// apple's "Without Special Characters" fallback, 15 chars matches apple's own output
export function generateAlphanumericPassword(len = 15) {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digit = "0123456789";
  const all = lower + upper + digit;
  const chars = [pickFrom(lower), pickFrom(upper), pickFrom(digit)];
  while (chars.length < len) chars.push(pickFrom(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
