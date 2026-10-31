// Library thumbnails: an isometric drawing of the fixed voxels, painted back to front.
import type { PuzzleDoc, Vec3 } from '../types';

const SIZE = 160;
const COS30 = Math.cos(Math.PI / 6);

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(Math.min(255, v * factor)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** The visible faces (+x, +y, +z) of every exterior voxel, as a PNG data URL. */
export function renderThumbnail(doc: PuzzleDoc): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const filled = new Set<string>();
  const voxels: { v: Vec3; color: string }[] = [];
  for (const piece of doc.pieces) {
    for (const v of piece.fixed) {
      filled.add(v.join(','));
      voxels.push({ v, color: /^#[0-9a-f]{6}$/i.test(piece.color) ? piece.color : '#999999' });
    }
  }
  if (voxels.length === 0) return canvas.toDataURL('image/png');
  const project = ([x, y, z]: Vec3): [number, number] => [(x - y) * COS30, (x + y) / 2 - z];
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { v } of voxels) {
    for (const corner of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]] as Vec3[]) {
      const [sx, sy] = project([v[0] + corner[0], v[1] + corner[1], v[2] + corner[2]]);
      [minX, minY, maxX, maxY] = [Math.min(minX, sx), Math.min(minY, sy), Math.max(maxX, sx), Math.max(maxY, sy)];
    }
  }
  const scale = (SIZE - 10) / Math.max(maxX - minX, maxY - minY);
  const ox = (SIZE - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (SIZE - (maxY - minY) * scale) / 2 - minY * scale;
  const toScreen = (p: Vec3): [number, number] => {
    const [sx, sy] = project(p);
    return [ox + sx * scale, oy + sy * scale];
  };
  // Faces as corner offsets, with their neighbour direction and shading.
  const faces: { n: Vec3; corners: Vec3[]; light: number }[] = [
    { n: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], light: 1.15 },
    { n: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], light: 0.85 },
    { n: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], light: 0.65 },
  ];
  voxels.sort((a, b) => a.v[0] + a.v[1] + a.v[2] - (b.v[0] + b.v[1] + b.v[2]));
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  for (const { v, color } of voxels) {
    for (const face of faces) {
      if (filled.has([v[0] + face.n[0], v[1] + face.n[1], v[2] + face.n[2]].join(','))) continue;
      ctx.beginPath();
      face.corners.forEach((c, k) => {
        const [sx, sy] = toScreen([v[0] + c[0], v[1] + c[1], v[2] + c[2]]);
        if (k === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = shade(color, face.light);
      ctx.fill();
      ctx.stroke();
    }
  }
  return canvas.toDataURL('image/png');
}
