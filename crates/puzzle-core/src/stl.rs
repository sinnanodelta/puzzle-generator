//! Binary STL export of pieces (SPEC.md §2.4): clearance as an exact erosion, 45° chamfer of
//! convex edges, watertight meshes with merged coplanar faces, and a zip with one STL per piece.
//!
//! Every step before triangulation is exact integer arithmetic on a lattice of [`LATTICE`] units
//! per voxel. Clearance and chamfer are rounded to multiples of 12 lattice units; every vertex is
//! the intersection of three planes with coefficients in {−1, 0, 1} whose determinant divides 12
//! times a power of two, so every vertex is a lattice point and every clip is exact.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io::Write;

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use serde::Deserialize;

use crate::model::{Document, MAX_GRID, Voxel};

/// Lattice units per voxel (SPEC §2.4): 12 · 2^20.
pub const LATTICE: i64 = 12 << 20;
/// Clearance and chamfer are multiples of this many lattice units.
const STEP: i64 = 12;
/// Largest accepted unit size in millimetres.
pub const MAX_UNIT: f64 = 1000.0;

/// STL options of SPEC §2.4, in millimetres. JSON: `{"unit": 10, "clearance": 0.1, "chamfer": 0.5}`;
/// `clearance` and `chamfer` default to 0.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StlOptions {
    /// Edge length of one voxel, in `(0, MAX_UNIT]`.
    pub unit: f64,
    /// Inward offset of every boundary face, in `[0, unit / 2)`.
    #[serde(default)]
    pub clearance: f64,
    /// Leg of the 45° chamfer on convex edges, in `[0, (unit − 2·clearance) / 2)`; 0 disables it.
    #[serde(default)]
    pub chamfer: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StlError {
    Unit(f64),
    Clearance {
        clearance: f64,
        unit: f64,
    },
    Chamfer {
        chamfer: f64,
        max: f64,
    },
    PieceIndex {
        index: usize,
        count: usize,
    },
    /// The piece (or voxel list) has no cell.
    EmptyPiece,
    /// A voxel outside `0..MAX_GRID`.
    OutOfRange(Voxel),
    /// No piece of the document has a cell.
    NoPieces,
    Zip(String),
}

impl fmt::Display for StlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unit(u) => write!(f, "unit size {u} mm must be positive and at most {MAX_UNIT} mm"),
            Self::Clearance { clearance, unit } => {
                write!(f, "clearance {clearance} mm must be at least 0 and less than half the unit size {unit} mm")
            }
            Self::Chamfer { chamfer, max } => {
                write!(f, "chamfer {chamfer} mm must be at least 0 and less than {max} mm")
            }
            Self::PieceIndex { index, count } => write!(f, "piece {index} does not exist ({count} pieces)"),
            Self::EmptyPiece => write!(f, "the piece has no cell"),
            Self::OutOfRange(v) => write!(f, "cell {v:?} is outside 0..{MAX_GRID}"),
            Self::NoPieces => write!(f, "no piece has a cell"),
            Self::Zip(e) => write!(f, "cannot write the zip: {e}"),
        }
    }
}

impl std::error::Error for StlError {}

/// Options in lattice units (clearance `c`, chamfer `r`) and the unit size in millimetres.
#[derive(Clone, Copy, Debug)]
struct Params {
    c: i64,
    r: i64,
    unit: f64,
}

impl StlOptions {
    /// Checks the options and rounds them to the lattice. Rounding never breaks `2c < 1` or
    /// `2r < 1 − 2c`: an offending value is lowered by one step.
    fn params(&self) -> Result<Params, StlError> {
        let Self { unit, clearance, chamfer } = *self;
        let unit_ok = unit.is_finite() && unit > 0.0 && unit <= MAX_UNIT;
        if !unit_ok {
            return Err(StlError::Unit(unit));
        }
        let clearance_ok = clearance.is_finite() && clearance >= 0.0 && 2.0 * clearance < unit;
        if !clearance_ok {
            return Err(StlError::Clearance { clearance, unit });
        }
        let max = (unit - 2.0 * clearance) / 2.0;
        let chamfer_ok = chamfer.is_finite() && chamfer >= 0.0 && chamfer < max;
        if !chamfer_ok {
            return Err(StlError::Chamfer { chamfer, max });
        }
        let quantise = |mm: f64| (mm / unit * (LATTICE / STEP) as f64).round() as i64 * STEP;
        let mut c = quantise(clearance);
        if 2 * c >= LATTICE {
            c -= STEP;
        }
        let mut r = quantise(chamfer);
        if 2 * r >= LATTICE - 2 * c {
            r -= STEP;
        }
        Ok(Params { c: c.max(0), r: r.max(0), unit })
    }
}

type P3 = [i64; 3];

fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: P3, b: P3) -> P3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: P3, b: P3) -> i128 {
    (0..3).map(|i| i128::from(a[i]) * i128::from(b[i])).sum()
}

fn cross128(a: P3, b: P3) -> [i128; 3] {
    let w = |x: i64| i128::from(x);
    [
        w(a[1]) * w(b[2]) - w(a[2]) * w(b[1]),
        w(a[2]) * w(b[0]) - w(a[0]) * w(b[2]),
        w(a[0]) * w(b[1]) - w(a[1]) * w(b[0]),
    ]
}

fn dot128(a: [i128; 3], n: P3) -> i128 {
    (0..3).map(|i| a[i] * i128::from(n[i])).sum()
}

fn gcd(a: i64, b: i64) -> i64 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// `v` divided by the gcd of its components; `None` for the zero vector.
fn primitive(v: P3) -> Option<P3> {
    let g = gcd(gcd(v[0], v[1]), v[2]);
    (g != 0).then(|| [v[0] / g, v[1] / g, v[2] / g])
}

/// The turn at `b` of the path `a → b → c`, measured around `normal`: positive for a left turn.
fn turn(a: P3, b: P3, c: P3, normal: P3) -> i128 {
    dot128(cross128(sub(b, a), sub(c, b)), normal)
}

/// Twice the signed area of a planar polygon, measured around `normal` (times |normal|).
fn area(poly: &[P3], normal: P3) -> i128 {
    let n = poly.len();
    poly.iter().enumerate().map(|(k, &p)| dot128(cross128(p, poly[(k + 1) % n]), normal)).sum()
}

/// `num / den` rounded to the nearest integer. The callers' divisions are exact (module doc).
fn div_round(num: i128, den: i128) -> i128 {
    debug_assert!(num % den == 0, "inexact lattice division {num} / {den}");
    let (q, r) = (num / den, num % den);
    if 2 * r.abs() >= den.abs() { q + num.signum() * den.signum() } else { q }
}

/// The half-space `n·p ≥ k`.
#[derive(Clone, Debug)]
struct Cut {
    n: P3,
    k: i128,
    /// For a chamfer cut, a polygon of its plane that covers the cut face before clipping.
    seed: Vec<P3>,
}

/// Keeps the part of a convex polygon inside `cut` (Sutherland–Hodgman, exact).
fn clip(poly: &[P3], n: P3, k: i128) -> Vec<P3> {
    let len = poly.len();
    let mut out = Vec::with_capacity(len + 1);
    for (i, &p) in poly.iter().enumerate() {
        let q = poly[(i + 1) % len];
        let (dp, dq) = (dot(n, p) - k, dot(n, q) - k);
        if dp >= 0 {
            out.push(p);
        }
        if (dp > 0 && dq < 0) || (dp < 0 && dq > 0) {
            let den = dp - dq;
            out.push(std::array::from_fn(|a| p[a] + div_round(i128::from(q[a] - p[a]) * dp, den) as i64));
        }
    }
    out
}

/// Removes repeated and collinear vertices; returns an empty polygon when nothing is left.
fn simplify(mut poly: Vec<P3>) -> Vec<P3> {
    loop {
        let n = poly.len();
        if n < 3 {
            return Vec::new();
        }
        let flat = (0..n).find(|&i| {
            let (a, b, c) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
            a == b || cross(sub(b, a), sub(c, b)) == [0; 3]
        });
        match flat {
            Some(i) => {
                poly.remove(i);
            }
            None => return poly,
        }
    }
}

/// A cell interval along one axis (SPEC §2.4): `[lo, hi]` in lattice units, touching voxels `v0..=v1`.
#[derive(Clone, Copy, Debug)]
struct Slab {
    lo: i64,
    hi: i64,
    v0: i32,
    v1: i32,
}

/// The slabs of one axis from voxel `min − 1` to `max + 1`: a joint slab `[i − c, i + c]` at each
/// voxel plane `i`, touching voxels `i − 1` and `i` (only when `c > 0`), and a centre slab
/// `[i + c, i + 1 − c]` in each voxel. Slabs `[i, i + c]` and `[i − c, i]` of SPEC §2.4 touch the
/// same voxels, so they are kept together as one joint slab.
fn slabs(min: i32, max: i32, c: i64) -> Vec<Slab> {
    let mut out = Vec::new();
    for i in min..=max + 1 {
        let p = i64::from(i) * LATTICE;
        if c > 0 {
            out.push(Slab { lo: p - c, hi: p + c, v0: i - 1, v1: i });
        }
        if i <= max {
            out.push(Slab { lo: p + c, hi: p + LATTICE - c, v0: i, v1: i });
        }
    }
    out
}

type Cell = [usize; 3];

/// The cells of the eroded piece (SPEC §2.4): a cell is kept iff every voxel its slabs touch is
/// filled. A kept joint slab implies the kept centre slabs beside it, so with `c > 0` the kept cells
/// never meet only along an edge or at a corner and the eroded solid is a manifold.
struct Cells {
    axes: [Vec<Slab>; 3],
    kept: Vec<bool>,
}

impl Cells {
    fn new(voxels: &HashSet<Voxel>, c: i64) -> Self {
        let min: [i32; 3] = std::array::from_fn(|a| voxels.iter().map(|v| v[a]).min().unwrap_or(0));
        let max: [i32; 3] = std::array::from_fn(|a| voxels.iter().map(|v| v[a]).max().unwrap_or(0));
        let axes: [Vec<Slab>; 3] = std::array::from_fn(|a| slabs(min[a], max[a], c));
        let mut cells = Self { kept: Vec::new(), axes };
        let count = cells.dims().iter().product();
        cells.kept = (0..count)
            .map(|i| {
                let cell = cells.cell(i);
                let [x, y, z]: [Slab; 3] = std::array::from_fn(|a| cells.axes[a][cell[a]]);
                (x.v0..=x.v1).all(|i| (y.v0..=y.v1).all(|j| (z.v0..=z.v1).all(|k| voxels.contains(&[i, j, k]))))
            })
            .collect();
        cells
    }

    fn dims(&self) -> [usize; 3] {
        self.axes.each_ref().map(Vec::len)
    }

    fn index(&self, cell: Cell) -> usize {
        let d = self.dims();
        (cell[0] * d[1] + cell[1]) * d[2] + cell[2]
    }

    fn cell(&self, index: usize) -> Cell {
        let d = self.dims();
        [index / (d[1] * d[2]), index / d[2] % d[1], index % d[2]]
    }

    /// The kept cell across face `(axis, sign)` of `cell`, if any.
    fn neighbour(&self, cell: Cell, axis: usize, sign: i64) -> Option<Cell> {
        let mut n = cell;
        n[axis] = if sign > 0 { n[axis] + 1 } else { n[axis].checked_sub(1)? };
        (n[axis] < self.dims()[axis] && self.kept[self.index(n)]).then_some(n)
    }

    fn bounds(&self, cell: Cell) -> (P3, P3) {
        let s: [Slab; 3] = std::array::from_fn(|a| self.axes[a][cell[a]]);
        (s.map(|s| s.lo), s.map(|s| s.hi))
    }

    /// The chamfer cuts of a kept cell (SPEC §2.4), with leg `r`:
    /// - a bevel `u + v ≥ r` on each box edge whose two face neighbours are empty, where `u` and `v`
    ///   are the distances to the two faces of the edge;
    /// - a corner cut `u + v + w ≥ 2r` at each box corner whose three face neighbours are empty.
    ///
    /// Bevels only cross centre slabs, which are wider than `2r`, so every cut stays in its cell.
    fn cuts(&self, cell: Cell, r: i64) -> Vec<Cut> {
        if r == 0 {
            return Vec::new();
        }
        let (lo, hi) = self.bounds(cell);
        let empty = |axis: usize, sign: i64| self.neighbour(cell, axis, sign).is_none();
        let face = |axis: usize, sign: i64| if sign > 0 { hi[axis] } else { lo[axis] };
        let mut cuts = Vec::new();
        for (i, j) in [(0, 1), (0, 2), (1, 2)] {
            let a = 3 - i - j;
            for (s1, s2) in [(-1, -1), (-1, 1), (1, -1), (1, 1)] {
                if !(empty(i, s1) && empty(j, s2)) {
                    continue;
                }
                let (bi, bj) = (face(i, s1), face(j, s2));
                let mut n = [0; 3];
                (n[i], n[j]) = (-s1, -s2);
                let point = |u: i64, v: i64, along: i64| {
                    let mut p = [0; 3];
                    (p[i], p[j], p[a]) = (bi - s1 * u, bj - s2 * v, along);
                    p
                };
                let seed = vec![point(r, 0, lo[a]), point(0, r, lo[a]), point(0, r, hi[a]), point(r, 0, hi[a])];
                cuts.push(Cut { n, k: i128::from(r - s1 * bi - s2 * bj), seed });
            }
        }
        for m in 0..8 {
            let s: P3 = std::array::from_fn(|a| if m >> a & 1 == 1 { 1 } else { -1 });
            if !(0..3).all(|a| empty(a, s[a])) {
                continue;
            }
            let b: P3 = std::array::from_fn(|a| face(a, s[a]));
            let seed = (0..3)
                .map(|a| {
                    let mut p = b;
                    p[a] -= s[a] * 2 * r;
                    p
                })
                .collect();
            let k = 2 * r - (0..3).map(|a| s[a] * b[a]).sum::<i64>();
            cuts.push(Cut { n: s.map(|x| -x), k: i128::from(k), seed });
        }
        cuts
    }
}

/// The face `(axis, sign)` of the box `[lo, hi]`, before cuts.
fn box_face(lo: P3, hi: P3, axis: usize, sign: i64) -> Vec<P3> {
    let (a, b) = ((axis + 1) % 3, (axis + 2) % 3);
    let x = if sign > 0 { hi[axis] } else { lo[axis] };
    [(lo[a], lo[b]), (hi[a], lo[b]), (hi[a], hi[b]), (lo[a], hi[b])]
        .map(|(u, v)| {
            let mut p = [0; 3];
            (p[axis], p[a], p[b]) = (x, u, v);
            p
        })
        .to_vec()
}

fn clip_all(mut poly: Vec<P3>, cuts: &[Cut]) -> Vec<P3> {
    for cut in cuts {
        if poly.len() < 3 {
            break;
        }
        poly = clip(&poly, cut.n, cut.k);
    }
    simplify(poly)
}

/// A planar face with its primitive outward normal, counter-clockwise seen from outside.
struct Face {
    pts: Vec<P3>,
    normal: P3,
}

/// Adds a face, oriented around `normal`, unless it has no area.
fn push_face(faces: &mut Vec<Face>, pts: Vec<P3>, normal: P3) {
    let mut pts = simplify(pts);
    let a = area(&pts, normal);
    if a != 0 {
        if a < 0 {
            pts.reverse();
        }
        faces.push(Face { pts, normal });
    }
}

/// Convex pieces covering `pa \ pb`, for convex polygons of one plane with normal `normal`: piece `k`
/// is the part of `pa` outside edge `k` of `pb` and inside its edges `0..k`.
fn difference(pa: &[P3], pb: &[P3], normal: P3) -> Vec<Vec<P3>> {
    let mut pb = pb.to_vec();
    match area(&pb, normal).signum() {
        0 => return vec![pa.to_vec()],
        -1 => pb.reverse(),
        _ => {}
    }
    let mut out = Vec::new();
    let mut rest = pa.to_vec();
    let n = pb.len();
    for (i, &p) in pb.iter().enumerate() {
        if rest.len() < 3 {
            break;
        }
        // Points inward for a counter-clockwise `pb`.
        let Some(m) = primitive(cross(normal, sub(pb[(i + 1) % n], p))) else { continue };
        let k = dot(m, p);
        out.push(clip(&rest, m.map(|x| -x), -k));
        rest = clip(&rest, m, k);
    }
    out
}

/// The boundary faces of the union of the cut cells. Where two kept cells share a box face, each
/// side emits the part of its face that the other side's face does not cover.
fn cell_faces(cells: &Cells, r: i64) -> Vec<Face> {
    let cuts: Vec<Vec<Cut>> =
        (0..cells.kept.len()).map(|i| if cells.kept[i] { cells.cuts(cells.cell(i), r) } else { Vec::new() }).collect();
    let mut out = Vec::new();
    for (i, own) in cuts.iter().enumerate().filter(|&(i, _)| cells.kept[i]) {
        let cell = cells.cell(i);
        let (lo, hi) = cells.bounds(cell);
        for axis in 0..3 {
            for sign in [-1, 1] {
                let mut normal = [0; 3];
                normal[axis] = sign;
                let Some(next) = cells.neighbour(cell, axis, sign) else {
                    push_face(&mut out, clip_all(box_face(lo, hi, axis, sign), own), normal);
                    continue;
                };
                let other = &cuts[cells.index(next)];
                if own.is_empty() && other.is_empty() {
                    continue;
                }
                let pa = clip_all(box_face(lo, hi, axis, sign), own);
                if pa.is_empty() {
                    continue;
                }
                let (next_lo, next_hi) = cells.bounds(next);
                let pb = clip_all(box_face(next_lo, next_hi, axis, -sign), other);
                for piece in difference(&pa, &pb, normal) {
                    push_face(&mut out, piece, normal);
                }
            }
        }
        for cut in own {
            push_face(&mut out, clip_all(cut.seed.clone(), own), cut.n.map(|x| -x));
        }
    }
    out
}

/// A face as vertex ids, counter-clockwise around its primitive outward normal.
struct Poly {
    ids: Vec<u32>,
    normal: P3,
}

/// Numbers the distinct vertex positions, in order of first use.
fn index_faces(faces: Vec<Face>) -> (Vec<P3>, Vec<Poly>) {
    let mut index: HashMap<P3, u32> = HashMap::new();
    let mut positions = Vec::new();
    let polys = faces
        .into_iter()
        .map(|face| {
            let ids = face
                .pts
                .iter()
                .map(|&p| {
                    *index.entry(p).or_insert_with(|| {
                        positions.push(p);
                        (positions.len() - 1) as u32
                    })
                })
                .collect();
            Poly { ids, normal: face.normal }
        })
        .collect();
    (positions, polys)
}

/// The cyclic edges of a polygon.
fn edges(ids: &[u32]) -> impl Iterator<Item = (u32, u32)> + '_ {
    ids.iter().enumerate().map(|(k, &a)| (a, ids[(k + 1) % ids.len()]))
}

/// The primitive direction of `v` whose first non-zero component is positive.
fn direction(v: P3) -> Option<P3> {
    let d = primitive(v)?;
    let first = d.iter().copied().find(|&x| x != 0).unwrap_or(0);
    Some(if first < 0 { d.map(|x| -x) } else { d })
}

/// Vertex ids by line: a line through `p` with direction `d` is identified by the index of `d` and
/// by `p × d`; its points are `(p · d, id)`, sorted.
type Lines = HashMap<(usize, [i128; 3]), Vec<(i128, u32)>>;

/// Inserts into every polygon edge the vertices that lie inside it, so that faces meet edge to
/// edge (no T-junctions) and every edge of the surface is used once in each direction.
fn conform(positions: &[P3], polys: &mut [Poly]) {
    let mut dirs: HashMap<P3, usize> = HashMap::new();
    for poly in polys.iter() {
        for (a, b) in edges(&poly.ids) {
            if let Some(d) = direction(sub(positions[b as usize], positions[a as usize])) {
                let next = dirs.len();
                dirs.entry(d).or_insert(next);
            }
        }
    }
    let mut lines: Lines = HashMap::new();
    for (&d, &di) in &dirs {
        for (id, &p) in positions.iter().enumerate() {
            lines.entry((di, cross128(p, d))).or_default().push((dot(p, d), id as u32));
        }
    }
    for line in lines.values_mut() {
        line.sort_unstable();
    }
    for poly in polys.iter_mut() {
        let mut out = Vec::with_capacity(poly.ids.len());
        for (a, b) in edges(&poly.ids) {
            out.push(a);
            let (pa, pb) = (positions[a as usize], positions[b as usize]);
            let Some(d) = direction(sub(pb, pa)) else { continue };
            let Some(line) = dirs.get(&d).and_then(|&di| lines.get(&(di, cross128(pa, d)))) else { continue };
            let (ta, tb) = (dot(pa, d), dot(pb, d));
            let start = line.partition_point(|&(t, _)| t <= ta.min(tb));
            let end = line.partition_point(|&(t, _)| t < ta.max(tb));
            let inner = line[start..end].iter().map(|&(_, id)| id);
            if ta < tb {
                out.extend(inner);
            } else {
                out.extend(inner.rev());
            }
        }
        poly.ids = out;
    }
}

/// The union of two convex faces of one plane that share one contiguous run of edges, if it is a
/// convex polygon without repeated vertices. `p` keeps its vertices from the end of the shared
/// run around to its start, then `q` adds its vertices between the start and the end of the run.
fn try_merge(p: &[u32], q: &[u32], positions: &[P3], normal: P3) -> Option<Vec<u32>> {
    let q_edges: HashSet<(u32, u32)> = edges(q).collect();
    let n = p.len();
    let shared: Vec<bool> = edges(p).map(|(a, b)| q_edges.contains(&(b, a))).collect();
    let count = shared.iter().filter(|&&s| s).count();
    if count == 0 || count == n {
        return None;
    }
    let start = (0..n).find(|&k| shared[k] && !shared[(k + n - 1) % n])?;
    if (0..count).any(|j| !shared[(start + j) % n]) {
        return None;
    }
    let (run_start, run_end) = (p[start], p[(start + count) % n]);
    let mut merged: Vec<u32> = (0..=n - count).map(|j| p[(start + count + j) % n]).collect();
    let m = q.len();
    let from = q.iter().position(|&v| v == run_start)?;
    let mut closed = false;
    for j in 1..m {
        let v = q[(from + j) % m];
        if v == run_end {
            closed = true;
            break;
        }
        merged.push(v);
    }
    let unique = merged.iter().collect::<HashSet<_>>().len() == merged.len();
    let len = merged.len();
    let convex = (0..len).all(|k| {
        let [a, b, c] = [merged[(k + len - 1) % len], merged[k], merged[(k + 1) % len]].map(|v| positions[v as usize]);
        turn(a, b, c, normal) >= 0
    });
    (closed && unique && convex).then_some(merged)
}

/// Greedily merges faces of one plane that share edges while the union stays convex.
fn merge_group(group: Vec<Vec<u32>>, positions: &[P3], normal: P3) -> Vec<Vec<u32>> {
    let mut owner: HashMap<(u32, u32), usize> = HashMap::new();
    for (i, ids) in group.iter().enumerate() {
        owner.extend(edges(ids).map(|e| (e, i)));
    }
    let mut polys: Vec<Option<Vec<u32>>> = group.into_iter().map(Some).collect();
    let mut stack: Vec<usize> = (0..polys.len()).rev().collect();
    while let Some(i) = stack.pop() {
        let Some(p) = polys[i].clone() else { continue };
        let found = edges(&p).find_map(|(a, b)| {
            let j = *owner.get(&(b, a))?;
            let q = polys[j].as_ref().filter(|_| j != i)?;
            Some((j, try_merge(&p, q, positions, normal)?))
        });
        let Some((j, merged)) = found else { continue };
        let q = polys[j].take().unwrap_or_default();
        for (e, k) in edges(&p).map(|e| (e, i)).chain(edges(&q).map(|e| (e, j))) {
            if owner.get(&e) == Some(&k) {
                owner.remove(&e);
            }
        }
        owner.extend(edges(&merged).map(|e| (e, i)));
        polys[i] = Some(merged);
        stack.push(i);
    }
    polys.into_iter().flatten().collect()
}

/// Merges coplanar faces (SPEC §2.4) into convex polygons, plane by plane.
fn merge_coplanar(positions: &[P3], polys: Vec<Poly>) -> Vec<Poly> {
    let mut planes: BTreeMap<(P3, i128), Vec<Vec<u32>>> = BTreeMap::new();
    for poly in polys {
        let offset = dot(poly.normal, positions[poly.ids[0] as usize]);
        planes.entry((poly.normal, offset)).or_default().push(poly.ids);
    }
    planes
        .into_iter()
        .flat_map(|((normal, _), group)| {
            merge_group(group, positions, normal).into_iter().map(move |ids| Poly { ids, normal })
        })
        .collect()
}

/// Removes the vertices that are a corner of no face: every face that holds such a vertex holds it
/// inside a straight edge, together with the same neighbours on both sides of the edge.
fn drop_flat_vertices(positions: &[P3], polys: &mut [Poly]) {
    let mut corner = vec![false; positions.len()];
    for poly in polys.iter() {
        let n = poly.ids.len();
        for k in 0..n {
            let [a, b, c] = [poly.ids[(k + n - 1) % n], poly.ids[k], poly.ids[(k + 1) % n]];
            if turn(positions[a as usize], positions[b as usize], positions[c as usize], poly.normal) > 0 {
                corner[b as usize] = true;
            }
        }
    }
    for poly in polys.iter_mut() {
        poly.ids.retain(|&v| corner[v as usize]);
    }
}

/// Triangulates a convex face that may hold straight-angle vertices, without new vertices: cuts
/// ears at strict corners, and fans from the last strict corner once the other vertices are
/// collinear. No diagonal passes through a vertex, so the triangles keep the edges conforming.
fn triangulate(ids: &[u32], positions: &[P3], normal: P3, out: &mut Vec<[u32; 3]>) {
    let pos = |id: u32| positions[id as usize];
    let mut v = ids.to_vec();
    while v.len() > 3 {
        let n = v.len();
        let Some(i) = (0..n).find(|&k| turn(pos(v[(k + n - 1) % n]), pos(v[k]), pos(v[(k + 1) % n]), normal) > 0)
        else {
            return;
        };
        let rest: Vec<P3> = (1..n).map(|j| pos(v[(i + j) % n])).collect();
        if area(&rest, normal) == 0 {
            out.extend((1..n - 1).map(|j| [v[i], v[(i + j) % n], v[(i + j + 1) % n]]));
            return;
        }
        out.push([v[(i + n - 1) % n], v[i], v[(i + 1) % n]]);
        v.remove(i);
    }
    if let [a, b, c] = v[..] {
        out.push([a, b, c]);
    }
}

type F3 = [f64; 3];

fn sub_f(a: F3, b: F3) -> F3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross_f(a: F3, b: F3) -> F3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot_f(a: F3, b: F3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// A triangle with the primitive outward normal of its face.
#[derive(Clone, Copy)]
struct Tri {
    v: [u32; 3],
    normal: P3,
}

fn edge_map(tris: &[Tri]) -> HashMap<(u32, u32), Vec<usize>> {
    let mut map: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (t, tri) in tris.iter().enumerate() {
        for k in 0..3 {
            map.entry((tri.v[k], tri.v[(k + 1) % 3])).or_default().push(t);
        }
    }
    map
}

/// Pairs the triangles around the edge `a → b` that bound the same solid wedge: each triangle
/// holding `b → a` (solid on its counter-clockwise side around `b − a`) with the next triangle
/// counter-clockwise, which holds `a → b`. Returns `(forward, reverse)` triangle pairs.
fn wedge_pairs(a: u32, b: u32, forward: &[usize], reverse: &[usize], tris: &[Tri], pos: &[F3]) -> Vec<(usize, usize)> {
    if let ([f], [r]) = (forward, reverse) {
        return vec![(*f, *r)];
    }
    let pa = pos[a as usize];
    let d = sub_f(pos[b as usize], pa);
    let axis = (0..3).min_by(|&i, &j| d[i].abs().total_cmp(&d[j].abs())).unwrap_or(0);
    let mut helper = [0.0; 3];
    helper[axis] = 1.0;
    let e1 = cross_f(d, helper);
    let e2 = cross_f(d, e1);
    let angle = |t: usize| {
        let w = tris[t].v.iter().copied().find(|&x| x != a && x != b).unwrap_or(a);
        let r = sub_f(pos[w as usize], pa);
        dot_f(r, e2).atan2(dot_f(r, e1))
    };
    let mut around: Vec<(f64, bool, usize)> =
        forward.iter().map(|&t| (angle(t), true, t)).chain(reverse.iter().map(|&t| (angle(t), false, t))).collect();
    around.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.2.cmp(&y.2)));
    let n = around.len();
    (0..n).filter(|&k| !around[k].1 && around[(k + 1) % n].1).map(|k| (around[(k + 1) % n].2, around[k].2)).collect()
}

fn find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

/// Gives each solid that meets others only along edges or at vertices its own copies of those
/// vertices (SPEC §2.4: at `c = 0`, vertices are duplicated along non-manifold edges). The triangle
/// corners at a vertex are joined across every edge pair of [`wedge_pairs`]; each group of joined
/// corners gets its own vertex.
fn split_vertices(tris: &mut [Tri], pos: &mut Vec<F3>) {
    let map = edge_map(tris);
    let corner = |t: usize, v: u32| 3 * t + tris[t].v.iter().position(|&x| x == v).unwrap_or(0);
    let mut parent: Vec<usize> = (0..3 * tris.len()).collect();
    for (&(a, b), forward) in &map {
        let Some(reverse) = map.get(&(b, a)).filter(|_| a < b) else { continue };
        for (f, r) in wedge_pairs(a, b, forward, reverse, tris, pos) {
            for v in [a, b] {
                let (x, y) = (find(&mut parent, corner(f, v)), find(&mut parent, corner(r, v)));
                parent[x.max(y)] = x.min(y);
            }
        }
    }
    let mut seen: HashSet<u32> = HashSet::new();
    let mut copies: HashMap<(u32, usize), u32> = HashMap::new();
    for (t, tri) in tris.iter_mut().enumerate() {
        for (k, slot) in tri.v.iter_mut().enumerate() {
            let v = *slot;
            let group = find(&mut parent, 3 * t + k);
            *slot = *copies.entry((v, group)).or_insert_with(|| {
                if seen.insert(v) {
                    v
                } else {
                    pos.push(pos[v as usize]);
                    (pos.len() - 1) as u32
                }
            });
        }
    }
}

fn edge_at(tri: &Tri, a: u32, b: u32) -> Option<usize> {
    (0..3).find(|&k| tri.v[k] == a && tri.v[(k + 1) % 3] == b)
}

/// Separates solids that still share an edge after [`split_vertices`] (their vertices are joined
/// elsewhere): each pair of [`wedge_pairs`] around the edge is split at its own copy of the edge
/// midpoint.
fn split_edges(tris: &mut Vec<Tri>, pos: &mut Vec<F3>) {
    let mut shared: Vec<(u32, u32)> =
        edge_map(tris).into_iter().filter(|(_, ts)| ts.len() > 1).map(|((a, b), _)| (a.min(b), a.max(b))).collect();
    shared.sort_unstable();
    shared.dedup();
    for (a, b) in shared {
        let holding =
            |a: u32, b: u32| (0..tris.len()).filter(|&t| edge_at(&tris[t], a, b).is_some()).collect::<Vec<_>>();
        let (forward, reverse) = (holding(a, b), holding(b, a));
        for (f, r) in wedge_pairs(a, b, &forward, &reverse, tris, pos) {
            let (pa, pb) = (pos[a as usize], pos[b as usize]);
            pos.push(std::array::from_fn(|i| (pa[i] + pb[i]) / 2.0));
            let m = (pos.len() - 1) as u32;
            for (t, x, y) in [(f, a, b), (r, b, a)] {
                let Some(k) = edge_at(&tris[t], x, y) else { continue };
                let w = tris[t].v[(k + 2) % 3];
                tris[t].v = [x, m, w];
                tris.push(Tri { v: [m, y, w], normal: tris[t].normal });
            }
        }
    }
}

/// A triangle mesh of one piece in millimetres, with its bounding box at the origin.
#[derive(Clone, Debug, PartialEq)]
pub struct Mesh {
    pub positions: Vec<[f64; 3]>,
    /// Counter-clockwise seen from outside.
    pub triangles: Vec<[u32; 3]>,
    /// The unit outward normal of each triangle.
    pub normals: Vec<[f64; 3]>,
}

impl Mesh {
    /// The enclosed volume in mm³.
    pub fn volume(&self) -> f64 {
        let at = |i: u32| self.positions[i as usize];
        self.triangles.iter().map(|&[a, b, c]| dot_f(at(a), cross_f(at(b), at(c)))).sum::<f64>() / 6.0
    }

    /// The size of the bounding box in mm.
    pub fn size(&self) -> [f64; 3] {
        std::array::from_fn(|a| self.positions.iter().map(|p| p[a]).fold(0.0, f64::max))
    }

    /// The mesh as binary STL: an 80-byte header that names the piece and never starts with
    /// `solid`, the triangle count, then per triangle its normal, its three vertices and 0.
    pub fn to_stl(&self, name: &str) -> Vec<u8> {
        let mut out = format!("puzzle-generator piece {name}").into_bytes();
        out.resize(80, b' ');
        out.reserve(4 + 50 * self.triangles.len());
        out.extend_from_slice(&(self.triangles.len() as u32).to_le_bytes());
        for (triangle, normal) in self.triangles.iter().zip(&self.normals) {
            let vertices = triangle.iter().flat_map(|&i| self.positions[i as usize]);
            for x in normal.iter().copied().chain(vertices) {
                out.extend_from_slice(&(x as f32).to_le_bytes());
            }
            out.extend_from_slice(&0u16.to_le_bytes());
        }
        out
    }
}

/// The watertight mesh of a set of voxels (SPEC §2.4): eroded by the clearance, convex edges
/// chamfered, coplanar faces merged, in millimetres with the bounding box at the origin.
pub fn mesh(voxels: &[Voxel], options: &StlOptions) -> Result<Mesh, StlError> {
    let Params { c, r, unit } = options.params()?;
    if let Some(&v) = voxels.iter().find(|v| v.iter().any(|x| !(0..MAX_GRID).contains(x))) {
        return Err(StlError::OutOfRange(v));
    }
    let set: HashSet<Voxel> = voxels.iter().copied().collect();
    if set.is_empty() {
        return Err(StlError::EmptyPiece);
    }
    let (positions, mut polys) = index_faces(cell_faces(&Cells::new(&set, c), r));
    conform(&positions, &mut polys);
    let mut polys = merge_coplanar(&positions, polys);
    drop_flat_vertices(&positions, &mut polys);
    let mut tris = Vec::new();
    let mut out = Vec::new();
    for poly in &polys {
        out.clear();
        triangulate(&poly.ids, &positions, poly.normal, &mut out);
        tris.extend(out.iter().map(|&v| Tri { v, normal: poly.normal }));
    }
    let mut pos: Vec<F3> = positions.iter().map(|p| p.map(|x| x as f64)).collect();
    split_vertices(&mut tris, &mut pos);
    split_edges(&mut tris, &mut pos);
    if tris.is_empty() {
        return Err(StlError::EmptyPiece);
    }
    let mut remap = vec![u32::MAX; pos.len()];
    let mut used: Vec<F3> = Vec::new();
    for v in tris.iter_mut().flat_map(|t| t.v.iter_mut()) {
        if remap[*v as usize] == u32::MAX {
            remap[*v as usize] = used.len() as u32;
            used.push(pos[*v as usize]);
        }
        *v = remap[*v as usize];
    }
    let min: F3 = std::array::from_fn(|a| used.iter().map(|p| p[a]).fold(f64::INFINITY, f64::min));
    let normals = tris
        .iter()
        .map(|t| {
            let n = t.normal.map(|x| x as f64);
            let len = dot_f(n, n).sqrt();
            n.map(|x| x / len)
        })
        .collect();
    Ok(Mesh {
        positions: used.iter().map(|p| std::array::from_fn(|a| (p[a] - min[a]) * unit / LATTICE as f64)).collect(),
        triangles: tris.iter().map(|t| t.v).collect(),
        normals,
    })
}

/// The binary STL of the fixed voxels of piece `index` (SPEC §2.4).
pub fn piece_stl(doc: &Document, index: usize, options: &StlOptions) -> Result<Vec<u8>, StlError> {
    let piece = doc.pieces.get(index).ok_or(StlError::PieceIndex { index, count: doc.pieces.len() })?;
    Ok(mesh(&piece.fixed, options)?.to_stl(&piece.name))
}

/// The zip entry name of each piece (SPEC §2.4): the trimmed piece name with every character other
/// than an ASCII letter, digit, `-` or `_` replaced by `_` (`piece-N` when empty), made unique
/// ignoring case with `-2`, `-3`, …, plus `.stl`.
pub fn stl_file_names(doc: &Document) -> Vec<String> {
    let mut used = HashSet::new();
    doc.pieces
        .iter()
        .enumerate()
        .map(|(i, piece)| {
            let keep = |ch: char| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
            let base: String = piece.name.trim().chars().map(|ch| if keep(ch) { ch } else { '_' }).collect();
            let base = if base.is_empty() { format!("piece-{}", i + 1) } else { base };
            let mut name = base.clone();
            for k in 2.. {
                if used.insert(name.to_ascii_lowercase()) {
                    break;
                }
                name = format!("{base}-{k}");
            }
            format!("{name}.stl")
        })
        .collect()
}

/// A zip with one binary STL per piece that has fixed voxels, named by [`stl_file_names`]
/// (SPEC §2.4).
pub fn stl_zip(doc: &Document, options: &StlOptions) -> Result<Vec<u8>, StlError> {
    options.params()?;
    let mut zip = ZipWriter::default();
    for (piece, name) in doc.pieces.iter().zip(stl_file_names(doc)) {
        if !piece.fixed.is_empty() {
            zip.add(&name, &mesh(&piece.fixed, options)?.to_stl(&piece.name))?;
        }
    }
    if zip.count == 0 {
        return Err(StlError::NoPieces);
    }
    zip.finish()
}

/// Zip version 2.0 (deflate).
const ZIP_VERSION: u16 = 20;
/// General purpose flag bit 11: names are UTF-8.
const ZIP_UTF8: u16 = 0x0800;
const ZIP_DEFLATE: u16 = 8;
/// 1980-01-01 in MS-DOS date format; entries carry no real timestamp, so the zip is reproducible.
const ZIP_DATE: u16 = 0x21;

/// A minimal zip writer: deflated entries with UTF-8 names, no zip64.
#[derive(Default)]
struct ZipWriter {
    data: Vec<u8>,
    central: Vec<u8>,
    count: usize,
}

fn zip_u32(n: usize) -> Result<u32, StlError> {
    u32::try_from(n).map_err(|_| StlError::Zip("the archive exceeds 4 GiB".into()))
}

impl ZipWriter {
    fn add(&mut self, name: &str, content: &[u8]) -> Result<(), StlError> {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content).map_err(|e| StlError::Zip(e.to_string()))?;
        let packed = encoder.finish().map_err(|e| StlError::Zip(e.to_string()))?;
        let mut crc = Crc::new();
        crc.update(content);
        let name_len = u16::try_from(name.len()).map_err(|_| StlError::Zip(format!("name too long: {name}")))?;
        let offset = zip_u32(self.data.len())?;
        // From "version needed" to "extra field length", shared by both headers.
        let mut fields = Vec::with_capacity(26);
        for x in [ZIP_VERSION, ZIP_UTF8, ZIP_DEFLATE, 0, ZIP_DATE] {
            fields.extend_from_slice(&x.to_le_bytes());
        }
        for x in [crc.sum(), zip_u32(packed.len())?, zip_u32(content.len())?] {
            fields.extend_from_slice(&x.to_le_bytes());
        }
        for x in [name_len, 0] {
            fields.extend_from_slice(&x.to_le_bytes());
        }
        self.data.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        self.data.extend_from_slice(&fields);
        self.data.extend_from_slice(name.as_bytes());
        self.data.extend_from_slice(&packed);
        self.central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        self.central.extend_from_slice(&ZIP_VERSION.to_le_bytes());
        self.central.extend_from_slice(&fields);
        // Comment length, disk number, internal attributes, external attributes, header offset.
        for x in [0u16, 0, 0] {
            self.central.extend_from_slice(&x.to_le_bytes());
        }
        for x in [0, offset] {
            self.central.extend_from_slice(&x.to_le_bytes());
        }
        self.central.extend_from_slice(name.as_bytes());
        self.count += 1;
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<u8>, StlError> {
        let count = u16::try_from(self.count).map_err(|_| StlError::Zip("too many entries".into()))?;
        let (size, offset) = (zip_u32(self.central.len())?, zip_u32(self.data.len())?);
        self.data.append(&mut self.central);
        self.data.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        for x in [0, 0, count, count] {
            self.data.extend_from_slice(&x.to_le_bytes());
        }
        for x in [size, offset] {
            self.data.extend_from_slice(&x.to_le_bytes());
        }
        self.data.extend_from_slice(&0u16.to_le_bytes());
        Ok(self.data)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::DeflateDecoder;

    use super::*;
    use crate::model::{DocumentPiece, Meta};
    use crate::templates::{fixture_document, known_burrs};

    const TROMINO: [Voxel; 3] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    const BAR: [Voxel; 3] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];

    fn options(unit: f64, clearance: f64, chamfer: f64) -> StlOptions {
        StlOptions { unit, clearance, chamfer }
    }

    fn doc(pieces: &[(&str, &[Voxel])]) -> Document {
        let pieces = pieces
            .iter()
            .enumerate()
            .map(|(i, (name, fixed))| DocumentPiece {
                id: format!("p{i}"),
                name: name.to_string(),
                color: "#808080".into(),
                notchable: false,
                fixed: fixed.to_vec(),
                optional: Vec::new(),
            })
            .collect();
        Document {
            format: "puzzle-generator".into(),
            version: 1,
            name: "test".into(),
            description: String::new(),
            grid: [MAX_GRID; 3],
            pieces,
            target: None,
            meta: Meta::default(),
        }
    }

    /// Every directed edge is used once and its reverse once, no triangle repeats a vertex, every
    /// triangle is wound around its stored normal, and the enclosed volume is positive.
    fn assert_closed(m: &Mesh) {
        let mut uses: HashMap<(u32, u32), usize> = HashMap::new();
        for (t, &[a, b, c]) in m.triangles.iter().enumerate() {
            assert!(a != b && b != c && c != a, "triangle {t} repeats a vertex");
            for e in [(a, b), (b, c), (c, a)] {
                *uses.entry(e).or_default() += 1;
            }
            let p = |i: u32| m.positions[i as usize];
            let n = cross_f(sub_f(p(b), p(a)), sub_f(p(c), p(a)));
            let along = dot_f(n, m.normals[t]);
            assert!(
                along > 0.0 && along * along > 0.999_999 * dot_f(n, n),
                "triangle {t} is not wound around its normal"
            );
        }
        for (&(a, b), &count) in &uses {
            assert_eq!(count, 1, "edge {a} -> {b} is used {count} times");
            assert_eq!(uses.get(&(b, a)), Some(&1), "edge {a} -> {b} has no twin");
        }
        assert!(m.volume() > 0.0);
    }

    fn closed_mesh(voxels: &[Voxel], options: &StlOptions) -> Mesh {
        let m = mesh(voxels, options).unwrap_or_else(|e| panic!("{voxels:?} {options:?}: {e}"));
        assert_closed(&m);
        m
    }

    fn assert_near(a: f64, b: f64) {
        assert!((a - b).abs() <= 1e-9 * b.abs().max(1.0), "{a} != {b}");
    }

    #[test]
    fn cube() {
        let m = closed_mesh(&[[3, 4, 5]], &options(10.0, 0.0, 0.0));
        assert_eq!((m.triangles.len(), m.positions.len()), (12, 8));
        assert_near(m.volume(), 1000.0);
        assert_eq!(m.size(), [10.0; 3]);
    }

    #[test]
    fn clearance_offsets_every_face() {
        let cube = closed_mesh(&[[0, 0, 0]], &options(8.0, 0.25, 0.0));
        assert_eq!(cube.size(), [7.5; 3]);
        assert_near(cube.volume(), 7.5f64.powi(3));
        let bar = closed_mesh(&BAR, &options(8.0, 0.25, 0.0));
        assert_eq!(bar.size(), [23.5, 7.5, 7.5]);
        assert_near(bar.volume(), 1321.875);
        assert_eq!(bar.triangles.len(), 12, "coplanar faces are merged");
    }

    #[test]
    fn eroded_tromino() {
        assert_near(closed_mesh(&TROMINO, &options(8.0, 0.0, 0.0)).volume(), 3.0 * 512.0);
        let m = closed_mesh(&TROMINO, &options(8.0, 0.25, 0.0));
        let w = 1.0 - 2.0 * 0.25 / 8.0;
        assert_near(m.volume(), (2.0 * (1.0 + w) * w - w * w) * w * 512.0);
        assert_eq!(m.size(), [15.5, 15.5, 7.5]);
    }

    #[test]
    fn chamfer_volumes() {
        // A chamfered a×b×c box keeps abc − 2r²(a + b + c) + 16r³/3.
        let chamfered = |voxels: &[Voxel], clearance: f64| closed_mesh(voxels, &options(8.0, clearance, 1.0)).volume();
        assert_near(chamfered(&[[0, 0, 0]], 0.0), 512.0 - 2.0 * 24.0 + 16.0 / 3.0);
        assert_near(chamfered(&BAR, 0.0), 1536.0 - 2.0 * 40.0 + 16.0 / 3.0);
        assert_near(chamfered(&BAR, 0.25), 1321.875 - 2.0 * 38.5 + 16.0 / 3.0);
        // 21 unit lengths of convex edges, 10 chamfered corners.
        assert_near(chamfered(&TROMINO, 0.0), 1536.0 - 10.5 * 8.0 + 20.0 / 3.0);
    }

    #[test]
    fn extreme_options_are_clamped_to_the_lattice() {
        let thin = closed_mesh(&BAR, &options(8.0, 3.999_999_9, 0.0));
        assert!(thin.size()[1] > 0.0 && thin.size()[1] < 1e-4);
        let round = closed_mesh(&BAR, &options(8.0, 0.0, 3.999_999_9));
        assert_near(round.size()[0], 24.0);
        closed_mesh(&TROMINO, &options(8.0, 0.5, 3.499_999_9));
    }

    #[test]
    fn known_burr_pieces_are_closed() {
        for fixture in known_burrs().values() {
            for piece in &fixture.pieces {
                for (clearance, chamfer) in [(0.0, 0.0), (0.0, 0.5), (0.125, 0.0), (0.125, 0.5)] {
                    let m = closed_mesh(&piece.voxels, &options(8.0, clearance, chamfer));
                    for a in 0..3 {
                        let (lo, hi) =
                            piece.voxels.iter().fold((i32::MAX, i32::MIN), |(lo, hi), v| (lo.min(v[a]), hi.max(v[a])));
                        assert_near(m.size()[a], f64::from(hi - lo + 1) * 8.0 - 2.0 * clearance);
                    }
                    if clearance == 0.0 && chamfer == 0.0 {
                        assert_near(m.volume(), piece.voxels.len() as f64 * 512.0);
                    }
                }
            }
        }
    }

    #[test]
    fn solids_touching_along_an_edge_or_at_a_vertex_get_their_own_vertices() {
        for voxels in [[[0, 0, 0], [1, 1, 0]], [[0, 0, 0], [1, 1, 1]]] {
            let m = closed_mesh(&voxels, &options(8.0, 0.0, 0.0));
            assert_eq!(m.positions.len(), 16);
            assert_near(m.volume(), 1024.0);
            assert_near(closed_mesh(&voxels, &options(8.0, 0.0, 1.0)).volume(), 2.0 * (512.0 - 48.0 + 16.0 / 3.0));
            assert_near(closed_mesh(&voxels, &options(8.0, 0.25, 0.0)).volume(), 2.0 * 7.5f64.powi(3));
        }
    }

    #[test]
    fn two_cones_at_a_vertex() {
        let voxels: Vec<Voxel> =
            (0..8).map(|m| [m & 1, m >> 1 & 1, m >> 2 & 1]).filter(|v| *v != [0, 0, 0] && *v != [1, 1, 1]).collect();
        let m = closed_mesh(&voxels, &options(8.0, 0.0, 0.0));
        assert_near(m.volume(), 6.0 * 512.0);
        let centre = m.positions.iter().filter(|p| p.iter().all(|&x| (x - 8.0).abs() < 1e-9)).count();
        assert_eq!(centre, 2);
    }

    #[test]
    fn edge_shared_by_solids_joined_elsewhere() {
        let mut voxels: Vec<Voxel> = Vec::new();
        for z in [0, 2] {
            voxels.extend([[0, 0, z], [1, 0, z], [0, 1, z], [1, 1, z]]);
        }
        voxels.extend([[0, 0, 1], [1, 1, 1]]);
        let m = closed_mesh(&voxels, &options(8.0, 0.0, 0.0));
        assert_near(m.volume(), 10.0 * 512.0);
        closed_mesh(&voxels, &options(8.0, 0.0, 0.5));
        closed_mesh(&voxels, &options(8.0, 0.25, 0.5));
    }

    #[test]
    fn binary_stl_layout() {
        let d = doc(&[("solid", &TROMINO)]);
        let opts = options(8.0, 0.0, 0.0);
        let stl = piece_stl(&d, 0, &opts).unwrap();
        let m = mesh(&TROMINO, &opts).unwrap();
        assert_eq!(stl.len(), 84 + 50 * m.triangles.len());
        assert!(!stl.starts_with(b"solid"));
        assert!(stl[..80].starts_with(b"puzzle-generator piece solid"));
        assert_eq!(u32::from_le_bytes([stl[80], stl[81], stl[82], stl[83]]) as usize, m.triangles.len());
        let float = |at: usize| f32::from_le_bytes([stl[at], stl[at + 1], stl[at + 2], stl[at + 3]]);
        let first = m.positions[m.triangles[0][0] as usize];
        assert_eq!([float(96), float(100), float(104)], first.map(|x| x as f32));
        assert_eq!([float(84), float(88), float(92)], m.normals[0].map(|x| x as f32));
    }

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    #[test]
    fn zip_holds_one_stl_per_piece() {
        let fixture = known_burrs().into_values().next().unwrap();
        let d = fixture_document(&fixture);
        let opts = options(8.0, 0.125, 0.5);
        let zip = stl_zip(&d, &opts).unwrap();
        assert_eq!(zip, stl_zip(&d, &opts).unwrap(), "the zip is reproducible");
        let names = stl_file_names(&d);
        assert_eq!(names.len(), d.pieces.len());
        let mut offsets = Vec::new();
        let mut at = 0;
        for (i, name) in names.iter().enumerate() {
            offsets.push(at);
            assert_eq!(u32_at(&zip, at), 0x0403_4b50);
            assert_eq!(u16_at(&zip, at + 6), 0x0800);
            assert_eq!(u16_at(&zip, at + 8), 8);
            let crc = u32_at(&zip, at + 14);
            let (packed, size) = (u32_at(&zip, at + 18) as usize, u32_at(&zip, at + 22) as usize);
            let name_len = usize::from(u16_at(&zip, at + 26));
            assert_eq!(u16_at(&zip, at + 28), 0);
            assert_eq!(&zip[at + 30..at + 30 + name_len], name.as_bytes());
            let start = at + 30 + name_len;
            let mut content = Vec::new();
            DeflateDecoder::new(&zip[start..start + packed]).read_to_end(&mut content).unwrap();
            assert_eq!(content.len(), size);
            assert_eq!(content, piece_stl(&d, i, &opts).unwrap());
            let mut check = Crc::new();
            check.update(&content);
            assert_eq!(check.sum(), crc);
            at = start + packed;
        }
        let end = zip.len() - 22;
        assert_eq!(u32_at(&zip, end), 0x0605_4b50);
        assert_eq!(usize::from(u16_at(&zip, end + 8)), names.len());
        assert_eq!(usize::from(u16_at(&zip, end + 10)), names.len());
        let (size, offset) = (u32_at(&zip, end + 12) as usize, u32_at(&zip, end + 16) as usize);
        assert_eq!((offset, offset + size), (at, end));
        for (name, local) in names.iter().zip(offsets) {
            assert_eq!(u32_at(&zip, at), 0x0201_4b50);
            assert_eq!(u32_at(&zip, at + 42) as usize, local);
            let name_len = usize::from(u16_at(&zip, at + 28));
            assert_eq!(&zip[at + 46..at + 46 + name_len], name.as_bytes());
            at += 46 + name_len;
        }
        assert_eq!(at, end);
    }

    #[test]
    fn zip_skips_empty_pieces() {
        let d = doc(&[("a", &[]), ("b", &[[0, 0, 0]])]);
        let zip = stl_zip(&d, &options(8.0, 0.0, 0.0)).unwrap();
        assert_eq!(u16_at(&zip, zip.len() - 12), 1);
        assert_eq!(&zip[30..35], b"b.stl");
        assert_eq!(stl_zip(&doc(&[("a", &[])]), &options(8.0, 0.0, 0.0)), Err(StlError::NoPieces));
    }

    #[test]
    fn rejects_bad_input() {
        let cube = [[0, 0, 0]];
        let bad = [
            (0.0, 0.0, 0.0),
            (-1.0, 0.0, 0.0),
            (f64::NAN, 0.0, 0.0),
            (2000.0, 0.0, 0.0),
            (8.0, 4.0, 0.0),
            (8.0, -0.1, 0.0),
            (8.0, f64::INFINITY, 0.0),
            (8.0, 0.0, 4.0),
            (8.0, 1.0, 3.0),
            (8.0, 0.0, -1.0),
            (8.0, 0.0, f64::NAN),
        ];
        for (unit, clearance, chamfer) in bad {
            let opts = options(unit, clearance, chamfer);
            assert!(mesh(&cube, &opts).is_err(), "{opts:?}");
            assert!(stl_zip(&doc(&[("a", &cube)]), &opts).is_err(), "{opts:?}");
        }
        let opts = options(8.0, 0.0, 0.0);
        assert_eq!(mesh(&[[-1, 0, 0]], &opts), Err(StlError::OutOfRange([-1, 0, 0])));
        assert_eq!(mesh(&[[0, MAX_GRID, 0]], &opts), Err(StlError::OutOfRange([0, MAX_GRID, 0])));
        assert_eq!(mesh(&[], &opts), Err(StlError::EmptyPiece));
        assert_eq!(piece_stl(&doc(&[("a", &cube)]), 1, &opts), Err(StlError::PieceIndex { index: 1, count: 1 }));
        assert_eq!(piece_stl(&doc(&[("a", &[])]), 0, &opts), Err(StlError::EmptyPiece));
    }

    /// The volume of the cut cells in mm³, from the box of each kept cell, the length of its bevels
    /// (`r²/2` each per unit of length) and its chamfered corners (`2r³/3` each given back).
    fn cell_volume(voxels: &[Voxel], options: &StlOptions) -> f64 {
        let Params { c, r, unit } = options.params().unwrap();
        let cells = Cells::new(&voxels.iter().copied().collect(), c);
        let r = r as f64;
        let mut volume = 0.0;
        for index in (0..cells.kept.len()).filter(|&i| cells.kept[i]) {
            let cell = cells.cell(index);
            let (lo, hi) = cells.bounds(cell);
            let size: [f64; 3] = std::array::from_fn(|a| (hi[a] - lo[a]) as f64);
            volume += size.iter().product::<f64>();
            let empty = |axis: usize, sign: i64| cells.neighbour(cell, axis, sign).is_none();
            for (i, j) in [(0, 1), (0, 2), (1, 2)] {
                for (s1, s2) in [(-1, -1), (-1, 1), (1, -1), (1, 1)] {
                    if empty(i, s1) && empty(j, s2) {
                        volume -= r * r / 2.0 * size[3 - i - j];
                    }
                }
            }
            for m in 0..8 {
                if (0..3).all(|a| empty(a, if m >> a & 1 == 1 { 1 } else { -1 })) {
                    volume += 2.0 * r * r * r / 3.0;
                }
            }
        }
        volume * (unit / LATTICE as f64).powi(3)
    }

    #[test]
    fn random_shapes_are_closed() {
        let mut rng = crate::rng::SplitMix64::new(7);
        for shape in 0..300 {
            let percent = [40, 60, 80][shape % 3];
            let voxels: Vec<Voxel> =
                (0..27).map(|i| [i % 3, i / 3 % 3, i / 9]).filter(|_| rng.below(100) < percent).collect();
            if voxels.is_empty() {
                continue;
            }
            for (clearance, chamfer) in [(0.0, 0.0), (0.0, 1.0), (0.25, 0.0), (0.25, 1.5), (1.0, 2.5)] {
                let opts = options(8.0, clearance, chamfer);
                let m = closed_mesh(&voxels, &opts);
                assert_near(m.volume(), cell_volume(&voxels, &opts));
            }
        }
    }

    #[test]
    fn options_json() {
        let parsed: StlOptions = serde_json::from_str(r#"{"unit": 10}"#).unwrap();
        assert_eq!(parsed, options(10.0, 0.0, 0.0));
        let parsed: StlOptions = serde_json::from_str(r#"{"unit": 8, "clearance": 0.1, "chamfer": 0.5}"#).unwrap();
        assert_eq!(parsed, options(8.0, 0.1, 0.5));
        assert!(serde_json::from_str::<StlOptions>("{}").is_err());
    }

    #[test]
    fn file_names_are_safe_and_unique() {
        let cube: &[Voxel] = &[[0, 0, 0]];
        let d = doc(&[("A", cube), ("a", cube), ("  ", cube), ("x/y é", cube), (" A ", cube)]);
        assert_eq!(stl_file_names(&d), ["A.stl", "a-2.stl", "piece-3.stl", "x_y__.stl", "A-3.stl"]);
    }
}
