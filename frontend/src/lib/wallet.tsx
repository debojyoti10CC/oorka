import { useState, useSyncExternalStore } from "react";
import { IS_WALLET, addressUrl, chain, connectWallet, connectedAddress, hasInjectedWallet, readableError, subscribeWallet } from "./chain";

/** The connected wallet address (wallet mode), or null. Re-renders on connect and account switches. */
export const useWallet = () => useSyncExternalStore(subscribeWallet, connectedAddress, () => null);

/** Nav control: connect button in wallet mode, a network tag in local mode. */
export function WalletButton() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!IS_WALLET) return <span className="net-tag">Local · anvil</span>;
  if (wallet)
    return (
      <a className="btn wallet" href={addressUrl(wallet)} target="_blank" rel="noreferrer" title={`Connected to ${chain.name}`}>
        <span className="pulse" aria-hidden />
        <span className="mono">
          {wallet.slice(0, 6)}…{wallet.slice(-4)}
        </span>
      </a>
    );
  const can = hasInjectedWallet();
  return (
    <button
      className="primary wallet"
      aria-busy={busy}
      disabled={!can}
      title={err ?? (can ? `Connect to ${chain.name}` : "No browser wallet found. Everything is still readable.")}
      onClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await connectWallet();
        } catch (e) {
          setErr(readableError(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {can ? "Connect wallet" : "Read-only"}
    </button>
  );
}
