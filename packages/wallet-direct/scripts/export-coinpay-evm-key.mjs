#!/usr/bin/env node
// Export the EVM (Ethereum / Base / Polygon / Arbitrum / Optimism / BSC)
// private key + address from the local coinpay wallet.
//
// Reads ~/.coinpay-wallet.gpg (or --wallet-file), decrypts with the
// password from --password / COINPAY_WALLET_PASSWORD / interactive
// prompt, derives BIP44 m/44'/60'/0'/0/0 (the same path coinpay uses
// for ETH), and prints the address + raw 0x… private key. Nothing is
// written to disk and nothing is sent over the network.
//
// The same address controls funds on every EVM chain because they
// share the secp256k1 + Keccak-256 address scheme. Fund it on Base
// Mainnet for the b1dz UniswapV3BaseExecutor.
//
// Run from a workspace package that has viem on its resolution path
// (the npm script `pnpm export-evm-key` handles this automatically).
//
// Usage:
//   pnpm export-evm-key                        # interactive prompt
//   pnpm export-evm-key -- --password <pass>
//   COINPAY_WALLET_PASSWORD=<pass> pnpm export-evm-key

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';

import { mnemonicToAccount } from 'viem/accounts';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--password') out.password = argv[++i];
    else if (a === '--wallet-file') out.walletFile = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function gpgDecrypt(file, password) {
  return new Promise((res, rej) => {
    const proc = spawn('gpg', [
      '--batch', '--yes', '--passphrase-fd', '0',
      '--decrypt', file,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    proc.on('close', code => {
      if (code === 0) res(stdout);
      else rej(new Error(`gpg decrypt failed (exit ${code}): ${stderr.trim()}`));
    });
    proc.stdin.write(password + '\n');
    proc.stdin.end();
  });
}

function promptPassword() {
  return new Promise(res => {
    const muted = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write('coinpay wallet password: ');
    rl.question('', answer => {
      rl.close();
      process.stdout.write('\n');
      res(answer);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/export-coinpay-evm-key.mjs [--password <pass>] [--wallet-file <path>]');
    process.exit(0);
  }

  const file = args.walletFile || resolve(homedir(), '.coinpay-wallet.gpg');
  if (!existsSync(file)) {
    console.error(`Wallet file not found: ${file}`);
    process.exit(1);
  }

  const password = args.password || process.env.COINPAY_WALLET_PASSWORD || await promptPassword();
  if (!password) {
    console.error('No password provided.');
    process.exit(1);
  }

  const json = await gpgDecrypt(file, password);
  const data = JSON.parse(json);
  if (!data.mnemonic) {
    console.error('Wallet file has no mnemonic.');
    process.exit(1);
  }

  const path = "m/44'/60'/0'/0/0";
  const account = mnemonicToAccount(data.mnemonic, { path });
  const pkBytes = account.getHdKey().privateKey;
  if (!pkBytes) {
    console.error('Failed to derive private key.');
    process.exit(1);
  }
  const pkHex = '0x' + Buffer.from(pkBytes).toString('hex');

  console.log('');
  console.log('  EVM address (fund this on Base Mainnet):');
  console.log('    ' + account.address);
  console.log('');
  console.log('  EVM private key (paste into b1dz .env as EVM_PRIVATE_KEY):');
  console.log('    ' + pkHex);
  console.log('');
  console.log("  Derivation path: " + path);
  console.log('');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
