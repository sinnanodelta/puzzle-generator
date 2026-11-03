// Parts of the library view (SPEC §2.2): thumbnails drawn on demand, the ⋯ menu of a puzzle or a
// folder, and the folder picker of "Move…".
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type IndexEntry, isWithin, normalizeFolder, thumbnail, thumbnailNow } from '../core/library';
import type { Rating } from '../core/rating';

export function statusText(e: IndexEntry): string {
  switch (e.status) {
    case 'solved':
      return `level ${e.levelString}`;
    case 'unsolvable':
      return 'not solvable';
    case 'aborted':
      return 'solver gave up';
    case 'invalid':
      return 'invalid';
    default:
      return 'not checked';
  }
}

export function ratingTitle(r: Rating): string {
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  return `Balance of the piece sizes ${pct(r.balance)} · 3D printing without supports ${pct(r.print)}`;
}

/** A path for display: `A › B`, or the name of the root. */
export function folderLabel(path: string, root = 'Library'): string {
  return path ? path.split('/').join(' › ') : root;
}

/** The thumbnail of an entry, drawn once it scrolls into view (key it by `entry.rev`). */
export function Thumb({ entry, className = '', onClick }: { entry: IndexEntry; className?: string; onClick?: () => void }) {
  const [url, setUrl] = useState(() => thumbnailNow(entry));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (url || !ref.current) return;
    let live = true;
    const observer = new IntersectionObserver(
      (items) => {
        if (!items.some((i) => i.isIntersecting)) return;
        observer.disconnect();
        void thumbnail(entry).then((u) => live && setUrl(u));
      },
      { rootMargin: '300px' },
    );
    observer.observe(ref.current);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [entry, url]);
  return (
    <div ref={ref} className={`thumb ${className}`} onClick={onClick}>
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  );
}

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A check box: the menu stays open when it is toggled. */
  checked?: boolean;
}

/**
 * A ⋯ button with a list of actions; the list is placed in the page body, so no scrolling panel
 * clips it.
 */
export function ActionMenu({ items, title = 'More actions', label = '⋯' }: { items: MenuItem[]; title?: string; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const b = button.current!.getBoundingClientRect();
    const p = panel.current!.getBoundingClientRect();
    const below = b.bottom + 4 + p.height <= window.innerHeight - 8;
    setPlace({
      left: Math.max(8, Math.min(b.right - p.width, window.innerWidth - p.width - 8)),
      top: below ? b.bottom + 4 : Math.max(8, b.top - 4 - p.height),
    });
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', away);
    // A scroll would move the button away from the list.
    window.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        className={open ? 'more-button on' : 'more-button'}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setPlace(null);
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="action-menu" style={place ? { left: place.left, top: place.top } : { visibility: 'hidden', left: 0, top: 0 }}>
            {items.map((item) =>
              item.checked === undefined ? (
                <button
                  key={item.label}
                  className={item.danger ? 'danger' : ''}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.action();
                  }}
                >
                  {item.label}
                </button>
              ) : (
                <label key={item.label} className="check">
                  <input type="checkbox" checked={item.checked} disabled={item.disabled} onChange={item.action} />
                  {item.label}
                </label>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Picks a destination folder among `folders`. `exclude`: a folder that cannot be picked, with its
 * subfolders (a folder being moved). A new folder can be typed below the one picked.
 */
export function FolderPicker({
  title,
  folders,
  current,
  exclude,
  onPick,
  onClose,
}: {
  title: string;
  folders: string[];
  current: string;
  exclude?: string;
  onPick: (folder: string) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(current);
  const [name, setName] = useState('');
  const blocked = (path: string) => exclude !== undefined && path !== '' && isWithin(path, exclude);
  const target = normalizeFolder(name.includes('/') ? '' : `${picked}/${name}`);
  const rows: ReactNode[] = ['', ...folders].map((path) => {
    const depth = path ? path.split('/').length : 0;
    return (
      <button
        key={path || '/'}
        className={picked === path ? 'on' : ''}
        disabled={blocked(path)}
        style={{ paddingLeft: 8 + 16 * depth }}
        onClick={() => setPicked(path)}
      >
        {path ? `📁 ${path.slice(path.lastIndexOf('/') + 1)}` : '📚 Library'}
      </button>
    );
  });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="folder-tree">{rows}</div>
        <div className="field">
          <span>New folder in it</span>
          <input value={name} placeholder="optional" onChange={(e) => setName(e.target.value)} />
        </div>
        {name.includes('/') && <p className="warn small">A folder name cannot contain “/”.</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={name.includes('/') || blocked(target)} onClick={() => onPick(name.trim() ? target : picked)}>
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}
