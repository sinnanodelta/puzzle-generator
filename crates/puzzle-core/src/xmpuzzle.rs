//! BurrTools `.xmpuzzle` import and export (SPEC §2.3; format in SPEC Appendix B).
//!
//! The reader and writer follow BurrTools 0.6.3 (`src/lib/puzzle.cpp`, `voxel.cpp`, `problem.cpp`,
//! `assembly.cpp` and `xml.cpp`). Only the cube grid (`gridType` 0) is supported.

use std::collections::HashSet;
use std::fmt;
use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use roxmltree::Node;
use serde::Serialize;

use crate::assembler::{AssembleOptions, AssembleResult, AssembleStatus};
use crate::model::{
    Document, DocumentError, DocumentPiece, FORMAT, MAX_GRID, MAX_PIECES, Meta, ModelError, Target, VERSION, Voxel,
};
use crate::shape::bounds;
use crate::templates::piece_color;

/// Largest decompressed XML, in bytes.
pub const MAX_XML_BYTES: usize = 32 << 20;
/// Largest side of a shape, in cells.
const MAX_SHAPE_SIDE: i64 = 4 * MAX_GRID as i64;
/// Largest absolute hotspot or placement coordinate. Keeps all arithmetic far from overflow.
const MAX_COORDINATE: i64 = 1 << 20;
/// `meta.source` of imported documents.
pub const SOURCE: &str = "BurrTools .xmpuzzle";

/// BurrTools' 48 cube transformations, copied from `src/lib/tabs_0/rotmatrix.inc` of BurrTools
/// 0.6.3 (<https://sourceforge.net/projects/burrtools/files/burrtools/0.6.3/burrtools-0.6.3.tar.gz/download>),
/// indexed by the `t` of an assembly placement (`src/lib/assembly.cpp`, SPEC Appendix B).
///
/// Each entry is a row-major matrix `m`: `x' = m0·x + m1·y + m2·z`, `y' = m3·x + m4·y + m5·z`,
/// `z' = m6·x + m7·y + m8·z`. Entries 0–23 are the rotations (determinant +1) and entries 24–47
/// are mirror images (determinant −1). The transform of `src/lib/voxel_0.cpp` moves the voxels and
/// the hotspot together, so a shape with hotspot `h` placed at `X` with transform `t` covers
/// `M·(p − h) + X` for each of its cells `p`.
pub const ROTATIONS: [[i32; 9]; 48] = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, -1, 0, 1, 0],
    [1, 0, 0, 0, -1, 0, 0, 0, -1],
    [1, 0, 0, 0, 0, 1, 0, -1, 0],
    [0, 0, -1, 0, 1, 0, 1, 0, 0],
    [0, -1, 0, 0, 0, -1, 1, 0, 0],
    [0, 0, 1, 0, -1, 0, 1, 0, 0],
    [0, 1, 0, 0, 0, 1, 1, 0, 0],
    [-1, 0, 0, 0, 1, 0, 0, 0, -1],
    [-1, 0, 0, 0, 0, -1, 0, -1, 0],
    [-1, 0, 0, 0, -1, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 0, 1, 0, 1, 0, -1, 0, 0],
    [0, 1, 0, 0, 0, -1, -1, 0, 0],
    [0, 0, -1, 0, -1, 0, -1, 0, 0],
    [0, -1, 0, 0, 0, 1, -1, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, -1],
    [0, 0, -1, 1, 0, 0, 0, -1, 0],
    [0, 1, 0, -1, 0, 0, 0, 0, 1],
    [0, 0, -1, -1, 0, 0, 0, 1, 0],
    [0, -1, 0, -1, 0, 0, 0, 0, -1],
    [0, 0, 1, -1, 0, 0, 0, -1, 0],
    [-1, 0, 0, 0, 1, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, -1, 0, 1, 0],
    [-1, 0, 0, 0, -1, 0, 0, 0, -1],
    [-1, 0, 0, 0, 0, 1, 0, -1, 0],
    [0, 0, -1, 0, 1, 0, -1, 0, 0],
    [0, -1, 0, 0, 0, -1, -1, 0, 0],
    [0, 0, 1, 0, -1, 0, -1, 0, 0],
    [0, 1, 0, 0, 0, 1, -1, 0, 0],
    [1, 0, 0, 0, 1, 0, 0, 0, -1],
    [1, 0, 0, 0, 0, -1, 0, -1, 0],
    [1, 0, 0, 0, -1, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 0, 1, 0, 1, 0, 1, 0, 0],
    [0, 1, 0, 0, 0, -1, 1, 0, 0],
    [0, 0, -1, 0, -1, 0, 1, 0, 0],
    [0, -1, 0, 0, 0, 1, 1, 0, 0],
    [0, -1, 0, -1, 0, 0, 0, 0, 1],
    [0, 0, 1, -1, 0, 0, 0, 1, 0],
    [0, 1, 0, -1, 0, 0, 0, 0, -1],
    [0, 0, -1, -1, 0, 0, 0, -1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, -1, 1, 0, 0, 0, 1, 0],
    [0, -1, 0, 1, 0, 0, 0, 0, -1],
    [0, 0, 1, 1, 0, 0, 0, -1, 0],
];

#[derive(Debug)]
pub enum XmpuzzleError {
    Gzip(std::io::Error),
    TooLarge,
    Xml(roxmltree::Error),
    NotAPuzzle(String),
    Version(String),
    GridType(String),
    MissingAttribute {
        element: &'static str,
        attribute: &'static str,
    },
    BadAttribute {
        element: &'static str,
        attribute: &'static str,
        value: String,
    },
    VoxelText {
        shape: usize,
        message: String,
    },
    ShapeTooLarge {
        shape: usize,
        size: [i64; 3],
    },
    UnknownShape(u64),
    NoProblem,
    ProblemIndex {
        index: usize,
        count: usize,
    },
    TooManyPieces(u64),
    GridTooLarge([i64; 3]),
    EmptyPiece(usize),
    NoPieces,
    Document(DocumentError),
    /// [`place`] on a problem without a result shape.
    NoTarget,
    /// [`place`] found no disassemblable assembly.
    NoSolution {
        assemblies: u64,
        undecided: u64,
        aborted: bool,
    },
    /// The assembler rejected the pieces or the target.
    Assemble(ModelError),
}

impl fmt::Display for XmpuzzleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gzip(e) => write!(f, "invalid gzip data: {e}"),
            Self::TooLarge => write!(f, "the XML is larger than {} MiB", MAX_XML_BYTES >> 20),
            Self::Xml(e) => write!(f, "invalid XML: {e}"),
            Self::NotAPuzzle(root) => write!(f, "root element is <{root}>, expected <puzzle>"),
            Self::Version(v) => write!(f, "unsupported BurrTools file version {v:?}, expected 1 or 2"),
            Self::GridType(t) => write!(f, "grid type {t:?} is not supported, only cubes (0)"),
            Self::MissingAttribute { element, attribute } => write!(f, "<{element}> has no {attribute:?} attribute"),
            Self::BadAttribute { element, attribute, value } => {
                write!(f, "<{element}> attribute {attribute:?} has an invalid value {value:?}")
            }
            Self::VoxelText { shape, message } => write!(f, "shape {shape}: {message}"),
            Self::ShapeTooLarge { shape, size } => {
                write!(f, "shape {shape} is {size:?} cells, more than {MAX_SHAPE_SIDE} per side")
            }
            Self::UnknownShape(id) => write!(f, "the problem uses shape {id}, which does not exist"),
            Self::NoProblem => write!(f, "the file has no problem"),
            Self::ProblemIndex { index, count } => write!(f, "problem {index} does not exist ({count} problems)"),
            Self::TooManyPieces(n) => write!(f, "{n} pieces, at most {MAX_PIECES} are supported"),
            Self::GridTooLarge(size) => write!(f, "the puzzle spans {size:?} cells, more than {MAX_GRID} per side"),
            Self::EmptyPiece(p) => write!(f, "piece {p} has no cell"),
            Self::NoPieces => write!(f, "the document has no piece"),
            Self::Document(e) => write!(f, "invalid document: {e}"),
            Self::NoTarget => {
                write!(
                    f,
                    "the file has no solution and its problem has no result shape, so the pieces cannot be assembled"
                )
            }
            Self::NoSolution { assemblies, undecided, aborted } => {
                write!(
                    f,
                    "the file has no solution and the assembler found no disassemblable assembly of the pieces into                      the result shape ({assemblies} assemblies"
                )?;
                if *undecided > 0 {
                    write!(f, ", {undecided} of them undecided at the state cap")?;
                }
                if *aborted {
                    write!(f, ", count stopped at the assembly cap")?;
                }
                write!(f, ")")
            }
            Self::Assemble(e) => write!(f, "cannot assemble the pieces: {e}"),
        }
    }
}

impl std::error::Error for XmpuzzleError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Gzip(e) => Some(e),
            Self::Xml(e) => Some(e),
            Self::Document(e) => Some(e),
            Self::Assemble(e) => Some(e),
            _ => None,
        }
    }
}

/// The result of an import (SPEC §2.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Import {
    /// The first solution placed the pieces: a ready document.
    Placed(Placed),
    /// The problem has no usable solution: the assembler (SPEC §5) must place the pieces.
    Unplaced(Unplaced),
}

impl Import {
    pub fn warnings(&self) -> &[String] {
        match self {
            Self::Placed(p) => &p.warnings,
            Self::Unplaced(u) => &u.warnings,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub document: Document,
    pub warnings: Vec<String>,
}

/// The pieces and target of a problem without a usable solution. Piece and target cells are shifted
/// so that their minimum is 0; `grid` is the target's bounding box, or the largest piece box.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unplaced {
    pub name: String,
    pub description: String,
    pub meta: Meta,
    pub grid: [i32; 3],
    pub pieces: Vec<UnplacedPiece>,
    pub target: Option<Target>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnplacedPiece {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Sorted cells.
    pub voxels: Vec<Voxel>,
    /// A copy beyond the problem's `min` count: BurrTools may leave it out of the assembly.
    pub optional_copy: bool,
}

/// A problem of a file, for the problem picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemInfo {
    pub index: usize,
    pub name: String,
    /// Number of pieces (the sum of the `max` counts).
    pub pieces: u64,
    pub solutions: usize,
}

type Cell = [i64; 3];

/// A parsed `<voxel>` shape: its non-empty cells, `true` for variable (`+`).
struct Shape {
    hotspot: Cell,
    cells: Vec<(Cell, bool)>,
    colored: bool,
}

/// One piece of a problem: a copy of a shape.
struct Part {
    shape: usize,
    name: String,
    optional_copy: bool,
}

struct Problem {
    name: String,
    /// The sum of the `max` counts.
    pieces: u64,
    /// The pieces, empty when there are more than `MAX_PIECES`.
    parts: Vec<Part>,
    result: Option<u64>,
    color_pairs: usize,
    groups: bool,
    solutions: usize,
    assembly: Option<String>,
}

/// The text of a file: gunzipped when it starts with the gzip magic, decoded as UTF-8 or Latin-1.
fn decode(bytes: &[u8], warnings: &mut Vec<String>) -> Result<String, XmpuzzleError> {
    let unzipped;
    let data = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        GzDecoder::new(bytes).take(MAX_XML_BYTES as u64 + 1).read_to_end(&mut out).map_err(XmpuzzleError::Gzip)?;
        unzipped = out;
        &unzipped[..]
    } else {
        bytes
    };
    if data.len() > MAX_XML_BYTES {
        return Err(XmpuzzleError::TooLarge);
    }
    let text = match std::str::from_utf8(data) {
        Ok(s) => s.to_string(),
        Err(_) => {
            warnings.push("the file is not UTF-8; it was read as Latin-1".to_string());
            data.iter().map(|&b| char::from(b)).collect()
        }
    };
    Ok(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

fn children<'a, 'i>(node: Node<'a, 'i>, tag: &'static str) -> impl Iterator<Item = Node<'a, 'i>> {
    node.children().filter(move |n| n.has_tag_name(tag))
}

fn child<'a, 'i>(node: Node<'a, 'i>, tag: &'static str) -> Option<Node<'a, 'i>> {
    children(node, tag).next()
}

fn attr<T: std::str::FromStr>(
    node: Node<'_, '_>,
    element: &'static str,
    attribute: &'static str,
) -> Result<Option<T>, XmpuzzleError> {
    match node.attribute(attribute) {
        None => Ok(None),
        Some(value) => value.trim().parse().map(Some).map_err(|_| XmpuzzleError::BadAttribute {
            element,
            attribute,
            value: value.to_string(),
        }),
    }
}

fn required_attr<T: std::str::FromStr>(
    node: Node<'_, '_>,
    element: &'static str,
    attribute: &'static str,
) -> Result<T, XmpuzzleError> {
    attr(node, element, attribute)?.ok_or(XmpuzzleError::MissingAttribute { element, attribute })
}

/// Checks the root, the version and the grid type (SPEC Appendix B, container).
fn puzzle_root<'a, 'i>(xml: &'a roxmltree::Document<'i>) -> Result<Node<'a, 'i>, XmpuzzleError> {
    let root = xml.root_element();
    if !root.has_tag_name("puzzle") {
        return Err(XmpuzzleError::NotAPuzzle(root.tag_name().name().to_string()));
    }
    let version =
        root.attribute("version").ok_or(XmpuzzleError::MissingAttribute { element: "puzzle", attribute: "version" })?;
    if !matches!(version.trim(), "1" | "2") {
        return Err(XmpuzzleError::Version(version.to_string()));
    }
    if let Some(grid) = child(root, "gridType") {
        let kind =
            grid.attribute("type").ok_or(XmpuzzleError::MissingAttribute { element: "gridType", attribute: "type" })?;
        if kind.trim() != "0" {
            return Err(XmpuzzleError::GridType(kind.to_string()));
        }
    }
    Ok(root)
}

fn coordinate(node: Node<'_, '_>, attribute: &'static str) -> Result<i64, XmpuzzleError> {
    let value: i64 = attr(node, "voxel", attribute)?.unwrap_or(0);
    if value.abs() > MAX_COORDINATE {
        return Err(XmpuzzleError::BadAttribute { element: "voxel", attribute, value: value.to_string() });
    }
    Ok(value)
}

/// Parses shape `index` (SPEC Appendix B, shapes): `#` filled, `+` variable, `_` empty, each
/// optionally followed by a colour 1–63, in the order `x + sx·(y + sy·z)`. Whitespace is skipped.
fn parse_shape(node: Node<'_, '_>, index: usize) -> Result<Shape, XmpuzzleError> {
    let mut size = [0i64; 3];
    for (side, attribute) in size.iter_mut().zip(["x", "y", "z"]) {
        *side = required_attr(node, "voxel", attribute)?;
        if *side < 0 {
            return Err(XmpuzzleError::BadAttribute { element: "voxel", attribute, value: side.to_string() });
        }
    }
    if size.iter().any(|&s| s > MAX_SHAPE_SIDE) {
        return Err(XmpuzzleError::ShapeTooLarge { shape: index, size });
    }
    if let Some(kind) = node.attribute("type")
        && kind.trim() != "0"
    {
        return Err(XmpuzzleError::GridType(kind.to_string()));
    }
    let hotspot = [coordinate(node, "hx")?, coordinate(node, "hy")?, coordinate(node, "hz")?];
    let error = |message: String| XmpuzzleError::VoxelText { shape: index, message };
    let total = (size[0] * size[1] * size[2]) as usize;
    let (mut cells, mut count, mut color, mut colored) = (Vec::new(), 0usize, 0u32, false);
    for c in node.text().unwrap_or("").chars() {
        match c {
            '#' | '+' | '_' => {
                if count == total {
                    return Err(error(format!("more than {total} cells")));
                }
                let i = count as i64;
                let cell = [i % size[0], i / size[0] % size[1], i / (size[0] * size[1])];
                if c != '_' {
                    cells.push((cell, c == '+'));
                }
                count += 1;
                color = 0;
            }
            '0'..='9' => {
                if count == 0 {
                    return Err(error("colour before the first cell".to_string()));
                }
                color = color * 10 + c.to_digit(10).unwrap_or(0);
                if color > 63 {
                    return Err(error(format!("colour {color} is larger than 63")));
                }
                colored |= color > 0;
            }
            c if c.is_whitespace() => {}
            c => return Err(error(format!("unexpected character {c:?}"))),
        }
    }
    if count != total {
        return Err(error(format!("{count} cells, expected {total}")));
    }
    Ok(Shape { hotspot, cells, colored })
}

/// Parses a `<problem>` (SPEC Appendix B, problems). Shape ids must be below `shapes`.
fn parse_problem(node: Node<'_, '_>, shapes: &[Node<'_, '_>]) -> Result<Problem, XmpuzzleError> {
    let (mut counts, mut parts, mut groups, mut total) = (Vec::new(), Vec::new(), false, 0u64);
    for shape in child(node, "shapes").into_iter().flat_map(|s| children(s, "shape")) {
        let id: u64 = required_attr(shape, "shape", "id")?;
        let (min, max) = match attr::<u64>(shape, "shape", "count")? {
            Some(count) => (count, count),
            None => match (attr::<u64>(shape, "shape", "min")?, attr::<u64>(shape, "shape", "max")?) {
                (Some(min), Some(max)) if min <= max => (min, max),
                (Some(_), Some(max)) => {
                    return Err(XmpuzzleError::BadAttribute {
                        element: "shape",
                        attribute: "max",
                        value: max.to_string(),
                    });
                }
                _ => (1, 1),
            },
        };
        groups |= shape.attribute("group").is_some() || child(shape, "group").is_some();
        total = total.saturating_add(max);
        let index = usize::try_from(id).ok().filter(|&i| i < shapes.len()).ok_or(XmpuzzleError::UnknownShape(id))?;
        counts.push((index, min, max));
    }
    // The copies are only listed when there are few enough of them.
    if total <= MAX_PIECES as u64 {
        for (index, min, max) in counts {
            let base = match shapes[index].attribute("name") {
                Some(name) if !name.trim().is_empty() => name.trim().to_string(),
                _ => format!("S{}", index + 1),
            };
            for k in 0..max {
                let name = if max > 1 { format!("{base}.{}", k + 1) } else { base.clone() };
                parts.push(Part { shape: index, name, optional_copy: k >= min });
            }
        }
    }
    let result = match child(node, "result") {
        Some(result) => attr::<u64>(result, "result", "id")?,
        None => None,
    };
    let color_pairs = child(node, "bitmap").map_or(0, |b| children(b, "pair").count());
    let solutions: Vec<Node> = child(node, "solutions").into_iter().flat_map(|s| children(s, "solution")).collect();
    let assembly = solutions.first().and_then(|s| child(*s, "assembly")).map(|a| a.text().unwrap_or("").to_string());
    let name = node.attribute("name").unwrap_or("").trim().to_string();
    Ok(Problem { name, pieces: total, parts, result, color_pairs, groups, solutions: solutions.len(), assembly })
}

fn shape_nodes<'a, 'i>(root: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    child(root, "shapes").into_iter().flat_map(|s| children(s, "voxel")).collect()
}

fn problem_nodes<'a, 'i>(root: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    child(root, "problems").into_iter().flat_map(|p| children(p, "problem")).collect()
}

/// Lists the problems of a file without reading its shapes.
pub fn list_problems(bytes: &[u8]) -> Result<Vec<ProblemInfo>, XmpuzzleError> {
    let text = decode(bytes, &mut Vec::new())?;
    let xml = roxmltree::Document::parse(&text).map_err(XmpuzzleError::Xml)?;
    let root = puzzle_root(&xml)?;
    let shapes = shape_nodes(root);
    problem_nodes(root)
        .into_iter()
        .enumerate()
        .map(|(index, node)| {
            let problem = parse_problem(node, &shapes)?;
            Ok(ProblemInfo { index, name: problem.name, pieces: problem.pieces, solutions: problem.solutions })
        })
        .collect()
}

/// Splits a comment into its leading `Name:` and `Designed by:` lines and the rest:
/// `(name, designer, description)`. This is the convention of the BurrTools examples.
fn parse_comment(comment: &str) -> (String, String, String) {
    let (mut name, mut designer) = (String::new(), String::new());
    let mut rest = comment.trim_start();
    loop {
        let (line, tail) = rest.split_once('\n').unwrap_or((rest, ""));
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Name:") {
            name = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("Designed by:") {
            designer = value.trim().to_string();
        } else {
            break;
        }
        rest = tail;
    }
    (name, designer, rest.trim().to_string())
}

/// A piece placement of an assembly: position and transform, `None` for an unplaced piece.
type Placement = Option<(Cell, usize)>;

/// Parses an assembly (SPEC Appendix B, solutions): `x y z t` per piece, or `x`.
fn parse_assembly(text: &str, pieces: usize) -> Result<Vec<Placement>, String> {
    let number = |token: Option<&str>| -> Result<i64, String> {
        let token = token.ok_or("the assembly ends in the middle of a placement")?;
        token
            .parse()
            .ok()
            .filter(|v: &i64| v.abs() <= MAX_COORDINATE)
            .ok_or_else(|| format!("invalid number {token:?} in the assembly"))
    };
    let mut tokens = text.split_whitespace();
    let mut placements = Vec::new();
    while let Some(token) = tokens.next() {
        if placements.len() == pieces {
            return Err(format!("the assembly places more than {pieces} pieces"));
        }
        if token == "x" {
            placements.push(None);
            continue;
        }
        let position = [number(Some(token))?, number(tokens.next())?, number(tokens.next())?];
        let t = number(tokens.next())?;
        let t = usize::try_from(t)
            .ok()
            .filter(|&t| t < ROTATIONS.len())
            .ok_or_else(|| format!("transform {t} is not in 0..{}", ROTATIONS.len()))?;
        placements.push(Some((position, t)));
    }
    if placements.len() != pieces {
        return Err(format!("the assembly places {} pieces, expected {pieces}", placements.len()));
    }
    Ok(placements)
}

/// The cells covered by a shape placed at `position` with transform `t`: `M·(p − h) + X`.
fn place_shape(shape: &Shape, position: Cell, t: usize) -> Vec<Cell> {
    let m = ROTATIONS[t].map(i64::from);
    let h = shape.hotspot;
    shape
        .cells
        .iter()
        .map(|&(p, _)| {
            let d = [p[0] - h[0], p[1] - h[1], p[2] - h[2]];
            [0, 1, 2].map(|r| m[3 * r] * d[0] + m[3 * r + 1] * d[1] + m[3 * r + 2] * d[2] + position[r])
        })
        .collect()
}

/// The cells of each piece in the assembly, `None` for unplaced pieces. Fails when pieces overlap
/// or none is placed.
fn assemble(
    parts: &[Part],
    shapes: &[Option<Shape>],
    placements: &[Placement],
) -> Result<Vec<Option<Vec<Cell>>>, String> {
    let mut seen = HashSet::new();
    let mut placed = Vec::with_capacity(parts.len());
    for (i, (part, placement)) in parts.iter().zip(placements).enumerate() {
        let cells = match (placement, &shapes[part.shape]) {
            (Some((position, t)), Some(shape)) => place_shape(shape, *position, *t),
            _ => {
                placed.push(None);
                continue;
            }
        };
        if let Some(c) = cells.iter().find(|&&c| !seen.insert(c)) {
            return Err(format!("piece {i} overlaps another piece at {c:?}"));
        }
        placed.push(Some(cells));
    }
    if placed.iter().all(Option::is_none) {
        return Err("no piece is placed".to_string());
    }
    Ok(placed)
}

fn bounds64(cells: &[Cell]) -> Option<(Cell, Cell)> {
    let first = *cells.first()?;
    Some(
        cells.iter().fold((first, first), |(lo, hi), c| {
            ([0, 1, 2].map(|a| lo[a].min(c[a])), [0, 1, 2].map(|a| hi[a].max(c[a])))
        }),
    )
}

fn side_lengths((lo, hi): (Cell, Cell)) -> Cell {
    [0, 1, 2].map(|a| hi[a] - lo[a] + 1)
}

/// Shifts cells by `-lo` and sorts them. The caller checks that they fit in `MAX_GRID`.
fn shifted(cells: &[Cell], lo: Cell) -> Vec<Voxel> {
    let mut voxels: Vec<Voxel> = cells.iter().map(|c| [0, 1, 2].map(|a| (c[a] - lo[a]) as i32)).collect();
    voxels.sort_unstable();
    voxels
}

/// Imports problem `problem` of a `.xmpuzzle` file, gzipped or plain (SPEC §2.3). Pieces are the
/// problem's shapes, `count` or `max` copies each; the target is the result shape (`#` required,
/// `+` variable). The first solution places the pieces; without a usable one the result is
/// [`Import::Unplaced`].
///
/// The document is named after the comment's `Name:` line, else the problem name, else
/// `fallback_name` (the web passes the file name without its extension), else "BurrTools puzzle".
pub fn import(bytes: &[u8], problem: usize, fallback_name: &str) -> Result<Import, XmpuzzleError> {
    let mut warnings = Vec::new();
    let text = decode(bytes, &mut warnings)?;
    let xml = roxmltree::Document::parse(&text).map_err(XmpuzzleError::Xml)?;
    let root = puzzle_root(&xml)?;
    let shape_nodes = shape_nodes(root);
    let problems = problem_nodes(root);
    if problems.is_empty() {
        return Err(XmpuzzleError::NoProblem);
    }
    let node = *problems.get(problem).ok_or(XmpuzzleError::ProblemIndex { index: problem, count: problems.len() })?;
    let spec = parse_problem(node, &shape_nodes)?;
    if spec.pieces > MAX_PIECES as u64 {
        return Err(XmpuzzleError::TooManyPieces(spec.pieces));
    }
    if spec.parts.is_empty() {
        return Err(XmpuzzleError::NoPieces);
    }
    let result = match spec.result {
        Some(id) if id < shape_nodes.len() as u64 => Some(id as usize),
        Some(id) => {
            warnings.push(format!("the result shape {id} does not exist; the puzzle has no target"));
            None
        }
        None => {
            warnings.push("the problem has no result shape; the puzzle has no target".to_string());
            None
        }
    };
    // Only the shapes used by the problem are read.
    let mut shapes: Vec<Option<Shape>> = shape_nodes.iter().map(|_| None).collect();
    for index in spec.parts.iter().map(|p| p.shape).chain(result) {
        if shapes[index].is_none() {
            shapes[index] = Some(parse_shape(shape_nodes[index], index)?);
        }
    }
    let piece_shape = |part: &Part| shapes[part.shape].as_ref();
    if let Some(i) = spec.parts.iter().position(|p| piece_shape(p).is_none_or(|s| s.cells.is_empty())) {
        return Err(XmpuzzleError::EmptyPiece(i));
    }
    if spec.groups {
        warnings.push("piece groups are ignored".to_string());
    }
    if spec.color_pairs > 0 || shapes.iter().flatten().any(|s| s.colored) {
        warnings.push("colours and colour constraints are ignored".to_string());
    }
    if spec.parts.iter().filter_map(piece_shape).any(|s| s.cells.iter().any(|c| c.1)) {
        warnings.push("variable cells (+) of pieces are treated as filled".to_string());
    }
    let target: Option<(Vec<Cell>, Vec<Cell>)> = result.and_then(|r| shapes[r].as_ref()).map(|s| {
        let (variable, required): (Vec<&(Cell, bool)>, Vec<_>) = s.cells.iter().partition(|c| c.1);
        (required.into_iter().map(|c| c.0).collect(), variable.into_iter().map(|c| c.0).collect())
    });
    let target = target.filter(|(r, v)| !r.is_empty() || !v.is_empty());

    let comment = child(root, "comment").and_then(|c| c.text()).unwrap_or("");
    let (comment_name, designer, description) = parse_comment(comment);
    let name = match (comment_name.is_empty(), spec.name.is_empty()) {
        (false, false) if problems.len() > 1 => format!("{comment_name} ({})", spec.name),
        (false, _) => comment_name,
        (true, false) => spec.name.clone(),
        (true, true) if !fallback_name.trim().is_empty() => fallback_name.trim().to_string(),
        (true, true) => "BurrTools puzzle".to_string(),
    };
    let meta = Meta { designer, source: SOURCE.to_string(), ..Meta::default() };

    let placed = spec
        .assembly
        .as_deref()
        .map(|text| parse_assembly(text, spec.parts.len()).and_then(|p| Ok((assemble(&spec.parts, &shapes, &p)?, p))));
    let (cells, placements) = match placed {
        Some(Ok(placed)) => placed,
        Some(Err(message)) => {
            warnings.push(format!("the first solution is not usable ({message}); the pieces must be assembled"));
            return unplaced(&spec.parts, &shapes, target, name, description, meta, warnings);
        }
        None => return unplaced(&spec.parts, &shapes, target, name, description, meta, warnings),
    };
    let mirrored: Vec<&str> = spec
        .parts
        .iter()
        .zip(&placements)
        .filter(|(_, p)| p.is_some_and(|(_, t)| t >= 24))
        .map(|(part, _)| part.name.as_str())
        .collect();
    if !mirrored.is_empty() {
        warnings
            .push(format!("pieces {} are mirrored by the solution; they are imported mirrored", mirrored.join(", ")));
    }
    let left_out: Vec<&str> =
        spec.parts.iter().zip(&cells).filter(|(_, c)| c.is_none()).map(|(part, _)| part.name.as_str()).collect();
    if !left_out.is_empty() {
        warnings.push(format!("pieces {} are not used by the solution and were left out", left_out.join(", ")));
    }

    let all: Vec<Cell> =
        cells.iter().flatten().flatten().chain(target.iter().flat_map(|(r, v)| r.iter().chain(v))).copied().collect();
    let (lo, hi) = bounds64(&all).ok_or(XmpuzzleError::NoPieces)?;
    let size = side_lengths((lo, hi));
    if size.iter().any(|&s| s > MAX_GRID as i64) {
        return Err(XmpuzzleError::GridTooLarge(size));
    }
    let pieces = spec
        .parts
        .iter()
        .zip(&cells)
        .filter_map(|(part, cells)| Some((part, cells.as_ref()?)))
        .enumerate()
        .map(|(i, (part, cells))| DocumentPiece {
            id: format!("p{i}"),
            name: part.name.clone(),
            color: piece_color(i).to_string(),
            notchable: false,
            fixed: shifted(cells, lo),
            optional: Vec::new(),
        })
        .collect();
    let document = Document {
        format: FORMAT.to_string(),
        version: VERSION,
        name,
        description,
        grid: size.map(|s| s as i32),
        pieces,
        target: target.map(|(r, v)| Target { required: shifted(&r, lo), variable: shifted(&v, lo) }),
        meta,
    };
    document.validate().map_err(XmpuzzleError::Document)?;
    Ok(Import::Placed(Placed { document, warnings }))
}

/// The pieces and target of a problem without a usable solution, for the assembler.
fn unplaced(
    parts: &[Part],
    shapes: &[Option<Shape>],
    target: Option<(Vec<Cell>, Vec<Cell>)>,
    name: String,
    description: String,
    meta: Meta,
    warnings: Vec<String>,
) -> Result<Import, XmpuzzleError> {
    let mut largest = [1i64; 3];
    let mut pieces = Vec::with_capacity(parts.len());
    for (i, part) in parts.iter().enumerate() {
        let cells: Vec<Cell> = shapes[part.shape].iter().flat_map(|s| s.cells.iter().map(|c| c.0)).collect();
        let bbox = bounds64(&cells).ok_or(XmpuzzleError::EmptyPiece(i))?;
        let size = side_lengths(bbox);
        if size.iter().any(|&s| s > MAX_GRID as i64) {
            return Err(XmpuzzleError::GridTooLarge(size));
        }
        largest = [0, 1, 2].map(|a| largest[a].max(size[a]));
        pieces.push(UnplacedPiece {
            id: format!("p{i}"),
            name: part.name.clone(),
            color: piece_color(i).to_string(),
            voxels: shifted(&cells, bbox.0),
            optional_copy: part.optional_copy,
        });
    }
    let (grid, target) = match target {
        Some((required, variable)) => {
            let all: Vec<Cell> = required.iter().chain(&variable).copied().collect();
            let bbox = bounds64(&all).ok_or(XmpuzzleError::NoPieces)?;
            let size = side_lengths(bbox);
            if size.iter().any(|&s| s > MAX_GRID as i64) {
                return Err(XmpuzzleError::GridTooLarge(size));
            }
            (size, Some(Target { required: shifted(&required, bbox.0), variable: shifted(&variable, bbox.0) }))
        }
        None => (largest, None),
    };
    Ok(Import::Unplaced(Unplaced { name, description, meta, grid: grid.map(|s| s as i32), pieces, target, warnings }))
}

/// Runs the assembler (SPEC §5) on some of the pieces of an unplaced import.
fn assemble_pieces(
    pieces: &[&UnplacedPiece],
    target: &Target,
    options: &AssembleOptions,
) -> Result<AssembleResult, XmpuzzleError> {
    let voxels: Vec<Vec<Voxel>> = pieces.iter().map(|p| p.voxels.clone()).collect();
    crate::assembler::assemble(&voxels, target, options).map_err(XmpuzzleError::Assemble)
}

/// Places the pieces of a problem without a usable solution (SPEC §2.3): runs our assembler (§5)
/// into the target and builds the document from its first disassemblable assembly, each piece in
/// target coordinates. The grid is the target's bounding box.
///
/// When some pieces are optional copies, every piece is tried first, then only the other pieces;
/// a warning names the copies left out. Errors when there is no target, or when no disassemblable
/// assembly is found (the counts of the attempt with every piece are reported).
pub fn place(unplaced: &Unplaced, options: &AssembleOptions) -> Result<Placed, XmpuzzleError> {
    let target = unplaced.target.as_ref().ok_or(XmpuzzleError::NoTarget)?;
    let mut warnings = unplaced.warnings.clone();
    warnings.push("the file has no usable solution, so the pieces were placed by our assembler".to_string());
    let mut used: Vec<&UnplacedPiece> = unplaced.pieces.iter().collect();
    let mut result = assemble_pieces(&used, target, options)?;
    let required: Vec<&UnplacedPiece> = unplaced.pieces.iter().filter(|p| !p.optional_copy).collect();
    if result.first_solution.is_none() && required.len() < used.len() && required.len() >= 2 {
        let retry = assemble_pieces(&required, target, options)?;
        if retry.first_solution.is_some() {
            let dropped: Vec<&str> =
                unplaced.pieces.iter().filter(|p| p.optional_copy).map(|p| p.name.as_str()).collect();
            warnings.push(format!(
                "no assembly uses every piece; the optional copies {} were left out",
                dropped.join(", ")
            ));
            (used, result) = (required, retry);
        }
    }
    let Some(solution) = result.first_solution else {
        return Err(XmpuzzleError::NoSolution {
            assemblies: result.assemblies,
            undecided: result.undecided,
            aborted: result.status == AssembleStatus::Aborted,
        });
    };
    let pieces = used
        .iter()
        .zip(solution)
        .enumerate()
        .map(|(i, (piece, fixed))| DocumentPiece {
            id: format!("p{i}"),
            name: piece.name.clone(),
            color: piece_color(i).to_string(),
            notchable: false,
            fixed,
            optional: Vec::new(),
        })
        .collect();
    let document = Document {
        format: FORMAT.to_string(),
        version: VERSION,
        name: unplaced.name.clone(),
        description: unplaced.description.clone(),
        grid: unplaced.grid,
        pieces,
        target: Some(target.clone()),
        meta: unplaced.meta.clone(),
    };
    document.validate().map_err(XmpuzzleError::Document)?;
    Ok(Placed { document, warnings })
}

/// Escapes XML text and attribute values, dropping control characters other than tab and line ends.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Writes a `<voxel>` shape spanning the box `(lo, hi)`, with `cell` giving each cell's character.
fn write_shape(xml: &mut String, (lo, hi): (Voxel, Voxel), name: &str, cell: impl Fn(Voxel) -> char) {
    let size = [0, 1, 2].map(|a| hi[a] - lo[a] + 1);
    let name = if name.trim().is_empty() { String::new() } else { format!(" name=\"{}\"", escape(name.trim())) };
    xml.push_str(&format!("  <voxel x=\"{}\" y=\"{}\" z=\"{}\"{name} type=\"0\">", size[0], size[1], size[2]));
    for z in lo[2]..=hi[2] {
        for y in lo[1]..=hi[1] {
            for x in lo[0]..=hi[0] {
                xml.push(cell([x, y, z]));
            }
        }
    }
    xml.push_str("</voxel>\n");
}

/// The BurrTools XML of a document (SPEC §2.3), laid out like the BurrTools 0.6.3 writer. Shape 0
/// is the result: the target (`#` required, `+` variable), or the union of the pieces as `#`
/// without one. Shapes 1..=n are the pieces' fixed cells cropped to their bounding boxes. One
/// problem has one solution placing every piece with transform 0 at its position in the document.
/// Name, designer and description go into the comment as `Name:` and `Designed by:` lines.
pub fn export_xml(doc: &Document) -> Result<String, XmpuzzleError> {
    doc.validate().map_err(XmpuzzleError::Document)?;
    if doc.pieces.is_empty() {
        return Err(XmpuzzleError::NoPieces);
    }
    let boxes = doc
        .pieces
        .iter()
        .enumerate()
        .map(|(i, p)| bounds(&p.fixed).ok_or(XmpuzzleError::EmptyPiece(i)))
        .collect::<Result<Vec<_>, _>>()?;
    let union: HashSet<Voxel> = doc.pieces.iter().flat_map(|p| p.fixed.iter().copied()).collect();
    let (required, variable): (HashSet<Voxel>, HashSet<Voxel>) = match &doc.target {
        Some(t) if !t.required.is_empty() || !t.variable.is_empty() => {
            (t.required.iter().copied().collect(), t.variable.iter().copied().collect())
        }
        _ => (union.clone(), HashSet::new()),
    };
    let all: Vec<Voxel> = union.iter().chain(&required).chain(&variable).copied().collect();
    let result = bounds(&all).ok_or(XmpuzzleError::NoPieces)?;

    let mut xml =
        String::from("<?xml version=\"1.0\"?>\n<puzzle version=\"2\">\n <gridType type=\"0\"/>\n <colors/>\n");
    xml.push_str(" <shapes>\n");
    write_shape(&mut xml, result, "Result", |v| {
        if required.contains(&v) {
            '#'
        } else if variable.contains(&v) {
            '+'
        } else {
            '_'
        }
    });
    for (piece, &bbox) in doc.pieces.iter().zip(&boxes) {
        let fixed: HashSet<Voxel> = piece.fixed.iter().copied().collect();
        write_shape(&mut xml, bbox, &piece.name, |v| if fixed.contains(&v) { '#' } else { '_' });
    }
    xml.push_str(" </shapes>\n <problems>\n");
    let name =
        if doc.name.trim().is_empty() { String::new() } else { format!(" name=\"{}\"", escape(doc.name.trim())) };
    xml.push_str(&format!("  <problem{name} state=\"0\">\n   <shapes>\n"));
    for i in 1..=doc.pieces.len() {
        xml.push_str(&format!("    <shape id=\"{i}\" count=\"1\"/>\n"));
    }
    let lo = result.0;
    let assembly: Vec<String> =
        boxes.iter().map(|(p, _)| format!("{} {} {} 0", p[0] - lo[0], p[1] - lo[1], p[2] - lo[2])).collect();
    xml.push_str("   </shapes>\n   <result id=\"0\"/>\n   <bitmap/>\n   <solutions>\n    <solution>\n");
    xml.push_str(&format!("     <assembly>{}</assembly>\n", assembly.join(" ")));
    xml.push_str("    </solution>\n   </solutions>\n  </problem>\n </problems>\n");
    let mut comment = Vec::new();
    if !doc.name.trim().is_empty() {
        comment.push(format!("Name: {}", doc.name.trim()));
    }
    if !doc.meta.designer.trim().is_empty() {
        comment.push(format!("Designed by: {}", doc.meta.designer.trim()));
    }
    if !doc.description.trim().is_empty() {
        comment.push(doc.description.trim().to_string());
    }
    if comment.is_empty() {
        xml.push_str(" <comment/>\n");
    } else {
        xml.push_str(&format!(" <comment>{}</comment>\n", escape(&comment.join("\n"))));
    }
    xml.push_str("</puzzle>\n");
    Ok(xml)
}

/// [`export_xml`], gzip-compressed: the bytes of a `.xmpuzzle` file.
pub fn export(doc: &Document) -> Result<Vec<u8>, XmpuzzleError> {
    let xml = export_xml(doc)?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(xml.as_bytes()).map_err(XmpuzzleError::Gzip)?;
    encoder.finish().map_err(XmpuzzleError::Gzip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solver::{SolveOptions, solve};
    use crate::templates::{known_burr, known_burrs};

    const CUBE_IN_CAGE: &[u8] = include_bytes!("../../../fixtures/xmpuzzle/CubeInCage.xmpuzzle");
    const PELIKAN_BURR: &[u8] = include_bytes!("../../../fixtures/xmpuzzle/PelikanBurr.xmpuzzle");
    const AL_PACKINO: &[u8] = include_bytes!("../../../fixtures/xmpuzzle/AlPackino.xmpuzzle");
    const DRACULA: &[u8] = include_bytes!("../../../fixtures/xmpuzzle/DraculasDentalDesaster.xmpuzzle");
    const MIRROR_PARADOX: &[u8] = include_bytes!("../../../fixtures/xmpuzzle/DemoMirrorParadox.xmpuzzle");

    /// A 6×6×6 box of variable cells, an L tromino (hotspot x = 1) four times and an optional cube.
    const HAND: &str = r#"<?xml version="1.0"?>
<puzzle version="2">
 <gridType type="0"/>
 <colors/>
 <shapes>
  <voxel x="6" y="6" z="6" name="Box" type="0">BOX</voxel>
  <voxel x="2" y="2" z="1" hx="1" name="L" type="0">##_#</voxel>
  <voxel x="1" y="1" z="1" type="0">#</voxel>
 </shapes>
 <problems>
  <problem name="Hand" state="2" assemblies="1" solutions="1" time="0">
   <shapes>
    <shape id="1" count="4"/>
    <shape id="2" min="0" max="1"/>
   </shapes>
   <result id="0"/>
   <bitmap/>
   SOLUTIONS
  </problem>
 </problems>
 <comment>Name: Hand made
Designed by: Tester
Four L trominoes.</comment>
</puzzle>
"#;

    fn hand(assembly: Option<&str>) -> String {
        let solutions = assembly
            .map_or(String::new(), |a| format!("<solutions><solution><assembly>{a}</assembly></solution></solutions>"));
        HAND.replace("BOX", &"+".repeat(216)).replace("SOLUTIONS", &solutions)
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn placed(import: Import) -> Placed {
        match import {
            Import::Placed(p) => p,
            Import::Unplaced(u) => panic!("not placed: {:?}", u.warnings),
        }
    }

    fn unplaced(import: Import) -> Unplaced {
        match import {
            Import::Unplaced(u) => u,
            Import::Placed(p) => panic!("placed: {:?}", p.warnings),
        }
    }

    fn has_warning(warnings: &[String], words: &[&str]) -> bool {
        warnings.iter().any(|w| words.iter().all(|word| w.contains(word)))
    }

    #[test]
    fn rotations_are_the_48_cube_symmetries() {
        let mut seen = HashSet::new();
        for (t, m) in ROTATIONS.iter().enumerate() {
            for i in 0..3 {
                assert_eq!((0..3).map(|j| m[3 * i + j].abs()).sum::<i32>(), 1, "row {i} of {t}");
                assert_eq!((0..3).map(|j| m[3 * j + i].abs()).sum::<i32>(), 1, "column {i} of {t}");
            }
            let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
                + m[2] * (m[3] * m[7] - m[4] * m[6]);
            assert_eq!(det, if t < 24 { 1 } else { -1 }, "{t}");
            assert!(seen.insert(*m), "{t} repeats");
        }
        assert_eq!(ROTATIONS[0], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }

    #[test]
    fn hand_written_assembly_is_placed() {
        let xml = hand(Some("1 1 1 0 4 4 1 5 1 4 4 17 4 1 4 30 x"));
        for bytes in [xml.as_bytes().to_vec(), gzip(xml.as_bytes())] {
            let p = placed(import(&bytes, 0, "").unwrap());
            let doc = &p.document;
            assert_eq!(doc.grid, [6, 6, 6]);
            let names: Vec<&str> = doc.pieces.iter().map(|p| p.name.as_str()).collect();
            assert_eq!(names, ["L.1", "L.2", "L.3", "L.4"]);
            let fixed: Vec<&[Voxel]> = doc.pieces.iter().map(|p| p.fixed.as_slice()).collect();
            assert_eq!(
                fixed,
                [
                    &[[0, 1, 1], [1, 1, 1], [1, 2, 1]][..],
                    &[[3, 4, 1], [4, 4, 0], [4, 4, 1]],
                    &[[1, 3, 4], [1, 4, 4], [1, 4, 5]],
                    &[[4, 0, 4], [4, 1, 4], [4, 1, 5]],
                ]
            );
            let target = doc.target.as_ref().unwrap();
            assert!(target.required.is_empty());
            assert_eq!(target.variable.len(), 216);
            assert_eq!((doc.name.as_str(), doc.description.as_str()), ("Hand made", "Four L trominoes."));
            assert_eq!((doc.meta.designer.as_str(), doc.meta.source.as_str()), ("Tester", SOURCE));
            assert!(has_warning(&p.warnings, &["mirrored", "L.4"]), "{:?}", p.warnings);
            assert!(has_warning(&p.warnings, &["left out", "S3"]), "{:?}", p.warnings);
            assert_eq!(p.warnings.len(), 2, "{:?}", p.warnings);
        }
    }

    #[test]
    fn missing_or_unusable_solutions_give_unplaced_pieces() {
        let u = unplaced(import(hand(None).as_bytes(), 0, "").unwrap());
        assert!(u.warnings.is_empty(), "{:?}", u.warnings);
        assert_eq!(u.grid, [6, 6, 6]);
        assert_eq!(u.name, "Hand made");
        assert_eq!(u.target.as_ref().unwrap().variable.len(), 216);
        let pieces: Vec<(&str, bool)> = u.pieces.iter().map(|p| (p.name.as_str(), p.optional_copy)).collect();
        assert_eq!(pieces, [("L.1", false), ("L.2", false), ("L.3", false), ("L.4", false), ("S3", true)]);
        assert_eq!(u.pieces[0].voxels, [[0, 0, 0], [1, 0, 0], [1, 1, 0]]);
        assert_eq!(u.pieces[4].voxels, [[0, 0, 0]]);
        for assembly in [
            "1 1 1 0",
            "1 1 1 0 1 1 1 0 1 4 4 17 4 1 4 30 x",
            "1 1 1 0 4 4 1 5 1 4 4 17 4 1 4 48 x",
            "1 1 1 0 4 4 1 5 1 4 4 17 4 1 4 x x",
            "x x x x x",
            "1 1 1 0 4 4 1 5 1 4 4 17 4 1 4 30 x 0 0 0 0",
        ] {
            let u = unplaced(import(hand(Some(assembly)).as_bytes(), 0, "").unwrap());
            assert!(has_warning(&u.warnings, &["not usable"]), "{assembly}: {:?}", u.warnings);
            assert_eq!(u.pieces.len(), 5);
        }
    }

    #[test]
    fn known_burrs_round_trip() {
        for key in known_burrs().keys() {
            let doc = known_burr(key).unwrap();
            let p = placed(import(&export(&doc).unwrap(), 0, "").unwrap());
            assert!(p.warnings.is_empty(), "{key}: {:?}", p.warnings);
            let back = p.document;
            assert_eq!(back.grid, doc.grid, "{key}");
            assert_eq!(back.target, doc.target, "{key}");
            assert_eq!(
                (&back.name, &back.meta.designer, &back.description),
                (&doc.name, &doc.meta.designer, &doc.description)
            );
            assert_eq!(back.pieces.len(), doc.pieces.len(), "{key}");
            for (a, b) in back.pieces.iter().zip(&doc.pieces) {
                assert_eq!((&a.id, &a.name, &a.color, &a.fixed), (&b.id, &b.name, &b.color, &b.fixed), "{key}");
                assert!(a.optional.is_empty());
            }
        }
    }

    #[test]
    fn export_without_target_uses_the_union() {
        let mut doc = known_burr(known_burrs().keys().next().unwrap()).unwrap();
        doc.target = None;
        let back = placed(import(&export(&doc).unwrap(), 0, "").unwrap()).document;
        assert_eq!(back.pieces.len(), doc.pieces.len());
        let mut union: Vec<Voxel> = back.pieces.iter().flat_map(|p| p.fixed.iter().copied()).collect();
        union.sort_unstable();
        let target = back.target.unwrap();
        assert_eq!(target.required, union);
        assert!(target.variable.is_empty());
    }

    #[test]
    fn export_matches_the_burrtools_layout() {
        let piece = |id: &str, name: &str, fixed: Vec<Voxel>| DocumentPiece {
            id: id.to_string(),
            name: name.to_string(),
            color: piece_color(0).to_string(),
            notchable: false,
            fixed,
            optional: Vec::new(),
        };
        let doc = Document {
            format: FORMAT.to_string(),
            version: VERSION,
            name: "Tiny <1>".to_string(),
            description: String::new(),
            grid: [3, 2, 1],
            pieces: vec![piece("a", "A", vec![[1, 0, 0], [2, 0, 0]]), piece("b", "B & C", vec![[0, 1, 0]])],
            target: None,
            meta: Meta { designer: "Me".to_string(), ..Meta::default() },
        };
        let expected = r#"<?xml version="1.0"?>
<puzzle version="2">
 <gridType type="0"/>
 <colors/>
 <shapes>
  <voxel x="3" y="2" z="1" name="Result" type="0">_###__</voxel>
  <voxel x="2" y="1" z="1" name="A" type="0">##</voxel>
  <voxel x="1" y="1" z="1" name="B &amp; C" type="0">#</voxel>
 </shapes>
 <problems>
  <problem name="Tiny &lt;1&gt;" state="0">
   <shapes>
    <shape id="1" count="1"/>
    <shape id="2" count="1"/>
   </shapes>
   <result id="0"/>
   <bitmap/>
   <solutions>
    <solution>
     <assembly>1 0 0 0 0 1 0 0</assembly>
    </solution>
   </solutions>
  </problem>
 </problems>
 <comment>Name: Tiny &lt;1&gt;
Designed by: Me</comment>
</puzzle>
"#;
        assert_eq!(export_xml(&doc).unwrap(), expected);
        let back = placed(import(&export(&doc).unwrap(), 0, "").unwrap()).document;
        assert_eq!(back.name, "Tiny <1>");
        let names: Vec<&str> = back.pieces.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["A", "B & C"]);
        assert_eq!(back.pieces[1].fixed, [[0, 1, 0]]);

        let mut empty = doc.clone();
        empty.pieces[1].fixed.clear();
        assert!(matches!(export(&empty), Err(XmpuzzleError::EmptyPiece(1))));
        empty.pieces.clear();
        assert!(matches!(export(&empty), Err(XmpuzzleError::NoPieces)));
        empty.format = "x".to_string();
        assert!(matches!(export(&empty), Err(XmpuzzleError::Document(_))));
    }

    #[test]
    fn burrtools_examples_import() {
        let cases: [(&str, &[u8], usize, &[&str]); 4] = [
            ("CubeInCage", CUBE_IN_CAGE, 6, &["groups"]),
            ("Pelikan Burr", PELIKAN_BURR, 7, &[]),
            ("AlPackino", AL_PACKINO, 13, &[]),
            ("Dracula", DRACULA, 9, &["colour"]),
        ];
        for (label, bytes, count, warnings) in cases {
            let problems = list_problems(bytes).unwrap();
            assert_eq!(problems.len(), 1, "{label}");
            assert_eq!((problems[0].pieces, problems[0].solutions > 0), (count as u64, true), "{label}");
            let p = placed(import(bytes, 0, "").unwrap());
            assert_eq!(p.warnings.len(), warnings.len(), "{label}: {:?}", p.warnings);
            for word in warnings {
                assert!(has_warning(&p.warnings, &[word]), "{label}: {:?}", p.warnings);
            }
            let doc = &p.document;
            assert_eq!(doc.pieces.len(), count, "{label}");
            doc.validate().unwrap();
            doc.to_puzzle().unwrap_or_else(|e| panic!("{label}: {e}"));
            let union: HashSet<Voxel> = doc.pieces.iter().flat_map(|p| p.fixed.iter().copied()).collect();
            let target = doc.target.as_ref().unwrap();
            assert!(target.required.iter().all(|v| union.contains(v)), "{label}");
            let allowed: HashSet<Voxel> = target.required.iter().chain(&target.variable).copied().collect();
            assert!(union.iter().all(|v| allowed.contains(v)), "{label}");
            assert_eq!(doc.meta.source, SOURCE);
            assert!(!doc.meta.designer.is_empty(), "{label}");
            let again = placed(import(&export(doc).unwrap(), 0, "").unwrap());
            assert!(again.warnings.is_empty(), "{label}: {:?}", again.warnings);
            assert_eq!(&again.document, doc, "{label}");
        }
        let doc = placed(import(PELIKAN_BURR, 0, "").unwrap()).document;
        assert_eq!((doc.name.as_str(), doc.meta.designer.as_str()), ("Pelikan Burr", "Dic Sonneveld"));
        assert_eq!(doc.grid, [8, 8, 8]);
        let doc = placed(import(CUBE_IN_CAGE, 0, "").unwrap()).document;
        assert_eq!(doc.meta.designer, "Mineyuki Uyematsu");
    }

    #[test]
    fn mirror_paradox_has_no_solution() {
        let problems = list_problems(MIRROR_PARADOX).unwrap();
        let summary: Vec<(&str, u64, usize)> =
            problems.iter().map(|p| (p.name.as_str(), p.pieces, p.solutions)).collect();
        assert_eq!(summary, [("Example From Text", 4, 0), ("Another Example", 5, 0)]);
        let u = unplaced(import(MIRROR_PARADOX, 0, "").unwrap());
        assert_eq!(u.pieces.len(), 4);
        assert!(u.pieces.iter().all(|p| p.optional_copy));
        assert_eq!(u.grid, [3, 3, 2]);
        let target = u.target.as_ref().unwrap();
        assert_eq!((target.required.len(), target.variable.len()), (10, 0));
        assert_eq!(u.name, "Example From Text");
        let json = serde_json::to_value(Import::Unplaced(u)).unwrap();
        assert_eq!(json["kind"], "unplaced");
        assert_eq!(json["pieces"][0]["optionalCopy"], true);
        let u = unplaced(import(MIRROR_PARADOX, 1, "").unwrap());
        assert_eq!(u.pieces.len(), 5);
        assert_eq!(u.grid, [3, 3, 3]);
    }

    #[test]
    fn placed_json_is_tagged() {
        let json = serde_json::to_value(import(PELIKAN_BURR, 0, "").unwrap()).unwrap();
        assert_eq!(json["kind"], "placed");
        assert_eq!(json["document"]["format"], FORMAT);
        assert!(json["warnings"].is_array());
    }

    #[test]
    fn latin1_files_are_read() {
        let xml = hand(None).replace("Hand made", "Caf\u{e9}");
        let bytes: Vec<u8> = xml.chars().map(|c| c as u8).collect();
        let u = unplaced(import(&bytes, 0, "").unwrap());
        assert_eq!(u.name, "Caf\u{e9}");
        assert!(has_warning(&u.warnings, &["Latin-1"]));
    }

    #[test]
    fn bad_files_are_errors() {
        let error = |bytes: &[u8]| import(bytes, 0, "").unwrap_err();
        assert!(matches!(error(&[0x1f, 0x8b, 0x08, 0, 1, 2, 3]), XmpuzzleError::Gzip(_)));
        assert!(matches!(error(b"<puzzle"), XmpuzzleError::Xml(_)));
        assert!(matches!(error(b"<shapes/>"), XmpuzzleError::NotAPuzzle(_)));
        assert!(matches!(error(br#"<puzzle version="3"/>"#), XmpuzzleError::Version(_)));
        assert!(matches!(error(b"<puzzle/>"), XmpuzzleError::MissingAttribute { .. }));
        assert!(matches!(error(br#"<puzzle version="2"><gridType type="3"/></puzzle>"#), XmpuzzleError::GridType(_)));
        assert!(matches!(error(br#"<puzzle version="2"><shapes/></puzzle>"#), XmpuzzleError::NoProblem));
        assert!(matches!(
            import(hand(None).as_bytes(), 1, ""),
            Err(XmpuzzleError::ProblemIndex { index: 1, count: 1 })
        ));
        let shapes = |result: &str, piece: &str, assembly: &str| {
            format!(
                r#"<puzzle version="2"><shapes>{result}{piece}</shapes><problems><problem><shapes><shape id="1" count="1"/></shapes><result id="0"/><solutions><solution><assembly>{assembly}</assembly></solution></solutions></problem></problems></puzzle>"#
            )
        };
        let cube = r#"<voxel x="1" y="1" z="1" type="0">#</voxel>"#;
        let long = format!(r#"<voxel x="40" y="1" z="1" type="0">{}</voxel>"#, "#".repeat(40));
        assert!(matches!(error(shapes(&long, cube, "0 0 0 0").as_bytes()), XmpuzzleError::GridTooLarge([40, 1, 1])));
        assert_eq!(placed(import(shapes(cube, cube, "0 0 0 0").as_bytes(), 0, "").unwrap()).document.grid, [1, 1, 1]);
        let huge = r#"<voxel x="200" y="1" z="1" type="0">#</voxel>"#;
        assert!(matches!(
            error(shapes(cube, huge, "0 0 0 0").as_bytes()),
            XmpuzzleError::ShapeTooLarge { shape: 1, .. }
        ));
        for text in ["##", "", "#a", "#64", "3#"] {
            let piece = format!(r#"<voxel x="1" y="1" z="1" type="0">{text}</voxel>"#);
            assert!(
                matches!(error(shapes(cube, &piece, "0 0 0 0").as_bytes()), XmpuzzleError::VoxelText { shape: 1, .. }),
                "{text:?}"
            );
        }
        let negative = r#"<voxel x="-1" y="1" z="1" type="0"></voxel>"#;
        assert!(matches!(error(shapes(cube, negative, "").as_bytes()), XmpuzzleError::BadAttribute { .. }));
        let empty = r#"<voxel x="1" y="1" z="1" type="0">_</voxel>"#;
        assert!(matches!(error(shapes(cube, empty, "").as_bytes()), XmpuzzleError::EmptyPiece(0)));
        let many = hand(None).replace(r#"count="4""#, r#"count="40""#);
        assert!(matches!(error(many.as_bytes()), XmpuzzleError::TooManyPieces(41)));
        assert_eq!(list_problems(many.as_bytes()).unwrap()[0].pieces, 41);
        let unknown = hand(None).replace(r#"id="2""#, r#"id="9""#);
        assert!(matches!(error(unknown.as_bytes()), XmpuzzleError::UnknownShape(9)));
        let error = error(&[0x1f, 0x8b, 0x08, 0, 1, 2, 3]);
        assert!(std::error::Error::source(&error).is_some());
        assert!(!error.to_string().is_empty());
    }

    #[test]
    fn unnamed_files_take_the_fallback_name() {
        let unnamed = hand(None).replace("Name: Hand made", "").replace(r#" name="Hand""#, "");
        for (fallback, name) in
            [("my burr", "my burr"), ("  spaced \t", "spaced"), ("", "BurrTools puzzle"), (" \t", "BurrTools puzzle")]
        {
            assert_eq!(unplaced(import(unnamed.as_bytes(), 0, fallback).unwrap()).name, name, "{fallback:?}");
        }
        let problem_named = hand(None).replace("Name: Hand made", "");
        assert_eq!(unplaced(import(problem_named.as_bytes(), 0, "file").unwrap()).name, "Hand");
        assert_eq!(unplaced(import(hand(None).as_bytes(), 0, "file").unwrap()).name, "Hand made");
    }

    /// Strips the `<solutions>` element of an exported file.
    fn without_solutions(xml: &str) -> String {
        let start = xml.find("<solutions>").unwrap();
        let end = xml.find("</solutions>").unwrap() + "</solutions>".len();
        format!("{}{}", &xml[..start], &xml[end..])
    }

    #[test]
    fn unsolved_files_are_placed_by_the_assembler() {
        let fixtures = known_burrs();
        for key in ["abad_level_9", "abad_4_8"] {
            let xml = without_solutions(&export_xml(&known_burr(key).unwrap()).unwrap());
            let u = unplaced(import(xml.as_bytes(), 0, "").unwrap());
            assert!(u.warnings.is_empty(), "{key}: {:?}", u.warnings);
            let p = place(&u, &AssembleOptions::default()).unwrap();
            assert_eq!(p.warnings.len(), 1, "{key}: {:?}", p.warnings);
            assert!(has_warning(&p.warnings, &["placed by our assembler"]), "{key}: {:?}", p.warnings);
            let doc = &p.document;
            assert_eq!(doc.pieces.len(), 6, "{key}");
            assert_eq!(
                (doc.name.as_str(), doc.grid, doc.target.as_ref()),
                (u.name.as_str(), u.grid, u.target.as_ref())
            );
            let names: Vec<&str> = doc.pieces.iter().map(|p| p.name.as_str()).collect();
            assert_eq!(names, u.pieces.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), "{key}");
            for (piece, original) in doc.pieces.iter().zip(&u.pieces) {
                assert_eq!(piece.fixed.len(), original.voxels.len(), "{key}");
            }
            let solution = solve(&doc.to_puzzle().unwrap(), &SolveOptions::default()).solution.unwrap();
            let computed = &fixtures[key].computed;
            assert_eq!(solution.level, computed.first_split_moves, "{key}");
            assert_eq!(solution.level_string, computed.level_string, "{key}");
            let json = serde_json::to_value(&p).unwrap();
            assert_eq!(json["document"]["pieces"].as_array().unwrap().len(), 6);
            assert!(json["warnings"].is_array());
        }
    }

    #[test]
    fn placing_needs_a_target_and_an_assembly() {
        let xml = hand(None).replace(r#"<result id="0"/>"#, "");
        let u = unplaced(import(xml.as_bytes(), 0, "").unwrap());
        assert!(u.target.is_none());
        let error = place(&u, &AssembleOptions::default()).unwrap_err();
        assert!(matches!(error, XmpuzzleError::NoTarget), "{error}");
        assert!(error.to_string().contains("no result shape"), "{error}");

        let cube = |i: usize, optional_copy: bool| UnplacedPiece {
            id: format!("p{i}"),
            name: format!("cube {i}"),
            color: piece_color(i).to_string(),
            voxels: vec![[0, 0, 0]],
            optional_copy,
        };
        let target = Target { required: vec![[0, 0, 0], [1, 0, 0], [2, 0, 0]], variable: Vec::new() };
        let mut u = Unplaced {
            name: "Cubes".to_string(),
            description: String::new(),
            meta: Meta::default(),
            grid: [3, 1, 1],
            pieces: vec![cube(0, false), cube(1, false)],
            target: Some(target),
            warnings: vec!["kept".to_string()],
        };
        let error = place(&u, &AssembleOptions::default()).unwrap_err();
        assert!(matches!(error, XmpuzzleError::NoSolution { assemblies: 0, .. }), "{error}");
        assert!(error.to_string().contains("no disassemblable assembly"), "{error}");

        // Three cubes fill the target only with the optional copy.
        u.pieces.push(cube(2, true));
        let p = place(&u, &AssembleOptions::default()).unwrap();
        assert_eq!(p.document.pieces.len(), 3);
        assert_eq!(p.warnings.len(), 2, "{:?}", p.warnings);
        assert_eq!(p.warnings[0], "kept");

        // Two cubes fill the target only without it: the copy is left out with a warning.
        let target = Target { required: vec![[0, 0, 0], [1, 0, 0]], variable: Vec::new() };
        u.target = Some(target.clone());
        u.grid = [2, 1, 1];
        let p = place(&u, &AssembleOptions::default()).unwrap();
        let fixed: Vec<&[Voxel]> = p.document.pieces.iter().map(|p| p.fixed.as_slice()).collect();
        assert_eq!(fixed.len(), 2);
        assert!(fixed.contains(&&[[0, 0, 0]][..]) && fixed.contains(&&[[1, 0, 0]][..]), "{fixed:?}");
        assert_eq!(p.document.target, Some(target));
        assert!(has_warning(&p.warnings, &["optional copies", "cube 2"]), "{:?}", p.warnings);
        assert_eq!(p.warnings.len(), 3, "{:?}", p.warnings);
    }
}
