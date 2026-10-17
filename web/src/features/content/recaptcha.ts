declare global {
  interface Window {
    grecaptcha?: {
      ready(cb: () => void): void;
      execute(siteKey: string, o: { action: string }): Promise<string>;
      render(el: HTMLElement, o: { sitekey: string; callback(t: string): void; 'expired-callback'(): void }): number;
    };
  }
}

let loading: Promise<void> | null = null;
/** Loads Google's script once. v3 needs the site key in the URL; v2 uses explicit rendering. */
export function loadRecaptcha(siteKey: string, version: 'v2' | 'v3'): Promise<void> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = version === 'v3' ? `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}` : 'https://www.google.com/recaptcha/api.js?render=explicit';
    s.async = true;
    s.onload = () => window.grecaptcha?.ready(resolve);
    s.onerror = () => { loading = null; reject(new Error('Could not load reCAPTCHA')); };
    document.head.appendChild(s);
  });
  return loading;
}
