import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** Visually hide the title but keep it for screen readers. */
  hideTitle?: boolean;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Disable closing via backdrop/Escape (e.g. while a payment is processing). */
  locked?: boolean;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-5xl' } as const;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible dialog: role=dialog, labelled, Escape + backdrop to close, focus moved in and restored, Tab trapped, scroll locked. */
export function Modal({ open, onClose, title, hideTitle, children, size = 'md', locked }: ModalProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  // Callers pass fresh closures every render; the effect below must only run when the dialog opens/closes,
  // otherwise focus would jump back to the first field on every keystroke.
  const onCloseRef = useRef(onClose);
  const lockedRef = useRef(locked);
  useEffect(() => {
    onCloseRef.current = onClose;
    lockedRef.current = locked;
  });

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !lockedRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return e.preventDefault();
        const a = items[0]!;
        const z = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" data-testid="modal-root">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={locked ? undefined : onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative w-full ${SIZES[size]} max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-[#16181f] border border-white/10 shadow-2xl animate-fade-in-up`}
      >
        <div className={hideTitle ? 'sr-only' : 'flex items-center justify-between px-6 pt-5 pb-2'}>
          <h2 id={titleId} className="text-lg font-black text-white">{title}</h2>
          {!hideTitle && !locked && (
            <button onClick={onClose} aria-label="Close" className="p-2 -mr-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
        </div>
        {hideTitle && !locked && (
          <button onClick={onClose} aria-label="Close" className="absolute top-3 right-3 z-10 p-2 rounded-full bg-black/40 text-gray-300 hover:text-white">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>
  );
}
