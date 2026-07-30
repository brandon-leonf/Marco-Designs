import React, { Component, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AdminApp from "./AdminApp.jsx";
import "./styles.css";

/**
 * Hash routing keeps GitHub Pages happy: there is no server to rewrite
 * /admin to index.html, but #/admin always loads the same document.
 */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return hash.startsWith("#/admin") ? <AdminApp /> : <App />;
}

/**
 * A failed network chunk or unexpected render error must never leave clients
 * staring at an empty document. The recovery action deliberately performs a
 * full reload so Vite/production asset caches get another clean request.
 */
class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Marco Designs app render failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error-page" role="alert">
        <section className="fatal-error-card">
          <span className="eyebrow">Marco Designs</span>
          <h1>The page could not finish loading</h1>
          <p>
            Your browser may have received an outdated or incomplete application file.
            Reload the page to reconnect. No report has been submitted.
          </p>
          <div className="fatal-error-actions">
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                window.location.hash = "";
                window.location.reload();
              }}
            >
              Return to start
            </button>
          </div>
        </section>
      </main>
    );
  }
}

const rootElement = document.getElementById("root");
// Reuse the root when Vite hot-reloads this entry module in local development.
// Creating a second React root on the same node can produce an empty page.
const appRoot = window.__MARCO_REACT_ROOT__ ?? createRoot(rootElement);
window.__MARCO_REACT_ROOT__ = appRoot;

appRoot.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <Root />
    </AppErrorBoundary>
  </React.StrictMode>
);
