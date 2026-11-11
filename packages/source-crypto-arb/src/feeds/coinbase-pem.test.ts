import { afterEach, describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { getCoinbaseKeyName, getCoinbasePem, getCoinbaseSigner, parseCoinbaseKeyFile, parseEd25519Secret } from './coinbase-pem.js';

const saved = process.env.COINBASE_API_PRIVATE_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.COINBASE_API_PRIVATE_KEY;
  else process.env.COINBASE_API_PRIVATE_KEY = saved;
});

function cdpEd25519Secret() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: Buffer.concat([seed, pub]).toString('base64'), publicKey };
}

describe('coinbase signer', () => {
  it('signs EdDSA with a CDP Ed25519 secret', () => {
    const { secret, publicKey } = cdpEd25519Secret();
    process.env.COINBASE_API_PRIVATE_KEY = secret;
    const signer = getCoinbaseSigner();
    expect(signer?.alg).toBe('EdDSA');
    const sig = signer!.sign('header.payload');
    expect(verify(null, Buffer.from('header.payload'), publicKey, sig)).toBe(true);
    expect(getCoinbasePem()).toBeNull();
  });

  it('rejects a 64-byte value whose second half is not the public key', () => {
    const { secret } = cdpEd25519Secret();
    const bytes = Buffer.from(secret, 'base64');
    bytes[40] ^= 0xff;
    expect(parseEd25519Secret(bytes.toString('base64'))).toBeNull();
  });

  it('still signs ES256 with an EC PEM', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    process.env.COINBASE_API_PRIVATE_KEY = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    const signer = getCoinbaseSigner();
    expect(signer?.alg).toBe('ES256');
    const sig = signer!.sign('header.payload');
    expect(sig.length).toBe(64);
    expect(verify('SHA256', Buffer.from('header.payload'), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  const NAME = 'organizations/11111111-2222-3333-4444-555555555555/apiKeys/66666666-7777-8888-9999-000000000000';

  it('takes the whole downloaded key file: ES256 signer and the full key name', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    process.env.COINBASE_API_PRIVATE_KEY = JSON.stringify({ name: NAME, privateKey: pem });
    delete process.env.COINBASE_API_KEY_NAME;
    expect(getCoinbaseKeyName()).toBe(NAME);
    const signer = getCoinbaseSigner();
    expect(signer?.alg).toBe('ES256');
    const sig = signer!.sign('h.p');
    expect(verify('SHA256', Buffer.from('h.p'), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('prefers the key file full name over a bare key id typed in the name field', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    process.env.COINBASE_API_PRIVATE_KEY = JSON.stringify({ name: NAME, privateKey: privateKey.export({ format: 'pem', type: 'sec1' }).toString() });
    process.env.COINBASE_API_KEY_NAME = '66666666-7777-8888-9999-000000000000';
    expect(getCoinbaseKeyName()).toBe(NAME);
    delete process.env.COINBASE_API_KEY_NAME;
  });

  it('keeps a PKCS#8 PEM intact, even pasted on one line', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    process.env.COINBASE_API_PRIVATE_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\n/g, ' ');
    const signer = getCoinbaseSigner();
    expect(signer?.alg).toBe('ES256');
    const sig = signer!.sign('h.p');
    expect(verify('SHA256', Buffer.from('h.p'), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('a key file with escaped newlines in privateKey still signs', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    // JSON.stringify writes \n escapes, exactly like the downloaded file.
    const file = `{\n  "name": "${NAME}",\n  "privateKey": ${JSON.stringify(pem)}\n}\n`;
    expect(parseCoinbaseKeyFile(file)?.name).toBe(NAME);
    process.env.COINBASE_API_PRIVATE_KEY = file;
    expect(getCoinbaseSigner()?.alg).toBe('ES256');
  });
});
