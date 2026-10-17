import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI crashed', error, info.componentStack); }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center bg-[#0d0e12]">
        <h1 className="text-2xl font-black text-white">Something went wrong</h1>
        <p className="text-gray-400 max-w-md">The page hit an unexpected error. Reloading usually fixes it.</p>
        <button onClick={() => location.reload()} className="px-5 py-3 rounded-xl bg-[#00E676] text-black font-bold">Reload</button>
      </div>
    );
  }
}
