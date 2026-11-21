import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Abi,
  type Address,
  type Chain,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import hookAbi from "../abi/OorkaHook.json";
import erc20Abi from "../abi/MockERC20.json";
import swapAbi from "../abi/PoolSwapTest.json";

export const HOOK_ABI = hookAbi as Abi;
export const ERC20_ABI = erc20Abi as Abi;
export const SWAP_ABI = swapAbi as Abi;

// ---------------------------------------------------------------- mode
// local:  anvil + dev keys, no wallet popups (./demo.sh)
// wallet: a public testnet (default Unichain Sepolia) with the visitor's own browser wallet; read-only until connected
const ENV = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
export const MODE: "local" | "wallet" = ENV.VITE_MODE === "wallet" ? "wallet" : "local";
export const IS_WALLET = MODE === "wallet";
export const RPC_URL = ENV.VITE_RPC_URL ?? (IS_WALLET ? "https://sepolia.unichain.org" : "http://127.0.0.1:8545");
const CHAIN_ID = Number(ENV.VITE_CHAIN_ID ?? (IS_WALLET ? 1301 : 31337));
const BASE = ENV.BASE_URL ?? "/";
const DEPLOYMENTS_URL = ENV.VITE_DEPLOYMENTS ?? `${BASE}${IS_WALLET ? `deployments.${CHAIN_ID}.json` : "deployments.json"}`;
export const EXPLORER = ENV.VITE_EXPLORER ?? (IS_WALLET ? "https://sepolia.uniscan.xyz" : "");

export const chain: Chain = IS_WALLET
  ? defineChain({
      id: CHAIN_ID,
      name: CHAIN_ID === 1301 ? "Unichain Sepolia" : `Chain ${CHAIN_ID}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
      blockExplorers: EXPLORER ? { default: { name: "Explorer", url: EXPLORER } } : undefined,
      // Multicall3 (same address on every chain that has it) lets the dashboard batch its reads into one call,
      // which keeps it under public RPC rate limits
      contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
      testnet: true,
    })
  : foundry;

export type Deployments = {
  poolManager: Address;
  swapRouter: Address;
  lpRouter: Address;
  hook: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  chainId: number;
  keeper?: Address;
  deployBlock?: number;
  reactive?: { chainId: number; contract: Address; cronTopic?: string };
};

// ---------------------------------------------------------------- actors (local mode)
// The local demo signs with anvil's well-known dev mnemonic, so there are no wallet popups.
// Slot numbers match the account indexes used by contracts/script/DeployLocal.s.sol.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export const MARKET_SLOT = 9; // background trader that "moves the market"

export const ACTORS: { slot: number; label: string }[] = [
  { slot: 4, label: "Depositor (vault LP)" },
  { slot: 5, label: "Fresh challenger A" },
  { slot: 6, label: "Fresh challenger B" },
  { slot: 7, label: "Fresh challenger C" },
  { slot: 1, label: "Passive Pam (curator)" },
  { slot: 2, label: "Tight Tony (curator)" },
  { slot: 3, label: "Mid Mia (curator)" },
];

const accounts = new Map<number, ReturnType<typeof mnemonicToAccount>>();
function accountOf(slot: number) {
  let a = accounts.get(slot);
  if (!a) {
    a = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: slot });
    accounts.set(slot, a);
  }
  return a;
}

// ---------------------------------------------------------------- clients
const transport = http(RPC_URL);
export const publicClient = createPublicClient({
  chain,
  transport,
  pollingInterval: IS_WALLET ? 2000 : 500,
  batch: IS_WALLET ? { multicall: true } : undefined,
});
/** How often the dashboard re-reads chain state. Public testnet RPCs rate-limit, anvil doesn't. */
export const REFRESH_MS = IS_WALLET ? 6000 : 2500;
export const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });

const localWallets = new Map<number, ReturnType<typeof createWalletClient>>();
function localWallet(slot: number) {
  let w = localWallets.get(slot);
  if (!w) {
    w = createWalletClient({ account: accountOf(slot), chain, transport });
    localWallets.set(slot, w);
  }
  return w;
}

// ---------------------------------------------------------------- browser wallet (wallet mode)
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
let connected: Address | null = null;
let injected: ReturnType<typeof createWalletClient> | null = null;

export const hasInjectedWallet = () => typeof window !== "undefined" && !!(window as any).ethereum;
export const connectedAddress = () => connected;

export async function connectWallet(): Promise<Address> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask or Rabby, or watch read-only.");
  injected = createWalletClient({ chain, transport: custom(eth) });
  const [addr] = await injected.requestAddresses();
  try {
    await injected.switchChain({ id: chain.id });
  } catch {
    await injected.addChain({ chain });
    await injected.switchChain({ id: chain.id });
  }
  connected = addr;
  eth.on?.("accountsChanged", (a: string[]) => {
    connected = (a?.[0] as Address) ?? null;
  });
  return addr;
}

/** In local mode: the anvil account for a slot. In wallet mode: the connected wallet (or zero address). */
export const addressOf = (slot: number): Address => (IS_WALLET ? connected ?? ZERO : accountOf(slot).address);

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/**
 * Simulate (for a readable revert reason), send, and wait for the receipt.
 * Gas gets a generous buffer: the first swap of a block also writes the hook's block-open price snapshot and
 * tick accumulator, which an estimate taken mid-block doesn't see.
 */
export async function send(slot: number, call: Call) {
  if (IS_WALLET && (!connected || !injected)) throw new Error("Connect a wallet first.");
  const account = IS_WALLET ? connected! : accountOf(slot);
  const { request } = await publicClient.simulateContract({ ...call, account } as any);
  const est = await publicClient.estimateContractGas({ ...call, account } as any);
  const gas = (est * 3n) / 2n + 120_000n;
  const wallet = IS_WALLET ? injected! : localWallet(slot);
  const hash = await wallet.writeContract({ ...(request as any), account, gas, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted (${call.functionName}).`);
  return receipt;
}

export const txUrl = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : "");
export const addressUrl = (a: string) => (EXPLORER ? `${EXPLORER}/address/${a}` : "");

// ---------------------------------------------------------------- deployments
export async function loadDeployments(): Promise<Deployments> {
  let res: Response;
  try {
    res = await fetch(`${DEPLOYMENTS_URL}?t=${Date.now()}`);
  } catch {
    throw new Error(`Could not load ${DEPLOYMENTS_URL}.`);
  }
  if (!res.ok) throw new Error(`No ${DEPLOYMENTS_URL} found. The contracts have not been deployed yet.`);
  const d = await res.json();
  for (const k of ["hook", "token0", "token1", "swapRouter"]) {
    if (!d[k]) throw new Error(`${DEPLOYMENTS_URL} is missing "${k}".`);
  }
  const code = await publicClient.getCode({ address: d.hook }).catch(() => {
    throw new Error(IS_WALLET ? `Can't reach ${RPC_URL}.` : `Can't reach the local chain at ${RPC_URL}. Is anvil running?`);
  });
  if (!code || code === "0x")
    throw new Error(IS_WALLET ? "The hook isn't deployed on this network." : "The hook isn't deployed on this chain. Was anvil restarted? Run the demo again.");
  return { ...d, fee: Number(d.fee), tickSpacing: Number(d.tickSpacing), chainId: Number(d.chainId) };
}

// ---------------------------------------------------------------- errors
const FRIENDLY: Record<string, string> = {
  EpochNotOver: IS_WALLET ? "The epoch isn't over yet." : "The epoch isn't over yet. Skip to the epoch end first.",
  PriceDeviation: "The pool price moved too far inside this block. Try again in the next block.",
  BondTooSmall: "The bond is below the minimum.",
  TooManyCurators: "The arena is full (8 curators max).",
  NotCuratorOwner: "Only the curator's owner can do that.",
  IsIncumbent: "The seat holder can't exit. Lose the seat first.",
  BadRange: "That range isn't valid for this pool.",
  Inactive: "That curator has already exited.",
  NoIncumbent: "Nobody holds the seat yet.",
  ZeroAmount: "The amount is too small.",
  Slippage: "Slippage limit hit.",
  DonationsDisabled: "Donations are disabled on this pool.",
  BenchmarkExists: "The benchmark is already set.",
};

export function readableError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name) return FRIENDLY[name] ?? name;
    if (/User rejected|denied/i.test(err.message)) return "You rejected the request in your wallet.";
    if (/fetch|ECONNREFUSED|HTTP request failed/i.test(err.message)) return `Can't reach ${RPC_URL}.`;
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
