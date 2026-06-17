import React from "react";

type ErrorBoundaryState = {
  errorMessage: string | null;
};

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorMessage: null
  };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      errorMessage: error instanceof Error ? error.message : "Unknown dashboard error"
    };
  }

  componentDidCatch(error: unknown) {
    console.error("[dashboard] render failed", error);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <main className="dashboard-stage">
          <section className="dashboard-error">
            <p className="dash-kicker">DASHBOARD ERROR</p>
            <h1>Render Failed</h1>
            <p>{this.state.errorMessage}</p>
            <p>Reload the page with Ctrl + F5. If it continues, open /settings and restart telemetry.</p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
