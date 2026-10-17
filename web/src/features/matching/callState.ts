import { useSyncExternalStore } from 'react';

let inCall = false;
const listeners = new Set<() => void>();

/** Tiny store: the video-chat screen sets it, the layout reads it to hide the chrome on phones during a call. */
export const callState = {
  set(v: boolean) {
    if (v === inCall) return;
    inCall = v;
    listeners.forEach((l) => l());
  },
};
export const useInCall = (): boolean => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => inCall);
