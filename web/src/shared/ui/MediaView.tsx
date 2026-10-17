import { useEffect, useRef, type VideoHTMLAttributes } from 'react';

/** <video> bound to a MediaStream (React can't set `srcObject` declaratively). */
export function MediaView({ stream, ...props }: { stream: MediaStream | null } & VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline {...props} />;
}
