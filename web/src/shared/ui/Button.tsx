import type { ButtonHTMLAttributes } from 'react';
import { Spinner } from './Spinner';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
}

const VARIANTS = {
  primary: 'bg-[#00E676] text-black hover:bg-[#00c853] font-bold',
  secondary: 'bg-white/10 text-white hover:bg-white/20 font-semibold',
  danger: 'bg-red-500 text-white hover:bg-red-600 font-bold',
  ghost: 'text-gray-300 hover:text-white hover:bg-white/10 font-semibold',
} as const;

export function Button({ variant = 'primary', loading, disabled, children, className = '', type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner className="w-4 h-4" label="Working" />}
      {children}
    </button>
  );
}
