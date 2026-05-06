import { createPublicClient, http, erc20Abi } from '@b1dz/adapters-evm';
import { base } from '@b1dz/adapters-evm';
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL!) });
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`;
const wallet = '0x009D077199437F57973eA33bD362eE05a9527b89' as `0x${string}`;
const [usdc, eth] = await Promise.all([
  client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
  client.getBalance({ address: wallet }),
]);
console.log('USDC:', Number(usdc) / 1e6);
console.log('ETH: ', Number(eth) / 1e18);
