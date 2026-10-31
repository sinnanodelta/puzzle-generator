// Three.js geometry of voxel pieces: only the faces that touch something else, with lines along
// the creases of the shape and fainter lines between voxels.
import * as THREE from 'three';
import type { Vec3 } from '../types';

export interface PieceGeometry {
  faces: THREE.BufferGeometry;
  /** Edges where the surface bends. */
  creases: THREE.BufferGeometry;
  /** Outlines of every visible voxel face. */
  voxelEdges: THREE.BufferGeometry;
}

const key = (v: Vec3) => `${v[0]},${v[1]},${v[2]}`;

/** Voxels in the coordinates of the document; each one spans [v, v + 1]. */
export function pieceGeometry(voxels: Vec3[]): PieceGeometry {
  const filled = new Set(voxels.map(key));
  const positions: number[] = [];
  const normals: number[] = [];
  const edges = new Map<string, number[]>();
  for (const v of voxels) {
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      const c = (a + 2) % 3;
      for (const sign of [1, -1]) {
        const n: Vec3 = [0, 0, 0];
        n[a] = sign;
        if (filled.has(key([v[0] + n[0], v[1] + n[1], v[2] + n[2]]))) continue;
        // Corners counter-clockwise seen from outside: (b, c) = (0,0) (1,0) (1,1) (0,1) faces +a.
        const uv = sign > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
        const corners = uv.map(([u, w]) => {
          const p: Vec3 = [v[0], v[1], v[2]];
          if (sign > 0) p[a] += 1;
          p[b] += u;
          p[c] += w;
          return p;
        });
        for (const k of [0, 1, 2, 0, 2, 3]) {
          positions.push(...corners[k]);
          normals.push(...n);
        }
        for (let k = 0; k < 4; k++) {
          const p = corners[k];
          const q = corners[(k + 1) % 4];
          const id = [key(p), key(q)].sort().join('|');
          if (!edges.has(id)) edges.set(id, [...p, ...q]);
        }
      }
    }
  }
  const faces = new THREE.BufferGeometry();
  faces.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  faces.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const voxelEdges = new THREE.BufferGeometry();
  voxelEdges.setAttribute('position', new THREE.Float32BufferAttribute([...edges.values()].flat(), 3));
  return { faces, creases: new THREE.EdgesGeometry(faces, 1), voxelEdges };
}

export function disposeGeometry(g: PieceGeometry): void {
  g.faces.dispose();
  g.creases.dispose();
  g.voxelEdges.dispose();
}

/**
 * Lines of the cell grid on the floor and along the edges of the box, except the three edges
 * through the origin (`gridAxisGeometry`).
 */
export function gridBoxGeometry(grid: Vec3): THREE.BufferGeometry {
  const [gx, gy, gz] = grid;
  const p: number[] = [];
  for (let x = 1; x <= gx; x++) p.push(x, 0, 0, x, gy, 0);
  for (let y = 1; y <= gy; y++) p.push(0, y, 0, gx, y, 0);
  for (const [x, y] of [[gx, 0], [0, gy], [gx, gy]]) p.push(x, y, 0, x, y, gz);
  p.push(0, 0, gz, gx, 0, gz, gx, 0, gz, gx, gy, gz, gx, gy, gz, 0, gy, gz, 0, gy, gz, 0, 0, gz);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

/** The edge of the grid box from the origin along an axis. */
export function gridAxisGeometry(grid: Vec3, axis: number): THREE.BufferGeometry {
  const end = [0, 0, 0];
  end[axis] = grid[axis];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, ...end], 3));
  return g;
}
