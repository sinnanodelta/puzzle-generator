// A drop-down menu: a button that opens a panel below it. The panel stays open while it is used
// (to move a piece several times, for example) and closes on a click outside or Escape. It is
// placed in the page body, so a toolbar that scrolls sideways does not clip it.
import { type ReactNode, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

export function Menu({ label, title, className = '', children }: { label: ReactNode; title?: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const layout = () => {
      const b = button.current!.getBoundingClientRect();
      const width = panel.current?.offsetWidth ?? 0;
      setPlace({ left: Math.max(8, Math.min(b.left, window.innerWidth - width - 8)), top: b.bottom + 4 });
    };
    layout();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', layout);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', layout);
    };
  }, [open]);

  return (
    <>
      <button ref={button} className={`menu-button ${open ? 'on' : ''} ${className}`} title={title} onClick={() => setOpen(!open)}>
        {label}
        <span className="caret">▾</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="menu-panel"
            style={place ? { left: place.left, top: place.top, maxHeight: `calc(100dvh - ${place.top + 8}px)` } : { visibility: 'hidden' }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

const NARROW = '(max-width: 820px)';

/** Whether the screen is narrow (the mobile layout of SPEC §9.2). */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(NARROW);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW).matches,
  );
}
