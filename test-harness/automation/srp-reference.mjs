// SRP-6a written from RFC 5054 with node:crypto and plain BigInt, sharing no code with src/apple/.
// The tests check it against the RFC 5054 appendix B vectors, then use it to grade src/apple/srp.js.

import { createHash } from "node:crypto";

export const GROUP_1024 = {
  N: BigInt(
    "0xEEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3",
  ),
  g: 2n,
};

export const GROUP_3072 = {
  N: BigInt(
    "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
  ),
  g: 5n,
};

export const big = (buf) => (buf.length ? BigInt("0x" + Buffer.from(buf).toString("hex")) : 0n);

// minimal big-endian, or left-padded with zeros to len
export function bytes(n, len = 0) {
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  const b = Buffer.from(h, "hex");
  if (len && b.length > len) throw new Error(`${b.length} bytes do not fit in ${len}`);
  return len ? Buffer.concat([Buffer.alloc(len - b.length), b]) : b;
}

export function modPow(base, exp, m) {
  let r = 1n;
  base %= m;
  if (base < 0n) base += m;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
}

export function group({ N, g }, hash) {
  const NB = bytes(N).length;
  const H = (...parts) => createHash(hash).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
  const PAD = (n) => bytes(n, NB);
  const k = big(H(bytes(N), PAD(g)));
  const x = (I, P, s) => big(H(s, H(Buffer.from(`${I}:${P}`, "utf8"))));
  return {
    N,
    g,
    H,
    PAD,
    k,
    x,
    verifier: (I, P, s) => modPow(g, x(I, P, s), N),
    publicA: (a) => modPow(g, a, N),
    publicB: (b, v) => (k * v + modPow(g, b, N)) % N,
    u: (A, B) => big(H(PAD(A), PAD(B))),
    clientS: (a, B, xv, u) => modPow((((B - k * modPow(g, xv, N)) % N) + N) % N, a + u * xv, N),
    serverS: (A, v, u, b) => modPow((A * modPow(v, u, N)) % N, b, N),
  };
}

// Apple's variant over the 3072-bit group: K = H(S) as a 32-byte digest,
// M = H(H(N) xor H(PAD(g)) | H(I) | s | A | B | K), HAMK = H(A | M | K), A and B minimal bytes.
export function appleServer({ username, pin, salt, A, b }) {
  const G = group(GROUP_3072, "sha256");
  const v = G.verifier(username, pin, salt);
  const B = G.publicB(b, v);
  const S = G.serverS(A, v, G.u(A, B), b);
  const K = G.H(bytes(S));
  const hN = G.H(bytes(G.N));
  const hg = G.H(G.PAD(G.g));
  const xored = Buffer.from(hN.map((byte, i) => byte ^ hg[i]));
  const M = G.H(xored, G.H(Buffer.from(username, "utf8")), salt, bytes(A), bytes(B), K);
  const HAMK = G.H(bytes(A), M, K);
  return { B, S, K, M, HAMK };
}
