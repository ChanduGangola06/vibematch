import { useId, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string;
}

export function FormField({ label, error, hint, className = '', ...input }: Props) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-bold text-gray-400 uppercase tracking-wider">{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full bg-gray-900 text-white rounded-xl px-4 py-3 border outline-none transition-colors ${error ? 'border-red-500' : 'border-gray-800 focus:border-[#00E676]'} ${className}`}
        {...input}
      />
      {error ? <p id={`${id}-err`} role="alert" className="text-xs text-red-400">{error}</p> : hint ? <p id={`${id}-hint`} className="text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}
