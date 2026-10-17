export function Spinner({ className = 'w-5 h-5', label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex">
      <svg className={`animate-spin text-[#00E676] ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.2" />
        <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function PageSpinner() {
  return (
    <div className="flex-1 min-h-[40vh] flex items-center justify-center">
      <Spinner className="w-8 h-8" />
    </div>
  );
}
