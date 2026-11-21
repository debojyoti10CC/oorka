import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App, { type View } from "./App";
import Swap from "./Swap";
import { WalletButton } from "./lib/wallet";
import Landing from "./Landing";
import Docs from "./Docs";
import "./styles.css";

import { REPO_URL } from "./lib/site";

// Hash routes, so the site works on any static host (GitHub Pages included) with no server rewrites.
type Route = "home" | "swap" | "arena" | "vault" | "curate" | "docs";
const ROUTES: Route[] = ["swap", "arena", "vault", "curate", "docs"];
const routeOf = (hash: string): Route => ROUTES.find((r) => hash.startsWith(`#/${r}`)) ?? "home";
const LABEL: Record<Route, string> = { home: "Home", swap: "Swap", arena: "Arena", vault: "Vault", curate: "Curate", docs: "Docs" };

function Shell() {
  const [route, setRoute] = useState<Route>(routeOf(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(routeOf(window.location.hash));
      // in-page anchors (#/docs#fee) are handled by Docs; plain route changes start at the top
      if (!window.location.hash.includes("#", 1)) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.title = route === "home" ? "Oorka: the curator seat, earned on-chain" : `${LABEL[route]} · Oorka`;
  }, [route]);

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        Skip to content
      </a>
      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <a className="brand-link" href="#/">
            <span className="brand-mark" aria-hidden />
            Oorka
          </a>
          <div className="nav-links">
            {ROUTES.map((r) => (
              <a key={r} href={`#/${r}`} aria-current={route === r ? "page" : undefined}>
                {LABEL[r]}
              </a>
            ))}
            <a className="ext" href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
          <WalletButton />
        </div>
      </nav>
      <div id="main" tabIndex={-1} style={{ outline: "none" }}>
        {route === "home" ? (
          <Landing />
        ) : route === "docs" ? (
          <Docs />
        ) : route === "swap" ? (
          <Swap />
        ) : (
          <App key={route} view={route as View} />
        )}
      </div>
      <footer className="site-foot">
        <div className="site-foot-inner">
          <span>Oorka · UHI11 Hookathon · Active Management &amp; Curated Liquidity</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source
          </a>
          <a href="#/docs">How it works</a>
          <span>Built on Uniswap v4, Unichain and Reactive Network</span>
        </div>
      </footer>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
