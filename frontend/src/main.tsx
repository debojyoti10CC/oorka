import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Landing from "./Landing";
import Docs from "./Docs";
import "./styles.css";

import { REPO_URL } from "./lib/site";

// Hash routes, so the site works on any static host (GitHub Pages included) with no server rewrites.
type Route = "home" | "arena" | "docs";
const routeOf = (hash: string): Route => (hash.startsWith("#/arena") ? "arena" : hash.startsWith("#/docs") ? "docs" : "home");

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
    document.title =
      route === "arena" ? "Arena · Oorka" : route === "docs" ? "Docs · Oorka" : "Oorka: the curator seat, earned on-chain";
  }, [route]);

  return (
    <>
      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <a className="brand-link" href="#/">
            <span className="brand-mark" aria-hidden />
            Oorka
          </a>
          <div className="nav-links">
            <a href="#/arena" className={route === "arena" ? "active" : ""}>
              Arena
            </a>
            <a href="#/docs" className={route === "docs" ? "active" : ""}>
              Docs
            </a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>
      </nav>
      {route === "arena" ? <App /> : route === "docs" ? <Docs /> : <Landing />}
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
