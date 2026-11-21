import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import hookAbi from "../abi/OorkaHook.json";
import erc20Abi from "../abi/MockERC20.json";
import swapAbi from "../abi/PoolSwapTest.json";

export const HOOK_ABI = hookAbi as Abi;
export const ERC20_ABI = erc20Abi as Abi;
export const SWAP_ABI = swapAbi as Abi;

export const RPC_URL = (import.meta as any).env?.VITE_RPC_URL ?? "http://127.0.0.1:8545";

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
};

// ---------------------------------------------------------------- actors
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
export function accountOf(slot: number) {
  let a = accounts.get(slot);
  if (!a) {
    a = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: slot });
    accounts.set(slot, a);
  }
  return a;
}
export const addressOf = (slot: number): Address => accountOf(slot).address;

// ---------------------------------------------------------------- clients
const transport = http(RPC_URL);
export const publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 500 });
export const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });

const wallets = new Map<number, ReturnType<typeof createWalletClient>>();
function walletOf(slot: number) {
  let w = wallets.get(slot);
  if (!w) {
    w = createWalletClient({ account: accountOf(slot), chain: foundry, transport });
    wallets.set(slot, w);
  }
  return w;
}

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/** Simulate (for a readable revert reason), send, and wait for the receipt. */
export async function send(slot: number, call: Call) {
  const account = accountOf(slot);
  const { request } = await publicClient.simulateContract({ ...call, account } as any);
  const hash = await walletOf(slot).writeContract(request as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted (${call.functionName}).`);
  return receipt;
}

// ---------------------------------------------------------------- deployments
export async function loadDeployments(): Promise<Deployments> {
  let res: Response;
  try {
    res = await fetch(`/deployments.json?t=${Date.now()}`);
  } catch {
    throw new Error("Could not load deployments.json.");
  }
  if (!res.ok) throw new Error("No deployments.json found. The contracts have not been deployed yet.");
  const d = await res.json();
  for (const k of ["hook", "token0", "token1", "swapRouter"]) {
    if (!d[k]) throw new Error(`deployments.json is missing "${k}".`);
  }
  const code = await publicClient.getCode({ address: d.hook }).catch(() => {
    throw new Error(`Can't reach the local chain at ${RPC_URL}. Is anvil running?`);
  });
  if (!code || code === "0x") throw new Error("The hook isn't deployed on this chain. Was anvil restarted? Run the demo again.");
  return { ...d, fee: Number(d.fee), tickSpacing: Number(d.tickSpacing), chainId: Number(d.chainId) };
}

// ---------------------------------------------------------------- errors
const FRIENDLY: Record<string, string> = {
  EpochNotOver: "The epoch isn't over yet. Skip to the epoch end first.",
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
};

export function readableError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name) return FRIENDLY[name] ?? name;
    if (/fetch|ECONNREFUSED|HTTP request failed/i.test(err.message)) return `Can't reach the local chain at ${RPC_URL}.`;
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
