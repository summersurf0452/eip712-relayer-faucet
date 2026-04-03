"use client";

import dynamic from "next/dynamic";
import { faucetChainLabel } from "@/lib/chain";

const Scene3D = dynamic(() => import("@/components/Scene3D"), { ssr: false });
const FaucetPanel = dynamic(() => import("./faucet-panel"), {
  ssr: false,
  loading: () => <FaucetPanelFallback />,
});

const FLOW = ["Typed signature", "Gasless relay", "Token delivery"] as const;

function BrandIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="url(#bg)" strokeWidth="1.5" fill="none" />
      <circle cx="12" cy="12" r="6" stroke="url(#bg)" strokeWidth="1" fill="rgba(167,139,250,0.1)" />
      <defs>
        <linearGradient id="bg" x1="2" y1="2" x2="22" y2="22">
          <stop stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function HomeClient() {
  return (
    <div className="landing">
      {/* Star field */}
      <div className="starfield" aria-hidden>
        <div className="star-layer star-layer-1" />
        <div className="star-layer star-layer-2" />
        <div className="star-layer star-layer-3" />
      </div>

      {/* Neon wave background layers */}
      <div className="neon-bg" aria-hidden>
        <div className="neon-wave neon-wave-1" />
        <div className="neon-wave neon-wave-2" />
        <div className="neon-wave neon-wave-3" />
        <div className="neon-glow" />
        <div className="neon-highlight" />
      </div>

      <header className="landing-header">
        <div className="brand">
          <BrandIcon className="brand-icon" />
          <span className="brand-name">SummerSurf Faucet</span>
          <span className="brand-sep" />
          <span className="brand-sub">Built by minji</span>
        </div>
        <span className="chain-badge">{faucetChainLabel}</span>
      </header>

      {/* 3D as background layer — overlaps but sits behind content */}
      <div className="scene3d-bg">
        <div className="scene3d-wrap">
          <div className="scene3d-canvas">
            <Scene3D />
          </div>
        </div>
      </div>

      <main className="hero">
        <div className="hero-left">
          <p className="eyebrow">EIP-712 • Gasless • Relay-powered</p>
          <h1 className="title">Claim SummerSurf tokens with a single signature</h1>
          <p className="subtitle">
            Sign one typed message and let the relay deliver SummerSurf tokens directly to your wallet — no gas required.
          </p>

          <div className="flow-row">
            {FLOW.map((f, i) => (
              <span key={f} className="flow-item">
                {f}{i < FLOW.length - 1 && <span className="flow-dot">&middot;</span>}
              </span>
            ))}
          </div>

          <div className="divider" />

          <FaucetPanel />
        </div>

      </main>

      <footer className="site-footer">
        &copy; 2026 summersurf0452(밍디). All rights reserved.
      </footer>
    </div>
  );
}

function FaucetPanelFallback() {
  return (
    <div className="actions">
      <div className="wallet-row">
        <span className="wallet-label">Wallet</span>
        <span className="caption">Loading connection...</span>
      </div>
      <button disabled className="cta cta-muted">
        Loading wallet...
      </button>
      <p className="caption">Preparing wallet connection...</p>
    </div>
  );
}
