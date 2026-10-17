import type { FC } from 'react';



interface GemIconProps {
  className?: string;
  size?: number;
}

export const GemIcon: FC<GemIconProps> = ({ 
  className = "w-4 h-4", 
  size 
}) => {
  const style = size ? { width: size, height: size } : undefined;

  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block drop-shadow-[0_0_8px_rgba(6,182,212,0.6)] ${className}`}
      style={style}
    >
      <defs>
        <linearGradient id="ff-top-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E0F2FE" />
          <stop offset="50%" stopColor="#7DD3FC" />
          <stop offset="100%" stopColor="#38BDF8" />
        </linearGradient>
        <linearGradient id="ff-center-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
        <linearGradient id="ff-left-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#BAE6FD" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
        <linearGradient id="ff-right-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0284C7" />
          <stop offset="100%" stopColor="#075985" />
        </linearGradient>
        <linearGradient id="ff-bottom-l-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0284C7" />
          <stop offset="100%" stopColor="#0C4A6E" />
        </linearGradient>
        <linearGradient id="ff-bottom-r-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0369A1" />
          <stop offset="100%" stopColor="#082F49" />
        </linearGradient>
        <linearGradient id="ff-shine" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {/* Free Fire Diamond Polygonal Geometry */}
      {/* Top Table */}
      <polygon points="28,14 72,14 88,38 12,38" fill="url(#ff-top-grad)" stroke="#38BDF8" strokeWidth="0.5" />
      
      {/* Upper-Left Facet */}
      <polygon points="12,38 28,14 50,38" fill="url(#ff-left-grad)" stroke="#38BDF8" strokeWidth="0.5" />

      {/* Upper-Right Facet */}
      <polygon points="72,14 88,38 50,38" fill="url(#ff-right-grad)" stroke="#38BDF8" strokeWidth="0.5" />

      {/* Center Facet */}
      <polygon points="28,14 72,14 50,38" fill="url(#ff-center-grad)" stroke="#7DD3FC" strokeWidth="0.5" />

      {/* Lower Center Facet */}
      <polygon points="12,38 50,38 50,88" fill="url(#ff-bottom-l-grad)" stroke="#0284C7" strokeWidth="0.5" />
      <polygon points="88,38 50,38 50,88" fill="url(#ff-bottom-r-grad)" stroke="#0369A1" strokeWidth="0.5" />

      {/* Glossy High-Light Shine */}
      <polygon points="30,16 46,16 38,36 18,36" fill="url(#ff-shine)" />
      
      {/* Sparkle star */}
      <path 
        d="M26,22 Q26,26 22,26 Q26,26 26,30 Q26,26 30,26 Q26,26 26,22 Z" 
        fill="#FFFFFF" 
      />
    </svg>
  );
};
