import { loadUserConfig, applyEnvOverlay } from '../src/user-config.js';
import { DirectSolanaWalletProvider } from '@b1dz/wallet-direct';
const cfg = await loadUserConfig(process.env.USER_ID!);
await applyEnvOverlay(cfg, async () => {
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) { console.log('SOLANA_PRIVATE_KEY not set'); return; }
  const provider = new DirectSolanaWalletProvider({ privateKey: key });
  const address = await provider.getAddress('solana');
  console.log('Solana address:', address);
});
