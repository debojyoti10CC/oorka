import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App, { type View } from "./App";
import Swap from "./Swap";
import { WalletButton } from "./lib/wallet";
import { NavMenu, type MenuGroup } from "./NavMenu";
import Landing from "./Landing";
import Docs from "./Docs";
import "./styles.css";

import { REPO_URL } from "./lib/site";

// Hash routes, so the site works on any static host (GitHub Pages included) with no server rewrites.
type Route = "home" | "swap" | "arena" | "vault" | "curate" | "docs";
const ROUTES: Route[] = ["swap", "arena", "vault", "curate", "docs"];
const routeOf = (hash: string): Route => ROUTES.find((r) => hash.startsWith(`#/${r}`)) ?? "home";
const LABEL: Record<Route, string> = { home: "Home", swap: "Swap", arena: "Arena", vault: "Vault", curate: "Curate", docs: "Docs" };

const PRODUCT: MenuGroup[] = [
  {
    label: "Use it",
    items: [
      { title: "Swap", desc: "Trade USDC and WETH with an exact on-chain quote.", href: "#/swap", tone: "violet", art: "swap" },
      { title: "Vault", desc: "Deposit once. The winning curator manages it.", href: "#/vault", tone: "blue", art: "vault" },
    ],
  },
  {
    label: "Compete",
    items: [
      { title: "Arena", desc: "Every range scored live. Watch the seat change hands.", href: "#/arena", tone: "coral", art: "arena" },
      { title: "Curate", desc: "Declare a range, post a bond, challenge for the seat.", href: "#/curate", tone: "green", art: "curate" },
    ],
  },
];

const RESOURCES: MenuGroup[] = [
  {
    items: [
      { title: "Documentation", desc: "Full docs: mechanism, contracts, keeper, diagrams.", href: "https://oorkadocs.djyo.tech", external: true, tone: "lilac", art: "docs" },
      {
        title: "Whitepaper",
        desc: "The full design, proofs and limits, in LaTeX.",
        href: `${REPO_URL}/blob/main/whitepaper/oorka-whitepaper.pdf`,
        external: true,
        tone: "amber",
        art: "paper",
      },
      { title: "Source code", desc: "Hook, Reactive keeper, tests and this site.", href: REPO_URL, external: true, tone: "violet", art: "code" },
      {
        title: "Live contracts",
        desc: "Unichain Sepolia and Reactive Lasna addresses.",
        href: `${REPO_URL}#live-deployment-unichain-sepolia--reactive-lasna`,
        external: true,
        tone: "green",
        art: "chain",
      },
    ],
  },
];

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
      <nav className={`nav${route === "home" ? " over" : ""}`} aria-label="Main">
        <div className="nav-inner">
          <a className="brand-link" href="#/">
            <span className="brand-mark" aria-hidden />
            Oorka
          </a>
          <div className="nav-links">
            <NavMenu label="Product" groups={PRODUCT} active={["swap", "arena", "vault", "curate"].includes(route)} />
            <NavMenu label="Resources" groups={RESOURCES} active={route === "docs"} />
            <a href="#/arena" className="nav-direct" aria-current={route === "arena" ? "page" : undefined}>
              Arena
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
          <span>Oorka · The curator seat, earned on-chain</span>
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
