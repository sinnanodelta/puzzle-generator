// The 3D canvas shared by the editor and the viewer: orbit controls, lights, and a frame where the
// puzzle z axis points up (SPEC §7.1) until the view is turned by quarter turns. Children are in
// puzzle coordinates. Frames are drawn on demand (prop changes, camera moves) so an idle view leaves
// the CPU to the workers.
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, type Ref, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { isUpright, turnView, UPRIGHT } from '../actions';
import { disposeGeometry, pieceGeometry } from '../core/geometry';
import { setState, useStore } from '../store';
import type { Vec3 } from '../types';

export const noRaycast = () => null;

/** The colours of the puzzle axes X, Y and Z. */
export const AXIS_COLORS = ['#ff6b6b', '#4cc38a', '#7aa2ff'];

/** Orbit controls aimed at the origin; the camera backs off to fit `size` when it changes. */
function Controls({ size }: { size: number }) {
  const camera = useThree((s) => s.camera);
  const dom = useThree((s) => s.gl.domElement);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const c = new OrbitControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.2;
    // Damping keeps changing the camera after a drag, and each change asks for the next frame.
    const redraw = () => invalidate();
    c.addEventListener('change', redraw);
    controls.current = c;
    return () => {
      c.removeEventListener('change', redraw);
      c.dispose();
      controls.current = null;
    };
  }, [camera, dom, invalidate]);
  useEffect(() => {
    const d = Math.max(size, 2) * 1.7;
    camera.position.set(d * 0.75, d * 0.7, d);
    camera.lookAt(0, 0, 0);
    controls.current?.target.set(0, 0, 0);
    invalidate();
  }, [camera, size, invalidate]);
  useFrame(() => controls.current?.update());
  return null;
}

/** Buttons that turn the view a quarter turn about a puzzle axis, and back upright. */
function TurnButtons() {
  const upright = useStore((s) => isUpright(s.orientation));
  return (
    <div className="view-turn">
      {(['X', 'Y', 'Z'] as const).map((name, k) => (
        <button key={name} title={`Turn the view a quarter turn about the ${name} axis of the puzzle`} onClick={() => turnView(k as 0 | 1 | 2)}>
          ↺ <span style={{ color: AXIS_COLORS[k] }}>{name}</span>
        </button>
      ))}
      <button disabled={upright} title="Back to Z up" onClick={() => setState({ orientation: UPRIGHT })}>
        Reset
      </button>
    </div>
  );
}

export function Viewport({
  size,
  center,
  groupRef,
  children,
}: {
  /** The largest extent to fit in view. */
  size: number;
  /** The point of the puzzle frame at the centre of the view. */
  center: Vec3;
  groupRef?: Ref<THREE.Group>;
  children: ReactNode;
}) {
  const orientation = useStore((s) => s.orientation);
  const quaternion = useMemo(() => {
    const r = orientation;
    const m = new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [orientation]);
  return (
    <div className="viewport" onContextMenu={(e) => e.preventDefault()}>
      <Canvas frameloop="demand" camera={{ fov: 40, near: 0.1, far: 2000 }} dpr={[1, 2]}>
        <color attach="background" args={['#1b1e24']} />
        <hemisphereLight args={['#ffffff', '#445566', 1.2]} />
        <directionalLight position={[6, 12, 8]} intensity={1.8} />
        <directionalLight position={[-8, -3, -6]} intensity={0.5} />
        <Controls size={size} />
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <group quaternion={quaternion}>
            <group ref={groupRef} position={[-center[0], -center[1], -center[2]]}>
              {children}
            </group>
          </group>
        </group>
      </Canvas>
      <TurnButtons />
    </div>
  );
}

export interface PieceMeshProps {
  voxels: Vec3[];
  color: string;
  opacity?: number;
  emissive?: string;
  position?: Vec3;
  /** Called on a click (not a drag); `erase` for the right button or Alt. */
  onPick?: (e: ThreeEvent<MouseEvent>, erase: boolean) => void;
  /** Called as the pointer moves over the piece, and with null when it leaves. */
  onHover?: (e: ThreeEvent<PointerEvent> | null) => void;
}

/** A piece as a solid with its creases, in the coordinates of its voxels. */
export function PieceMesh({ voxels, color, opacity = 1, emissive = '#000000', position, onPick, onHover }: PieceMeshProps) {
  const key = voxels.map((v) => v.join(',')).join(';');
  // The key stands for the voxels, whose array is new on every render.
  const g = useMemo(() => pieceGeometry(voxels), [key]);
  useEffect(() => () => disposeGeometry(g), [g]);
  if (voxels.length === 0) return null;
  const transparent = opacity < 1;
  const pick = (erase: boolean) => (e: ThreeEvent<MouseEvent>) => {
    if (!onPick || e.delta > 4) return;
    e.stopPropagation();
    onPick(e, erase || e.nativeEvent.altKey);
  };
  return (
    <group position={position}>
      <mesh
        geometry={g.faces}
        raycast={onPick ? THREE.Mesh.prototype.raycast : noRaycast}
        onClick={pick(false)}
        onContextMenu={pick(true)}
        onPointerMove={
          onHover &&
          ((e) => {
            e.stopPropagation();
            onHover(e);
          })
        }
        onPointerOut={onHover && (() => onHover(null))}
      >
        {/* Three.js compiles `transparent` into the shader, so a change needs a new material. */}
        <meshStandardMaterial
          key={transparent ? 'transparent' : 'opaque'}
          color={color}
          emissive={emissive}
          transparent={transparent}
          opacity={opacity}
          depthWrite={!transparent}
          roughness={0.7}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <lineSegments geometry={g.creases} raycast={noRaycast}>
        <lineBasicMaterial color="#000000" transparent opacity={0.6 * opacity} />
      </lineSegments>
      {!transparent && (
        <lineSegments geometry={g.voxelEdges} raycast={noRaycast}>
          <lineBasicMaterial color="#000000" transparent opacity={0.13} />
        </lineSegments>
      )}
    </group>
  );
}

/** Small cubes centred in cells (optional voxels, target cells). */
export function Markers({
  cells,
  size,
  color,
  opacity,
  onPick,
  onHover,
}: {
  cells: Vec3[];
  size: number;
  color: string;
  opacity: number;
  onPick?: (cell: Vec3, erase: boolean) => void;
  /** Called as the pointer moves over a cell, and with null when it leaves. */
  onHover?: (cell: Vec3 | null, e: ThreeEvent<PointerEvent> | null) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const matrix = new THREE.Matrix4();
    cells.forEach((v, i) => m.setMatrixAt(i, matrix.makeTranslation(v[0] + 0.5, v[1] + 0.5, v[2] + 0.5)));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [cells, invalidate]);
  if (cells.length === 0) return null;
  const pick = (erase: boolean) => (e: ThreeEvent<MouseEvent>) => {
    if (!onPick || e.delta > 4 || e.instanceId === undefined) return;
    e.stopPropagation();
    onPick(cells[e.instanceId], erase || e.nativeEvent.altKey);
  };
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, cells.length]}
      raycast={onPick ? THREE.InstancedMesh.prototype.raycast : noRaycast}
      onClick={pick(false)}
      onContextMenu={pick(true)}
      onPointerMove={
        onHover &&
        ((e) => {
          e.stopPropagation();
          onHover(e.instanceId === undefined ? null : cells[e.instanceId], e);
        })
      }
      onPointerOut={onHover && (() => onHover(null, null))}
    >
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </instancedMesh>
  );
}

/** Lines in puzzle coordinates (geometry owned by the caller). */
export function Lines({ geometry, color, opacity = 1, onTop = false }: {
  geometry: THREE.BufferGeometry;
  color: string;
  opacity?: number;
  onTop?: boolean;
}) {
  return (
    <lineSegments geometry={geometry} raycast={noRaycast} renderOrder={onTop ? 10 : 0}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthTest={!onTop} />
    </lineSegments>
  );
}
