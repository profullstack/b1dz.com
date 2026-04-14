/**
 * Tiny base58 codec — Solana signatures and public keys use base58
 * encoding. Zero runtime deps. Duplicated (intentionally) from
 * @b1dz/wallet-direct to avoid making the adapter depend on the
 * wallet package.
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]!] = i;

export function base58encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const input = Array.from(bytes.subarray(zeros));
  const out: number[] = [];
  while (input.length > 0) {
    let carry = 0;
    const next: number[] = [];
    for (const digit of input) {
      const acc = carry * 256 + digit;
      const q = Math.floor(acc / 58);
      carry = acc % 58;
      if (next.length > 0 || q > 0) next.push(q);
    }
    out.push(carry);
    input.length = 0;
    input.push(...next);
  }
  return '1'.repeat(zeros) + out.reverse().map((i) => B58_ALPHABET[i]).join('');
}

export function base58decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP[s[i]!];
    if (v === undefined) throw new Error(`invalid base58 character: ${s[i]}`);
    digits.push(v);
  }
  const input = digits;
  const out: number[] = [];
  while (input.length > 0) {
    let carry = 0;
    const next: number[] = [];
    for (const digit of input) {
      const acc = carry * 58 + digit;
      const q = Math.floor(acc / 256);
      carry = acc % 256;
      if (next.length > 0 || q > 0) next.push(q);
    }
    out.push(carry);
    input.length = 0;
    input.push(...next);
  }
  const body = out.reverse();
  const result = new Uint8Array(zeros + body.length);
  for (let i = 0; i < body.length; i++) result[zeros + i] = body[i]!;
  return result;
}
