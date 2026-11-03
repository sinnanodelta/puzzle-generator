# Puzzle Generator — Specification

Status: confirmed 2026-10-29. Replaces `legacy/puzzle_generator.py`.

A browser app to **create and edit** voxel-based interlocking puzzles, **generate** harder puzzles by adding voxels to a base while keeping it solvable, and **visualize** the disassembly. The heavy computation (solver, generator, assembler) is a Rust core compiled to WebAssembly and run in Web Workers. The only server code is one small function that stores the shared library (§2.2).

---

## 1. Puzzle model

| Item | Rule |
|---|---|
| Grid | Cubic voxels. The shared assembly grid is up to 32×32×32 cells. |
| Pieces | 2 to ~16 pieces. A piece is a set of voxels and has a name and a colour. |
| Valid piece | Face-connected. The editor warns about a disconnected piece. The generator only records results in which every piece is connected (§4.2). |
| Assembled state | Pieces are edited in place in the shared grid. A cell holds at most one piece in a given state. |
| Motion | Translations along ±X, ±Y, ±Z only. No rotations. |

### 1.1 Moves, level, solvability

- **Move.** A group of one or more pieces is translated in one axis direction by any whole distance, with no collision along the way. This counts as one move (BurrTools convention). Moving a group S by +k is the same relative state as moving its complement by −k, so states are normalized (§3.1).
- **Separation.** A move that sends a group to infinity without collision. It splits the current part into exactly two parts: the removed group and the remaining group. The separating move counts as a move.
- **Solvable.** The puzzle disassembles recursively into single pieces. Each part with two or more pieces must itself be solvable.
- **Level.** The smallest number of moves, from the assembled state, to a separation after which *both* parts are solvable.
  - If a separation leaves an unsolvable part, the whole puzzle is unsolvable, so the search stops there, as BurrTools does.
  - Why: restricting a disassembly of the whole puzzle to some of its pieces gives a disassembly of those pieces, and every move is reversible, so every reachable state is as solvable as the start.
- **Level string.** Formatted like BurrTools `movesText2`, for example `9.3` or `10.4.2`:
  - first, the number of moves of the root separation;
  - then `.` followed by the string of the *remaining* part's subtree;
  - then `.` followed by the string of the *removed* part's subtree;
  - a subtree is printed only if it contains at least one separation needing 2 or more moves.
- **Total moves.** The sum of the moves of every separation in the full disassembly tree that the solver returns.
- **Sub-problems.** Each part is solved the same way (shortest successful separation first). Ties at equal depth are broken deterministically: the first one in canonical enumeration order wins.

### 1.2 Monotonicity (used everywhere)

Adding a voxel to a piece can only remove valid states and moves, never create them. So:

- If adding a voxel makes the puzzle unsolvable, every superset containing that voxel is unsolvable too.
- As long as the puzzle stays solvable, adding voxels never decreases the level.

Exception: a check that is aborted by the state cap (§3.3) proves nothing. The generator treats it as a rejection anyway.

### 1.3 Per-piece voxel states (editor and generator)

| State | Meaning |
|---|---|
| **fixed** | Always part of the piece. A cell is fixed for at most one piece. |
| **optional** | The generator may add it to the piece. A cell can be optional for several pieces; the generator assigns it to at most one. A cell that is fixed for some piece cannot be optional for another. |
| **empty** | Not part of the piece. |

The solver and the viewer only see fixed voxels plus the optional voxels the generator added. In the editor, the live check uses fixed voxels only.

### 1.4 Piece flags and badges

- **Must stay notchable** (per-piece toggle, for woodworking). BurrTools `isNotchable`: the piece equals the intersection of the extrusions of its three axis projections. The generator keeps flagged pieces notchable (§4.2). If a flagged piece's *fixed* base is not notchable, the editor shows a warning and the generator refuses to start.
- **Badges** shown per piece:
  - *notchable* (definition above);
  - *millable*: BurrTools `isMillable`. It fails if some empty voxel has a filled neighbour on the X axis, *and* one on the Y axis, *and* one on the Z axis.

---

## 2. Data formats

### 2.1 Native JSON (library and file import/export)

```json
{
  "format": "puzzle-generator",
  "version": 1,
  "name": "Piston",
  "description": "",
  "grid": [6, 6, 6],
  "pieces": [
    {
      "id": "p0",
      "name": "A",
      "color": "#e6194b",
      "notchable": false,
      "fixed":    [[0, 2, 2], [1, 2, 2]],
      "optional": [[2, 2, 2]]
    }
  ],
  "target": { "required": [[0, 0, 0]], "variable": [] },
  "meta": { "designer": "", "source": "", "created": "", "updated": "" }
}
```

- Coordinates are integers in `[0, grid)`.
- `target` is `null` when no target is painted, which disables the uniqueness check.
- Generator results are saved as plain puzzles: added voxels become fixed, and the unused optional cells are kept as optional so the result can be re-generated.

### 2.2 Library

- **Shared.** One library for every device, in a private Vercel Blob store behind one Vercel Function, `/api/library` (§9.2). Everyone can read it. Saving, renaming, moving and deleting need the library password: it is asked once per device and kept in the browser's local storage (Lock forgets it). The function compares it with its `LIBRARY_PASSWORD` environment variable.
- **Blob layout.**
  - `library/index.json` holds the folders and, per puzzle, what the views need: id, revision, name, folder, status, level string, moves, uniqueness, grid, piece and voxel counts, designer, source, dates. It also holds a compact shape: per piece, its colour and base-32 voxel coordinates, which is enough for thumbnails and ratings.
  - Each document (§2.1) is `library/docs/<id>/<rev>.json`. A save writes a new revision and deletes the old one.
- **API.**
  - `GET` returns `{etag, index}`. `GET ?since=<etag>` returns `{etag, unchanged: true}` when nothing changed.
  - `GET ?doc=<id>&rev=<rev>` returns a document. It never changes, so the browser caches it.
  - `POST {base, ops, docs}` with `Authorization: Bearer <password>` returns `{etag, revs}`, plus `index` only when another device changed the index after `base`. The operations are `put` (with its document), `meta` (results only), `move`, `delete`, `addFolder`, `moveFolder` and `deleteFolder`.
  - The server reads the index and applies the operations, with the same code as the browser (`web/shared/library-index.js`). It writes the index only if it is unchanged (ETag condition), else it retries against the latest index up to eight times with backoff. Concurrent changes are all kept; the last write wins per puzzle. If the index keeps changing, it returns `409` so the client can retry instead of reporting an internal server error.
- **Traffic.**
  - Opening the library sends one request: about 100 bytes when nothing changed.
  - A document is downloaded when it is first opened: once per revision per device.
  - Thumbnails are drawn in the browser from the index and cached.
  - A save uploads the document and its entry: a few kB, plus 1 read and 2 writes of Blob.
- **This device.** IndexedDB keeps a copy of the shared index, the documents opened and the thumbnails, so the library opens offline, read-only.
  - It also holds a library of this device: puzzles saved offline or without the password, and the library of earlier versions, which is moved there once. The Library offers to upload them; uploaded puzzles leave this device.
  - Without the API (`npm run dev`, or a host without the function or without a Blob store), the library is kept in this browser only, and a notice says so.
- **Results.** The editor's check and the generator's uniqueness count update their entry without asking for the password. Without the password, or offline, they are not kept.
- **Folders.**
  - Folders nest (`a/b/c`, up to 12 levels). They can be created, renamed, moved and deleted; a folder with content is deleted with it, after a confirmation.
  - Puzzles and folders move with Move…, or by dragging them onto a folder or onto the path.
  - A new puzzle (saved, imported) goes into the folder shown.
- **Views.**
  - Two views: cards with thumbnails, or a table. A search box looks in names, folders, levels, sources and designers.
  - The table sorts by any column and filters per column: text, numbers (`>5`, `3..8`), dates, uniqueness. Any column can be hidden.
  - The columns are: thumbnail, name, folder, level, moves, uniqueness, rating with its two halves (§4.4), pieces, voxels, grid, source, designer, created and updated.
  - "Subfolders" also lists the puzzles of the subfolders; a search always does.
  - Selected puzzles can be moved, deleted or uploaded together.
- Every entry can be exported (§2.1, §2.3, §2.4), and JSON or BurrTools files can be imported.

### 2.3 BurrTools `.xmpuzzle` (cube grid only)

The format reference is in Appendix B.

- **Import.**
  - Pick a problem when the file has several.
  - Pieces come from the problem's shapes; `count > 1` creates duplicate pieces.
  - The target comes from the result shape: `#` = required, `+` = variable.
  - Pieces are placed using the first solution's assembly.
  - If the file has no solution, the app runs our assembler (§5) and uses the first disassemblable assembly. If there is none, it reports an error.
    - Copies beyond a shape's `min` count are *optional copies*. The assembler first tries every piece, then only the other pieces; a warning names the copies left out. Other subsets are not tried.
    - A problem without a result shape cannot be assembled: error.
    - A warning says that the pieces were placed by our assembler.
  - The document is named after the comment's `Name:` line, else the problem name, else the file name without its extension, else "BurrTools puzzle".
  - Colour constraints are ignored, with a warning.
- **Export.**
  - One problem.
  - Each piece becomes a shape cropped to its bounding box.
  - The result shape is the target, or the union of all pieces if there is no target.
  - One solution, whose assembly places every piece with transform 0.
  - The file is gzip-compressed.

### 2.4 STL export

- Options:
  - **unit size** in mm per voxel;
  - **clearance** `c` in mm: *every* boundary face of the piece moves inward by `c`, including outer faces, so two touching faces end up `2c` apart;
  - **chamfer** in mm on convex edges.
- Output: a zip with one binary STL per piece, named after the piece.
- Clearance is an exact erosion by an axis-aligned cube of half-size `c`. Implementation: split each voxel into 3×3×3 slabs `[0,c] [c,1−c] [1−c,1]`. A sub-cell is kept only if every voxel its slab touches is filled.
- Meshes must be watertight. Coplanar faces are merged. At `c = 0`, vertices are duplicated along non-manifold edges.
- **Chamfer** (leg `r`, 45°, `0 ≤ r < (unit − 2c)/2`): each kept sub-cell is a box, cut by
  - a bevel `u + v ≥ r` along each box edge whose two face neighbours (across the two faces of the edge) are not kept, where `u` and `v` are the distances to those faces;
  - a corner cut `u + v + w ≥ 2r` at each box corner whose three face neighbours are not kept.

  Only convex edges and corners are cut; concave edges stay sharp. Bevels only cross centre slabs, which are wider than `2r`, so every cut stays inside its sub-cell.
- **Exact arithmetic.** Coordinates are integers on a lattice of `12·2^20` units per voxel. `c` and `r` are rounded to multiples of 12 units, and lowered by one step if rounding breaks a bound. Every vertex is then a lattice point.
- **Mesh pipeline.**
  1. Emit the boundary faces of the union of the cut sub-cells.
  2. Insert T-junction vertices into edges.
  3. Merge coplanar faces into convex polygons.
  4. Drop straight-angle vertices.
  5. Triangulate.
  6. At non-manifold vertices, give each solid wedge its own vertex copy; at non-manifold edges, split each wedge pair at the edge's midpoint.
  7. Translate the bounding box to the origin and scale to mm.
- **Check:** a box of `a×b×c` units with chamfer `r` has volume `abc − 2r²(a+b+c) + 16r³/3`.

---

## 3. Solver (Rust core)

### 3.1 State and moves

- **State.** One integer offset per piece of the current part, normalized by subtracting the offset of the lowest-index piece. Visited states go in a hash set.
- **Collision cache.** Piece `i` at relative offset `δ` collides with piece `j` if `δ ∈ V_j ⊖ V_i` (difference set). For each ordered pair and each direction, `D_d(i,j)` is the first collision distance (∞ if there is none). These values come from a per-pair cache built once per solve.
- **Movable groups for direction d.**
  - A group is movable by 1 if it is closed under the relation `i → j` defined by `D_d(i,j) = 1`.
  - Compute the closure bitmask of every piece. The movable groups are all unions of closures, deduplicated, excluding the full set.
  - Any group that can move k units can also move 1 unit, so this enumeration is complete.
  - For each group `S`: `m_S = min over i∈S, j∉S of D_d(i,j) − 1`.
  - If `m_S = ∞`, the move is a separation. Otherwise there is one move per `k = 1..m_S`.
- **Search.**
  - BFS by layers from the assembled state. When a separation is reached at depth `t`, both parts are solved recursively.
  - The first separation, in BFS order, whose two parts are both solvable gives the level `t`.
  - A separating state is still expanded through its non-separating moves.
- **Output.** Solvable or not, level, level string, total moves, and the full disassembly tree. Every node has its move list (group, direction, distance), so the viewer can replay it.

### 3.2 API (core crate, exposed to WASM)

- `solve(puzzle, options) -> SolveResult`, where `options` contains `max_states`.
- `is_notchable(piece)`, `is_millable(piece)`.
- `canonical_key(puzzle) -> bytes`. The key is the same for any whole-assembly rotation (24, no mirrors) and any relabelling of pieces. It is used for leaderboard deduplication.

### 3.3 State cap

Each check has a configurable cap on the number of explored states, summed over the recursion. When the cap is exceeded, the result is `Aborted`:

- the editor shows "Gave up after N states";
- the generator rejects the candidate.

### 3.4 Live check (editor)

- Runs automatically, debounced, in a dedicated worker.
- Cancelling terminates the worker and starts a new one.
- The status bar shows `Solvable — level 9.3`, `Not solvable`, `Gave up (cap)` or `computing…`.

---

## 4. Generator

### 4.1 Goal

Add optional voxels to the base so as to maximize the **level**. Ties are broken by more **total moves**.

### 4.2 Search

Candidates are the `(cell, piece)` pairs where the cell is optional for that piece.

**Adding a candidate.**

- The cell must be free: not already given to another piece.
- The cell must share a face with a voxel of the piece. Otherwise the candidate waits for the next sweep, since the piece may have grown to touch it by then. A piece that starts in one part therefore stays in one part. No connected result is lost: a connected piece can be grown from its base one touching cell at a time, and every intermediate puzzle is a subset of a solvable puzzle, so it is solvable.
- If the piece is flagged *notchable*, the added set is `I(P ∪ {cell}) \ P`, where `I` is the intersection of the extrusions of the three projections. `I` is idempotent, so the result is notchable. Every cell in the added set must be optional for this piece and free; otherwise the candidate is skipped.
- The puzzle is re-solved with the cap. If it is still solvable, the voxels are kept. If not, the candidate is dead for the rest of this pass (by monotonicity).

**Greedy pass.** Shuffle the candidates with the seeded RNG and try each one in order. Then sweep again over the candidates that were waiting, as long as the previous sweep added something. The result is a maximal solvable set.

**Iterated local search.**

1. From the current solution, remove `r` added voxels at random, with `r ∈ [1, R]` configurable. For a piece that is not notchable, the added voxels that no longer connect to its base voxels are removed too.
2. Clear the dead marks and run a new greedy pass.
3. Accept the result if its score is equal or better (equal allows plateau moves).
4. Restart from the bare base after `N` iterations without improvement (configurable), or when auto tuning says so.

**Auto tuning** (default on) replaces `R` and `N`. `R` is 12. The restart rule counts checks, not passes: a climb from the base may go without improvement for twice the checks it took to reach its last improvement, and for at least two passes from the base (measured on the last one). A climb that keeps improving (sparse designs) seldom restarts; one that stalls early (dense targets) restarts after a few passes' worth of checks. The rule depends only on the check counts, so a run still depends only on the base, the options and the seed. Mean best level (with moves/100) after 60 s, 8 seeds:

| Design | R 3, N 30 | R 10, N 100 | Auto | Never restart (R 10) |
|---|---|---|---|---|
| Seeds (sparse) | 2.83 | 7.01 | 16.34 | 18.48 |
| Shell | 2.32 | 6.01 | 12.16 | 14.88 |
| Burr template | 6.38 | 7.88 | 9.78 | 8.89 |
| Burr template, notchable | 7.11 | 7.62 | 8.88 | 7.88 |
| Burr, all optional, cube target, fill target first (best without holes) | 5.64 | 8.17 | 8.79 | 6.51 |

No check reached the cap in these runs, so it stays at 100,000.

**Recording.** A result is recorded only if every piece is face-connected. Pieces can still be disconnected during the search: a template's base can start in two parts, and a notch closure or the removal of a line can split a notchable piece.

**Ranking.** Pass results compare the number of parts first, counting the face-connected parts beyond one per piece; fewer is better. So a result with a disconnected piece ranks below every connected result, whatever its level, and from a base in two parts the search moves towards connected results. Among results with the same number of parts, the score decides.

**Joining split pieces.** At the end of a pass, each piece still in several parts (not notchable) gets a cheapest bridge from the part of its first voxel to another part, through cells optional for it: an empty cell costs 1, a voxel another piece added costs 2 (taken only if that piece doesn't split). The bridge stays when the puzzle is still solvable, and the piece is bridged again while it has several parts. Empty cells touching the piece were already rejected during the pass, so most bridges take cells from other pieces. On the solid burr test base, this nearly doubles the puzzles found without holes.

**Holes.** The holes of a result are the *required* target cells (§5) that no piece fills. Without a target, a result has no holes. With **fill target first** enabled, holes come between the parts and the score: fewer is better. The search then heads for puzzles that fill the target, even at a lower level.

**Settings.** Seed, check cap (default 100,000 states, lower than the editor's), auto tuning (default on), `R` (default 10) and `N` (default 100; 0 never restarts) when auto tuning is off, worker count, time limit, target level, fill target first (default off; needs required target cells), and keep the screen on (§4.3).

### 4.3 Execution

- One Web Worker per logical core minus one (19 on the development machine), at most 4 on touch screens: each worker's memory makes a mobile browser more likely to discard the page. Each worker runs the generator in WASM with seed `baseSeed + workerIndex`.
- Workers stream results (puzzle and score) to the main thread.
- Stops: manual; optional time limit; optional target level (stops when any worker reaches it; with fill target first, only puzzles without holes count).

**In the background.** Browsers don't guarantee that a hidden page keeps computing: they throttle it, freeze it (Chrome's Energy Saver freezes CPU-heavy background tabs; a site can be exempted in its performance settings) or discard it, mostly on mobile. So:

- **Keep the screen on** (default on): a screen wake lock while a run is active and the page visible. The browser drops it when the page is hidden; it is taken again when the page shows.
- The run (settings, base, leaderboards, uniqueness results, saved entries, counters) is saved to IndexedDB every 5 s, when the page is hidden or closed, and when the run stops. A hidden page's timers may run only once a minute, so a discard can lose about that much of the run.
- At startup, the last run is restored. If it was running, it resumes: the workers start again from the bare base with seeds `baseSeed + workerIndex + resumes × workers`, so they explore new paths. The leaderboards, counters and elapsed time continue, and the interrupted uniqueness checks are queued again. A resumed run is not the run it would have been without the interruption.
- The running tab holds a Web Lock; a second tab that finds it held shows the run stopped instead of running it twice.

### 4.4 Generator UI

- **Live leaderboard** of the 20 best distinct puzzles, deduplicated by `canonical_key`. Each entry shows its level string, total moves and uniqueness badge. Once a puzzle has holes, every entry also shows its number of holes.
- The run also keeps the 20 best puzzles without holes, even when they rank lower. With required target cells, a **target filled only** filter shows those instead, best first. It can be switched at any time, and the uniqueness checks follow the list shown.
- **Rating** (0–100) of each entry: half for balanced piece sizes (1 − the coefficient of variation of the voxel counts), half for 3D printing without supports (per piece, the share of voxels on the bed or on another voxel with the best face down, averaged). **One per level** keeps only the best rated entry of each level string; **sort by rating** orders the list by rating, then by score.
- **Counters:** elapsed time, checks (per second, total, share that reached the cap), passes, restarts, workers, best level; with required target cells, the best level without holes; the number of resumes.
- **Rotatable 3D view** of the current best puzzle.
- Clicking an entry shows it and can replay it (viewer, §6). It can also be saved to the library.
- When a target is defined, each new leaderboard entry is queued for the uniqueness check (§5) in a separate worker.
  - Badge: `unique`, or `N solutions / M assemblies`; marked *own shape* (dashed) when the puzzle doesn't fill the target and is counted in its own shape (§5).
  - A "unique only" filter is available.
- **Layout.** A run bar (start/stop, state, summary); a panel with the base, the essential settings, a folded *Advanced* section (check cap, `R`, `N`) and the background options, then the counters; the leaderboard; the 3D view.
- **Phones** (≤ 820 px): the page doesn't scroll. A *Settings / Board* switch in the run bar picks the pane shown above the 3D view, and starting a run shows the board. Each pane scrolls inside; the filters scroll sideways; leaderboard entries are cards. Only a card the user taps shows its view, save and open actions, so cards don't grow under the finger when a better puzzle comes. The 3D view takes the touch gestures.

---

## 5. Assembler and uniqueness (finalists only)

- **Target shape.** Painted manually with *required* cells and *variable* cells (variable cells may stay empty).
  - One click fills the target from the current puzzle's filled cells, all *required*.
  - The burr template and the known burrs come with the **standard burr target**:
    - every stick-envelope cell that only one stick can reach is *required*, including the 24 such cells inside the central 4×4×4 box;
    - the 32 central cells that two or three sticks can reach are *variable*.

    Its rotational symmetry group has order 12. With this target, the assembly counts match the published figures (Appendix A.4).
  - Without a target, the uniqueness check is disabled.
  - A cell listed as both required and variable counts as required.
  - **All optional:** the same target with every cell variable, so the pieces may leave any cell empty. The fixtures also record their counts with it (Appendix A.4).
- **Placements.** Each piece in 24 rotations, no mirrors, at every translation that fits inside the target.
- **Exact cover** (DLX-like):
  - primary columns: the required cells, plus one column per piece;
  - secondary columns: the variable cells.
- **Counting.**
  - Identical pieces (the same shape up to rotation) are interchangeable.
  - Assemblies related by a symmetry of the target (a rotation that maps required cells to required cells and variable cells to variable cells) count once.
- **Solving.** Each assembly is solved (§3) in the bounding box of the target.
  - `M` is the number of distinct assemblies; `N` is the number of disassemblable ones.
  - Assemblies that cannot be built (they fail the solver) are counted in M and shown as information.
- **Caps.**
  - Each solve has a state cap (default 5,000,000, as in the editor). An assembly whose solve reaches it is *undecided*: counted in M, not in N.
  - The count stops at `max_assemblies` distinct assemblies (default 10,000). The result is then *aborted* and M and N are lower bounds.
- **Unique** means a complete count, `N = 1` and no undecided assembly.
- **Pieces that do not fit.** The uniqueness of a document counts its fixed voxels into its target. Pieces that, as placed, leave required cells empty (*holes*) or have voxels outside the target have no assembly into it (`0 / 0`), although they come apart. They are counted into their own shape instead: the target less its holes (also when listed as variable), plus their voxels outside it as required cells. Their own placement fills it, so `M ≥ 1`. The result gives the holes and the voxels outside, and the badge reads `(own shape)`.
- **Result:** status (complete or aborted), M, N, undecided, unique, the order of the target's symmetry group, `firstSolution` (the first disassemblable assembly found, each piece placed in target coordinates in input order), holes and outside.

---

## 6. Viewer

- Plays back the full disassembly: play/pause, step forward and back, scrub bar, speed control. The first separation is highlighted. Opening the tab (or a new solution) plays from the start.
- The camera frames the assembled puzzle, slightly wider for the first moves.
- Removed parts slide out a few cells, then are set aside so the remaining part stays readable.
- Move list such as `#5  B+C → +X 2`, grouped by separation node. Clicking a move jumps to it.
- Selecting a piece makes the other pieces transparent. This works in the viewer and in the editor.
- No animation export.

---

## 7. Editor

- **Views.**
  - 2D layer view: choose the axis and slice; click to paint. It can be hidden, leaving the width to the 3D view.
  - 3D view: orbit; click a face to add a voxel next to it; click a voxel to remove it.
  - The two views are synced, and the current slice is shown in 3D.
  - Orientation: the 3D views of the editor and the viewer share an orientation, turned by quarter turns about the puzzle X, Y and Z axes so that any axis can point up. It only changes the display, not the document. The grid edges through the origin are drawn in the axis colours.
  - Hover preview: the voxel a left click would add (pencil, box or line) shows as a ghost in the piece colour, in both views, wherever the pointer is in either. It is hidden while a mouse button is down and while Shift is held, and can be turned off.
- **Pieces.**
  - List with add, delete, rename and colour. A click (or tap) selects a piece; a double-click (or double-tap) on its name renames it.
  - Hide, ghost (transparent) or isolate a piece.
  - Per-piece *notchable* toggle, plus the notchable and millable badges.
  - Several pieces can be painted at once. Ctrl-click adds a piece to the selection or removes it; Shift-click selects a range from the current piece. Optional marks and erasing go to every selected piece. Fixed voxels, the brush and the block tool act on the current piece only.
- **Toolbar.** Two rows of constant height.
  - Row 1: the tools, undo and redo, then a *View* menu (show the target, 2D layer view, hide the optional marks, hover preview) and a *Grid* menu (the grid size). On small screens the tools show as icons and the two menus merge into one ⋯ menu.
  - Row 2: the options of the active tool. Painting tools: *Fixed / Optional*, the painted pieces (`A +2`, with *All pieces* and *Only the current one*), *Shapes*, *Move* and *Block…*. Select: the selection count, *Move* and clear. Target: *Required / Variable / Erase*, *Shapes* and *Clear target*.
  - Menus open below their button, stay open while used (to move several times) and close on a click outside or Escape.
- **Tools.**
  - Pencil and eraser (current piece, current state fixed/optional).
  - Box fill and line fill.
  - Brush that turns fixed into optional and back.
  - Multi-voxel selection: move the selected voxels only, along ±X, ±Y, ±Z.
  - Move pieces: ±X, ±Y, ±Z move the current piece and the selected ones (fixed voxels and optional marks) by one cell. A move that takes a fixed voxel out of the grid or onto another piece's voxel is refused; optional marks that would leave the grid are dropped; moved voxels take the cell from other pieces' optional marks.
  - *Hide optional*: the optional marks are hidden in both views, to edit the fixed voxels.
  - Grid size: a smaller grid keeps the box of the old grid that drops the fewest fixed voxels, then optional marks, then target cells, so a centred puzzle is cropped around it.
  - Stick/block tool: a W×H×L block at a given position and axis, for the current or a new piece, as fixed or optional.
  - Target painting (required/variable/erase).
  - *Shapes*: a table of zones by destination. Zones: *Cube* (the whole grid, its outer faces required and the inside variable), *Sphere* (the ellipsoid inscribed in the grid by cell centres, a sphere in a cubic grid; its outer cells required, the inside variable), *Burr* (§8; the burr shape required plus its variable cells), *Fixed voxels* (target only, all required) and *Selection* (optional only, when cells are selected). Destinations: *Set* the target; *Fill* the optional marks of the painted pieces, or of every piece, on each cell of the zone without a fixed voxel. A *Clear* row empties the target or the optional marks of those pieces. *Cube* target then *Cube* fill for all pieces sets up a cube-shaped puzzle in two clicks.
  - Undo and redo for every edit.
- **Status bar:** live check (§3.4), piece count, voxel count, and holes inside the bounding box. It is one line of fixed height, so the views do not move when its text changes; a cut text shows in full on a click.

---

## 8. Templates and samples

- **Parametric 6-piece burr** with 2×2×L sticks (L even, 6 or more). It uses the standard layout (Appendix A.1).
  - Each stick's envelope cell that no other stick's envelope contains is *fixed*.
  - Each cell that is shared between several stick envelopes is *optional* for each of those sticks.
  - For L = 6 this gives exactly the 12 removable cubies of Rob's numbering.
- **Stick/block tool** (also an editor tool, §7).
- **Legacy sample:** the 6 pieces from `legacy/puzzle_generator.py`, on an 8×8×8 grid. It turns out to be Mega Six in a rotated frame (level 10, unique).
- **Known burrs** (Appendix A). Each loads as:
  - filled cells = fixed;
  - empty cells inside a stick's 2×2×L envelope that no other piece fills = optional for that stick;
  - the standard burr target (§5).

  The burrs:
  - Piston (Marineau, the "Burr-B"), Mega Six, CCU10, Love's Dozen, Hordern's Piston mod;
  - Abad's Level 9, plus Abad's 6.7 and 5.7 Improved, the two hardest Abad burrs whose level reads `I.J` with J > I;
  - Abad's 4.9, 4.8 and original 5.7, which are also included because their data is in the same file.
- The known-burr data lives in `fixtures/burrs.json` (assembled coordinates). The test suite uses the same file.

---

## 9. Architecture and tech

```
puzzle_generator/
├── SPEC.md
├── legacy/puzzle_generator.py
├── Cargo.toml                 # workspace
├── crates/
│   ├── puzzle-core/           # pure Rust: model, solver, notch, canonical key, generator, assembler, I/O
│   └── puzzle-wasm/           # wasm-bindgen bindings, thin
├── fixtures/burrs.json
└── web/                       # Vite + React + TypeScript + Three.js
    ├── api/library.js         # the Vercel Function of the shared library (§2.2)
    ├── server/library.js      # its handler, testable without Vercel
    ├── shared/                # the library index operations, used by the server and the browser
    └── src/
```

- **Core.** `puzzle-core` has no WASM dependency, so `cargo test` and benchmarks run natively.
- **Bindings.** `puzzle-wasm` is built with `wasm-pack build --target web`.
- **Front end.** React, TypeScript and Three.js (react-three-fiber), built with Vite. Workers load the WASM module.
- **Messaging.** Workers exchange JSON-serializable messages. Puzzles cross the boundary as the native JSON (§2.1); hot paths in the generator stay inside WASM.
- **Seeded randomness.** A deterministic PRNG in Rust gives reproducible runs for a given seed and iteration count.
- **Language.** UI, code, comments and docs are in English.
- **Versions** were checked on 2026-10-29: vite 8.3.5 (Node `^20.19.0 || >=22.12.0`), react 19.3.1, three 0.186.1, @react-three/fiber 9.8.2, wasm-pack 0.15.0, wasm-bindgen 0.2.129. @vercel/blob 2.8.2 was checked on 2026-11-03. Exact pins are fixed when each package is added.
- **Server code** is plain JavaScript (ES modules), so Vercel runs it without compiling it.

### 9.1 Development environment

- WSL Debian 13, working on the Windows folder `/mnt/c/Users/adelas/Documents/Perso/playground/puzzle-generator`.
- Cargo's target directory is in the WSL home (`.cargo/config.toml` → `build.target-dir`), to avoid slow builds on `/mnt/c`.
- Vite uses `server.watch.usePolling`, because files edited from Windows don't raise inotify events in WSL.
- Node 20.19.2 (Debian package) meets Vite 8's minimum.

### 9.2 Deployment (Vercel) and PWA

- **Import from GitHub as is.** Vercel reads `vercel.json` in the project's Root Directory: `vercel.json` at the repository root builds in `web/` and serves `web/dist`, and `web/vercel.json` does the same when the Root Directory is `web`. The `/api/library` function is exposed from either root. Both configs set the commands, so the dashboard's build settings don't matter. Vercel has no Rust, so the WASM package `crates/puzzle-wasm/pkg` is committed: after a change to the Rust code, run `npm run wasm` and commit the package (`git add -f crates/puzzle-wasm/pkg`).
- **Little traffic.** The built files in `assets/` have hashed names and are cached by browsers for a year. A service worker (`web/sw.js`, completed at build time with the list of built files) downloads each deployment once, then serves the app from its cache, offline too. A visit only fetches `sw.js` (~2 kB) to check for a new version, which takes over once every tab of the app is closed. The library API is never cached by the service worker.
- **Shared library.** The function `web/api/library.js` (also exposed at the repository root for the root-directory deployment) uses a private Vercel Blob store. One-time setup in the Vercel dashboard:
  1. Storage → Create → Blob, access **Private**, connected to the project for Production (and Preview if wanted). This adds the store's environment variables: `BLOB_STORE_ID` (with OIDC) or `BLOB_READ_WRITE_TOKEN`.
  2. Settings → Environment Variables → add `LIBRARY_PASSWORD`.
  3. Redeploy.
  - Without a store, the app keeps its library in each browser, with a notice. Without the password variable, the library can be read but not changed.
  - On the Hobby plan, each save costs 2 Blob writes ("advanced operations", 2,000 a month), and each library check costs 1 read.
- **PWA.** `manifest.webmanifest` and the icons in `web/public` make the app installable ("Add to home screen").
- **Touch.** One finger turns the 3D view, two fingers zoom and pan, and a tap clicks. With no right button, Alt or Ctrl, erasing uses the Eraser tool and several pieces are selected with the "multi" box of the piece list. Below 820 px wide the page never scrolls: the header folds to the tabs and Save (▾ shows the name and Export), the toolbar rows show icons and scroll sideways if needed, the pieces stay in a narrow left column beside the layer and 3D views, the status bar stays at the bottom, and long panels scroll inside.
- **Draft.** When the page is hidden (another app, a locked phone) or closed, the edited document, its library link, the open tab and the editor's view are saved in the browser's local storage, and restored on the next load. A mobile browser that discards the page in the background and reloads it on return shows it as it was left.

---

## 10. Milestones

Each milestone ends with a git commit.

| # | Content | Done when |
|---|---|---|
| M1 | Cargo workspace; `puzzle-core` model and solver (§3); `fixtures/burrs.json`; `legacy/` move | Tests pass: the level of every fixture, including the legacy sample, matches Appendix A.4. Full level strings are compared too, and any justified difference is documented in the test. Hand-built cases cover moves, groups and separations. A property test checks monotonicity (adding voxels never lowers the level). Benchmark numbers are recorded |
| M2 | `puzzle-wasm`; web app; editor (§7); live check; viewer (§6); library and JSON (§2.1–2.2); notchable/millable; templates (§8) | Load the Piston, edit it, see the live level, replay the disassembly |
| M3 | Generator (§4) and leaderboard UI | Multi-worker run on a template finds solvable puzzles with deduplicated entries; stop conditions work |
| M4 | Assembler and uniqueness (§5); badges and filter | With the standard burr target, every fixture's assembly and solution counts match Appendix A.4 |
| M5 | BurrTools import/export (§2.3); STL export (§2.4) | Round-trip a known burr through `.xmpuzzle`; STL pieces are watertight with the clearance applied |

---

## 11. Open points

- **Assembly counts.** The published convention is now resolved: the standard burr target (§5), counted up to its 12 rotations. One unexplained difference remains: Love's Dozen gives 90 solutions, while Rob's Puzzle Page says 89 ways. M4 asserts the fixture values.
- **BurrTools cross-check.** The research solver follows BurrTools 0.6.3 as read from its source, but it was not compared with a BurrTools build.
- **Level sub-digits.** The second and later digits of our level strings may differ from BurrTools when ties are broken differently, or when a move made of the union of independent groups is shorter. The first number (the level) must match the known values.
- **Chamfer limits.** The chamfer (§2.4) works per sub-cell edge; it is not a full morphological rounding.
  - Where a bevel ends at a concave junction, a small flat triangular wall closes it instead of a mitre.
  - Non-manifold edges are separated by a midpoint split.
  - STL cannot show the duplicated vertices: they are coincident points.

---

## Appendix A — Known burr data

### A.1 Standard 6-piece burr layout (grid L×L×L, core offset o = (L−4)/2)

| Pair | Stick axis | Common position | Split |
|---|---|---|---|
| X sticks | x ∈ [0, L) | y ∈ {o+1, o+2} | z ∈ {o, o+1} and {o+2, o+3} |
| Y sticks | y ∈ [0, L) | z ∈ {o+1, o+2} | x ∈ {o, o+1} and {o+2, o+3} |
| Z sticks | z ∈ [0, L) | x ∈ {o+1, o+2} | y ∈ {o, o+1} and {o+2, o+3} |

The legacy sample uses this layout with L = 8.

### A.2 Rob's Puzzle Page numbering (2×2×6)

The piece ID is `1 +` the sum of the values of the removed cubies. Here x runs along the stick (0..5) and "top" faces the burr's centre. Longer sticks extend the solid ends equally on both sides.

| | x=1 | x=2 | x=3 | x=4 |
|---|---|---|---|---|
| top front | 1 | 2 | 4 | 8 |
| top back | 16 | 32 | 64 | 128 |
| bottom front | – | 256 | 512 | – |
| bottom back | – | 1024 | 2048 | – |

### A.3 Voxel strings (BurrTools text format)

Each piece is `x=L y=2 z=2`, and `index = x + L·(y + 2z)`. `#` is filled, `_` is empty. y: 0 = front, 1 = back. z: 0 = bottom, 1 = top.

Length 6:

| ID | Voxels |
|---|---|
| 88 | `#############___###_#_##` |
| 144 | `#############____#####_#` |
| 160 | `#############____##_##_#` |
| 416 | `##_##########____##_##_#` |
| 495 | `##_###########___###___#` |
| 507 | `##_###########_#_##____#` |
| 508 | `##_##########__#_##____#` |
| 512 | `##_##########____##____#` |
| 608 | `###_#########____##_#_##` |
| 637 | `###_###########__##___##` |
| 702 | `###_#########_#__##__#_#` |
| 704 | `###_#########____##__#_#` |
| 734 | `###_#########_#__##_#__#` |
| 736 | `###_#########____##_#__#` |
| 742 | `###_#########_#_####___#` |
| 768 | `###_#########____##____#` |
| 864 | `##__#########____##_#_##` |
| 880 | `##__#########____###__##` |
| 895 | `##__##########___##___##` |
| 922 | `##__#########_##_##_##_#` |
| 954 | `##__#########_##_##__#_#` |
| 960 | `##__#########____##__#_#` |
| 975 | `##__##########___####__#` |
| 990 | `##__#########_#__##_#__#` |
| 992 | `##__#########____##_#__#` |
| 1000 | `##__#########___####___#` |
| 1008 | `##__#########____###___#` |
| 1015 | `##__##########__###____#` |
| 1016 | `##__#########___###____#` |
| 1023 | `##__##########___##____#` |
| 1024 | `##__#########____##____#` |

Length 8:

| ID | Voxels |
|---|---|
| 220 | `##################__#_####_#__##` |
| 503 | `###_###############__#####____##` |
| 624 | `####_#############____#####__###` |
| 698 | `####_#############_##_####__#_##` |
| 702 | `####_#############_#__####__#_##` |
| 768 | `####_#############____####____##` |
| 883 | `###__##############_######___###` |
| 944 | `###__#############____#####_#_##` |
| 960 | `###__#############____####__#_##` |
| 1015 | `###__##############__#####____##` |
| 1016 | `###__#############___#####____##` |
| 1024 | `###__#############____####____##` |

### A.4 Puzzles (`fixtures/burrs.json`)

- The fixture file holds the assembled coordinates of each puzzle. For a puzzle with several solutions, it holds the highest-level one.
- Levels and counts were computed by the research solver. Level strings follow BurrTools `movesText2`.
- Assemblies and solutions are counted with the standard burr target (§5), up to its 12 rotations.
- Each entry also records `assemblies_all_optional` and `solutions_all_optional` (the counts with every target cell optional, §5) and `symmetry_group_order`. `legacy_sample` has no symmetry order.
- The total number of moves is in each entry's `computed.total_moves`.

| Fixture key | Puzzle | Designer | L | Pieces (Rob IDs) | Level | Assemblies / solutions |
|---|---|---|---|---|---|---|
| `piston` | Piston ("Burr-B") | Peter Marineau, 1986 | 6 | 88, 512, 768, 922, 1008 ×2 | `9.3` | 10 / 1 |
| `ccu10` | CCU10 | Bill Cutler, 1990 | 8 | 624, 702, 768, 883, 1015, 1024 | `10` | 7 / 1 |
| `mega_six` | Mega Six | Cutler / Brian Young (attribution conflicts) | 8 | 702, 768, 883, 944, 1015, 1024 | `10` | 20 / 1 |
| `abad_level_9` | Abad's Level 9 | Rafael Guarinos Abad | 6 | 160, 508, 736, 742, 768, 1015 | `9` | 2 / 1 |
| `abad_6_7` | Abad 6.7 | Abad, 2007 | 8 | 220, 503, 698, 960, 1016, 1024 | `6.7` | 25 / 1 |
| `abad_5_7_improved` | Abad's Level 5.7 Improved | Abad, 2006 | 6 | 144, 495, 702, 975, 990, 1024 | `5.7` | 11 / 1 |
| `abad_5_7` | Abad 5.7 (original) | Abad, 2005 | 6 | 608, 895, 954, 990, 1008 ×2 | `5.7` | 4 / 1 |
| `abad_4_9` | Abad 4.9 | Abad, 2006 | 6 | 416, 507, 734, 768, 880, 1023 | `4.9` | 6 / 1 |
| `abad_4_8` | Abad 4.8 | Abad, 2005 | 6 | 637, 864, 954, 992, 1000, 1016 | `4.8.1.2` (published as 4.8) | 2 / 1 |
| `loves_dozen` | Love's Dozen | Bruce Love | 6 | 88, 512, 704, 960, 992, 1008 | `12.3` | 154 / 90 (Rob: "89 ways") |
| `hordern_piston_mod` | Hordern's Piston mod | David Hordern | 6 | 88, 160, 512, 768, 992, 1008 | `10.2` | 40 / 13 |
| `legacy_sample` | Legacy sample (Mega Six, rotated) | — | 8 | 1024, 702, 944, 768, 1015, 883 | `10` | 20 / 1 |

The legacy labels map to these pieces as:

| Legacy label | Rob ID |
|---|---|
| last | 1024 |
| deux taquets | 702 |
| un taquet | 944 |
| encoche droite | 768 |
| first | 1015 |
| bizarre | 883 |

Context: holey 6-piece burrs reach at most level 12, no level 11 exists, and the highest *unique* level is 10.

### A.5 Provenance

- **Abad's burrs** come from Ishino's "Puzzle Will Be Played" site. The pages are `https://puzzlewillbeplayed.com/6PieceBurrT/<page>/` for Abad67, Abad57Improved, Abad57, Abad49 and Abad48.
- **Rob IDs.** Only the 5.7 Improved is listed with Rob IDs on Rob's Puzzle Page.
  - The IDs of the other Abad burrs were computed from Ishino's numbers: Ishino #n is the mirror image of Rob piece n+1, and the smallest equivalent Rob ID is kept.
  - Their assembly counts match Ishino's exactly, which supports these IDs.

---

## Appendix B — BurrTools `.xmpuzzle` format (from BurrTools 0.6.3 source)

### Container

Gzip-compressed XML:

```xml
<puzzle version="2">            <!-- versions 1 and 2 accepted -->
  <gridType type="0"/>          <!-- 0 = cubes -->
  <colors><color red=".." green=".." blue=".."/>…</colors>
  <shapes>…</shapes>
  <problems>…</problems>
  <comment>…</comment>
</puzzle>
```

### Shapes

- Each shape: `<voxel x= y= z= [hx hy hz] [weight] [name] type="0">TEXT</voxel>`.
- TEXT uses `#` for filled, `_` for empty and `+` for variable. A filled or variable character may be followed by a colour index from 1 to 63.
- Order: `index = x + sx·(y + sy·z)`, so x varies fastest.

### Problems

`<problem [name] state= [assemblies solutions time] [maxHoles]>` contains:

- `<shapes>` with `<shape id count | min max [group]>`;
- `<result id>` (the target shape);
- `<bitmap>` with `<pair piece= result=/>` (colour constraints);
- `[<assembler>]`;
- `[<solutions>]`.

### Solutions

- `<solution>` contains `<assembly>`, with one `x y z t` group per piece (or `x` for an unplaced piece).
- `t` is the transform: 0–23 are rotations, 24–47 are mirrored versions. The matrices are in `tabs_0/rotmatrix.inc`.
- The rotated voxel box is shifted back to start at 0. A transformed voxel `p` lands at `p + (X − H′)`, where `H′` is the transformed hotspot.

### Separations

- `<separation [type=left|removed]>` contains `<pieces count>`, then `<state>` elements holding `<dx> <dy> <dz>` (absolute positions), and optional child separations.
- A piece counts as removed once `|coordinate| > 10000`.
- The number of moves of a separation is the number of states − 1.
