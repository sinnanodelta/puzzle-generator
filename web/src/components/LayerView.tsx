// The layer view (SPEC §7.2): one layer of the grid on a 2D canvas, painted with the current tool.
// The left button paints, the right button or Alt erases; the wheel changes the layer. The layer
// below shows faintly, like onion skin, and the hover preview fills the cell a click would add.
import { useEffect, useReducer, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { applyTool, pieceMode, sameCell, select, setAxis, setHoverCell, setSlice } from '../actions';
import { cellCoords, cellIndex } from '../core/doc';
import { boxCells, lineCells } from '../core/edit';
import { beginStroke, endStroke, getState, useStore } from '../store';
import type { Vec3 } from '../types';
import { usePreview } from './usePreview';

/** The axes across and up the canvas for each axis of the layers. */
const PLANES: Record<0 | 1 | 2, [number, number]> = { 0: [1, 2], 1: [0, 2], 2: [0, 1] };
const AXIS_NAMES = ['X', 'Y', 'Z'];

interface Drag {
  start: Vec3;
  end: Vec3;
  erase: boolean;
}

interface Stroke {
  last: Vec3;
  /** Cells painted by this stroke, so that the brush toggles each one once. */
  done: Set<number>;
  erase: boolean;
}

const clampTo = (n: number, size: number) => Math.max(0, Math.min(size - 1, n));

export function LayerView() {
  const doc = useStore((s) => s.doc);
  const axis = useStore((s) => s.axis);
  const slice = useStore((s) => s.slice);
  const viewModes = useStore((s) => s.viewModes);
  const isolate = useStore((s) => s.isolate);
  const tool = useStore((s) => s.tool);
  const showTarget = useStore((s) => s.showTarget);
  const selection = useStore((s) => s.selection);
  const hideOptional = useStore((s) => s.hideOptional);
  const preview = usePreview();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 400, h: 400 });
  const [tick, redraw] = useReducer((n: number) => n + 1, 0);
  const hover = useRef<Vec3 | null>(null);
  const drag = useRef<Drag | null>(null);
  const stroke = useRef<Stroke | null>(null);

  const grid = doc.grid;
  const [pu, pv] = PLANES[axis];
  const gu = grid[pu];
  const gv = grid[pv];
  const cs = Math.max(6, Math.min(48, Math.floor(Math.min((area.w - 2) / gu, (area.h - 2) / gv))));
  const width = cs * gu;
  const height = cs * gv;

  const toCell = (u: number, v: number): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    c[axis] = slice;
    c[pu] = u;
    c[pv] = v;
    return c;
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setArea({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => setHoverCell(null), []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setSlice(getState().slice + (e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = (u: number) => u * cs;
    const py = (v: number) => (gv - 1 - v) * cs;
    const modes = doc.pieces.map((p) => pieceMode({ viewModes, isolate }, p));
    const target = doc.target && (showTarget || tool === 'target') ? doc.target : null;

    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, 0, width, height);
    for (let v = 0; v < gv; v++) {
      for (let u = 0; u < gu; u++) {
        const cell = toCell(u, v);
        const i = cellIndex(grid, cell);
        const x = px(u);
        const y = py(v);
        const owner = doc.pieces.findIndex((p, k) => modes[k] !== 'hidden' && p.fixed.has(i));
        if (owner >= 0) {
          ctx.globalAlpha = modes[owner] === 'ghost' ? 0.3 : 1;
          ctx.fillStyle = doc.pieces[owner].color;
          ctx.fillRect(x, y, cs, cs);
        } else if (slice > 0) {
          const below = [...cell] as Vec3;
          below[axis] = slice - 1;
          const j = cellIndex(grid, below);
          const k = doc.pieces.findIndex((p, n) => modes[n] !== 'hidden' && p.fixed.has(j));
          if (k >= 0) {
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = doc.pieces[k].color;
            ctx.fillRect(x, y, cs, cs);
          }
        }
        const optional = hideOptional ? [] : doc.pieces.flatMap((p, k) => (modes[k] !== 'hidden' && p.optional.has(i) ? [k] : []));
        if (optional.length > 0) {
          const k = optional[0];
          ctx.globalAlpha = modes[k] === 'ghost' ? 0.35 : 1;
          ctx.strokeStyle = doc.pieces[k].color;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 3, y + 3, cs - 6, cs - 6);
          ctx.beginPath();
          ctx.moveTo(x + 3, y + cs - 3);
          ctx.lineTo(x + cs - 3, y + 3);
          ctx.stroke();
          if (optional.length > 1) {
            ctx.fillStyle = '#ffffff';
            ctx.font = `${Math.max(9, Math.round(cs * 0.4))}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillText('+', x + cs - 2, y + 1);
          }
        }
        ctx.globalAlpha = 1;
        if (target && (target.required.has(i) || target.variable.has(i))) {
          ctx.beginPath();
          ctx.arc(x + cs / 2, y + cs / 2, Math.max(2, cs * 0.13), 0, 2 * Math.PI);
          if (target.required.has(i)) {
            ctx.fillStyle = '#ffffff';
            ctx.fill();
          } else {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        if (selection.has(i)) {
          ctx.strokeStyle = '#ffd400';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, cs - 2, cs - 2);
        }
      }
    }

    ctx.strokeStyle = '#2c313a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let u = 0; u <= gu; u++) {
      ctx.moveTo(px(u) + 0.5, 0);
      ctx.lineTo(px(u) + 0.5, height);
    }
    for (let v = 0; v <= gv; v++) {
      ctx.moveTo(0, v * cs + 0.5);
      ctx.lineTo(width, v * cs + 0.5);
    }
    ctx.stroke();

    const ghost = preview && !drag.current && !stroke.current ? preview : null;
    if (ghost && ghost.cell[axis] === slice) {
      const x = px(ghost.cell[pu]);
      const y = py(ghost.cell[pv]);
      ctx.globalAlpha = 0.45;
      if (ghost.state === 'fixed') {
        ctx.fillStyle = ghost.color;
        ctx.fillRect(x, y, cs, cs);
      } else {
        ctx.strokeStyle = ghost.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 3, y + 3, cs - 6, cs - 6);
      }
      ctx.globalAlpha = 1;
    }

    const d = drag.current;
    if (d) {
      const cells = tool === 'line' ? lineCells(grid, d.start, d.end) : boxCells(grid, d.start, d.end);
      ctx.fillStyle = d.erase ? 'rgba(255, 80, 80, 0.3)' : tool === 'select' ? 'rgba(255, 212, 0, 0.25)' : 'rgba(255, 255, 255, 0.3)';
      for (const c of cells.map((i) => cellCoords(grid, i))) ctx.fillRect(px(c[pu]), py(c[pv]), cs, cs);
    }
    const h = hover.current;
    if (h && h[axis] === slice) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px(h[pu]) + 1, py(h[pv]) + 1, cs - 2, cs - 2);
    }
  }, [doc, axis, slice, viewModes, isolate, tool, showTarget, selection, hideOptional, preview, width, height, cs, tick]);

  const cellAt = (e: ReactPointerEvent, clamp: boolean): Vec3 | null => {
    const r = canvasRef.current!.getBoundingClientRect();
    let u = Math.floor((e.clientX - r.left) / cs);
    let v = gv - 1 - Math.floor((e.clientY - r.top) / cs);
    if (clamp) {
      u = clampTo(u, gu);
      v = clampTo(v, gv);
    } else if (u < 0 || u >= gu || v < 0 || v >= gv) return null;
    return toCell(u, v);
  };

  const paintStroke = (cells: number[]) => {
    const s = stroke.current;
    if (!s) return;
    const fresh = cells.filter((c) => !s.done.has(c));
    for (const c of fresh) s.done.add(c);
    if (fresh.length > 0) applyTool(getState().tool, fresh, s.erase);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    const c = cellAt(e, false);
    if (!c) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const erase = e.button === 2 || e.altKey;
    const t = getState().tool;
    if (t === 'box' || t === 'line' || t === 'select') {
      drag.current = { start: c, end: c, erase };
    } else {
      beginStroke();
      stroke.current = { last: c, done: new Set(), erase };
      paintStroke([cellIndex(grid, c)]);
    }
    setHoverCell(null);
    redraw();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const c = cellAt(e, drag.current !== null);
    if (sameCell(c, hover.current)) return;
    hover.current = c;
    setHoverCell(drag.current || stroke.current ? null : c);
    if (drag.current && c) drag.current.end = c;
    else if (stroke.current && c) {
      paintStroke(lineCells(grid, stroke.current.last, c));
      stroke.current.last = c;
    }
    redraw();
  };

  const finish = (e: ReactPointerEvent<HTMLCanvasElement>, apply: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (d && apply) {
      const t = getState().tool;
      if (t === 'select') {
        const single = sameCell(d.start, d.end);
        select(boxCells(grid, d.start, d.end), single ? 'toggle' : e.shiftKey ? 'add' : 'replace');
      } else {
        applyTool(t, t === 'line' ? lineCells(grid, d.start, d.end) : boxCells(grid, d.start, d.end), d.erase);
      }
    }
    if (stroke.current) {
      stroke.current = null;
      endStroke();
    }
    setHoverCell(hover.current);
    redraw();
  };

  const h = hover.current;
  let readout = '';
  if (h) {
    const i = cellIndex(grid, h);
    const parts = doc.pieces.flatMap((p) =>
      p.fixed.has(i) ? [`${p.name} fixed`] : p.optional.has(i) ? [`${p.name} optional`] : [],
    );
    if (doc.target?.required.has(i)) parts.push('target');
    if (doc.target?.variable.has(i)) parts.push('variable target');
    readout = `(${h.join(', ')})  ${parts.join(' · ') || 'empty'}`;
  }

  return (
    <div className="layer-view">
      <div className="panel-header">
        <span>Layers along</span>
        <span className="segmented">
          {([0, 1, 2] as const).map((a) => (
            <button key={a} className={a === axis ? 'on' : ''} onClick={() => setAxis(a)}>
              {AXIS_NAMES[a]}
            </button>
          ))}
        </span>
        <button onClick={() => setSlice(slice - 1)} disabled={slice === 0} title="Previous layer ([)">
          −
        </button>
        <span className="slice">
          {AXIS_NAMES[axis]} = {slice} <span className="dim">({slice + 1}/{grid[axis]})</span>
        </span>
        <button onClick={() => setSlice(slice + 1)} disabled={slice >= grid[axis] - 1} title="Next layer (])">
          +
        </button>
        <span className="dim grow-left">
          {AXIS_NAMES[pu]} → · {AXIS_NAMES[pv]} ↑
        </span>
      </div>
      <div className="layer-canvas" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, true)}
          onPointerCancel={(e) => finish(e, false)}
          onPointerLeave={() => {
            if (drag.current || stroke.current) return;
            hover.current = null;
            setHoverCell(null);
            redraw();
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="readout">{readout || ' '}</div>
    </div>
  );
}
