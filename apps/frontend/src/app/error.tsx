"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="landing" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <div style={{ textAlign: "center" }}>
        <h2 className="title" style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Something went wrong</h2>
        <button onClick={reset} className="cta cta-ready" style={{ marginTop: "0.5rem" }}>
          Try again
        </button>
      </div>
    </div>
  );
}
