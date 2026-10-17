import type { ReactNode } from 'react';

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-16 px-6">
      {icon && <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center text-gray-500" aria-hidden="true">{icon}</div>}
      <h3 className="text-lg font-bold text-white">{title}</h3>
      {text && <p className="text-sm text-gray-400 max-w-sm">{text}</p>}
      {action}
    </div>
  );
}
