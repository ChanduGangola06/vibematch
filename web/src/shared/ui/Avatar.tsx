import { useState } from 'react';

interface AvatarProps {
  src?: string | undefined;
  name: string;
  className?: string;
}

/** Image with an initials fallback, so a broken or missing URL never shows a broken-image icon. */
export function Avatar({ src, name, className = 'w-10 h-10' }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
  if (!src || failed) {
    return (
      <span aria-label={name} role="img" className={`${className} rounded-full bg-gradient-to-br from-emerald-700 to-emerald-900 text-white font-bold flex items-center justify-center shrink-0 select-none`}>
        {initials}
      </span>
    );
  }
  return <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} className={`${className} rounded-full object-cover shrink-0 bg-gray-800`} />;
}
