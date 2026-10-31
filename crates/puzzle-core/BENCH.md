# Solver and assembler benchmark

`cargo run --release --example bench` (source: `examples/bench.rs`).

- **Date:** 2026-10-29 (milestone M1); assembler table 2026-10-30 (milestone M4).
- **Machine:** 12th Gen Intel Core i7-12650HX, WSL 2 (Debian). The sources are on `/mnt/c` and the build directory is in the WSL home.
- **Toolchain:** rustc 1.99.1 (58cf8f9c3 2026-10-13). Release profile with `lto = "thin"` and `codegen-units = 1`.
- **Method:** each measurement repeats for up to 2 s, with between 3 and 50 runs. Times are wall clock, so expect about ±20 % noise between runs.

## Fixtures

Each fixture of `fixtures/burrs.json` is solved as given.

- **States** counts the states explored in all sub-problems.
- Every level string and total matches BurrTools (`tests/fixtures.rs`).

| Fixture | Level string | Total moves | States | Runs | Median | Min |
|---|---|---:|---:|---:|---:|---:|
| abad_4_8 | 4.8.1.2 | 16 | 19 | 50 | 0.029 ms | 0.028 ms |
| abad_4_9 | 4.9 | 16 | 22 | 50 | 0.035 ms | 0.031 ms |
| abad_5_7 | 5.7 | 15 | 17 | 50 | 0.037 ms | 0.028 ms |
| abad_5_7_improved | 5.7 | 15 | 23 | 50 | 0.034 ms | 0.031 ms |
| abad_6_7 | 6.7 | 16 | 26 | 50 | 0.045 ms | 0.041 ms |
| abad_level_9 | 9 | 13 | 19 | 50 | 0.034 ms | 0.031 ms |
| ccu10 | 10 | 14 | 29 | 50 | 0.054 ms | 0.048 ms |
| hordern_piston_mod | 10.2 | 15 | 25 | 50 | 0.035 ms | 0.033 ms |
| legacy_sample | 10 | 14 | 38 | 50 | 0.049 ms | 0.047 ms |
| loves_dozen | 12.3 | 18 | 28 | 50 | 0.041 ms | 0.037 ms |
| mega_six | 10 | 14 | 36 | 50 | 0.057 ms | 0.050 ms |
| piston | 9.3 | 15 | 22 | 50 | 0.037 ms | 0.032 ms |

## One-voxel variants

Every puzzle made by adding one empty cell of a piece's bounding box to that piece. These are the checks the generator repeats. Per-check times are medians over rounds that solve every variant.

| Fixture | Variants | Solved | Unsolvable | Highest level | States per check | Median per check | Checks/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| abad_4_8 | 16 | 0 | 16 | - | 3 | 0.015 ms | 68456 |
| abad_4_9 | 17 | 1 | 16 | 5 | 7 | 0.019 ms | 53801 |
| abad_5_7 | 18 | 0 | 18 | - | 4 | 0.015 ms | 68932 |
| abad_5_7_improved | 9 | 0 | 9 | - | 2 | 0.012 ms | 82034 |
| abad_6_7 | 16 | 0 | 16 | - | 6 | 0.025 ms | 40502 |
| abad_level_9 | 11 | 0 | 11 | - | 3 | 0.015 ms | 66142 |
| ccu10 | 16 | 0 | 16 | - | 6 | 0.026 ms | 38658 |
| hordern_piston_mod | 18 | 0 | 18 | - | 3 | 0.014 ms | 69367 |
| legacy_sample | 18 | 1 | 17 | 10 | 8 | 0.030 ms | 33721 |
| loves_dozen | 22 | 0 | 22 | - | 3 | 0.017 ms | 58562 |
| mega_six | 18 | 1 | 17 | 10 | 8 | 0.035 ms | 28333 |
| piston | 17 | 0 | 17 | - | 2 | 0.014 ms | 70567 |

## Assembler

The uniqueness check of each fixture (SPEC §5): every assembly into its standard burr target, each one solved, then the same with every target cell optional.

- **Symmetries** is the order of the target's rotation group: assemblies related by one of these rotations count once.
- Both sets of counts match those recorded in the fixtures (`tests/assembler.rs`).

| Fixture | Target | Symmetries | Assemblies | Solutions | Runs | Median | Min |
|---|---|---:|---:|---:|---:|---:|---:|
| abad_4_8 | standard | 12 | 2 | 1 | 50 | 2.370 ms | 2.179 ms |
| abad_4_8 | all optional | 12 | 9 | 3 | 50 | 9.260 ms | 8.857 ms |
| abad_4_9 | standard | 12 | 6 | 1 | 50 | 2.445 ms | 2.336 ms |
| abad_4_9 | all optional | 12 | 15 | 1 | 50 | 10.976 ms | 10.191 ms |
| abad_5_7 | standard | 12 | 4 | 1 | 50 | 2.486 ms | 2.314 ms |
| abad_5_7 | all optional | 12 | 9 | 1 | 50 | 10.489 ms | 9.699 ms |
| abad_5_7_improved | standard | 12 | 11 | 1 | 50 | 3.092 ms | 2.906 ms |
| abad_5_7_improved | all optional | 12 | 16 | 1 | 50 | 6.034 ms | 5.705 ms |
| abad_6_7 | standard | 12 | 25 | 1 | 50 | 4.431 ms | 4.235 ms |
| abad_6_7 | all optional | 12 | 39 | 3 | 50 | 5.646 ms | 5.510 ms |
| abad_level_9 | standard | 12 | 2 | 1 | 50 | 2.281 ms | 2.206 ms |
| abad_level_9 | all optional | 12 | 3 | 1 | 50 | 6.702 ms | 6.211 ms |
| ccu10 | standard | 12 | 7 | 1 | 50 | 3.729 ms | 3.337 ms |
| ccu10 | all optional | 12 | 10 | 1 | 50 | 21.456 ms | 19.655 ms |
| hordern_piston_mod | standard | 12 | 40 | 13 | 50 | 4.777 ms | 4.453 ms |
| hordern_piston_mod | all optional | 12 | 86 | 34 | 50 | 10.876 ms | 9.944 ms |
| legacy_sample | standard | 12 | 20 | 1 | 50 | 4.860 ms | 4.572 ms |
| legacy_sample | all optional | 12 | 37 | 1 | 30 | 68.055 ms | 63.020 ms |
| loves_dozen | standard | 12 | 154 | 90 | 50 | 10.114 ms | 9.516 ms |
| loves_dozen | all optional | 12 | 478 | 222 | 50 | 32.835 ms | 30.855 ms |
| mega_six | standard | 12 | 20 | 1 | 50 | 4.935 ms | 4.639 ms |
| mega_six | all optional | 12 | 37 | 1 | 50 | 20.359 ms | 19.112 ms |
| piston | standard | 12 | 10 | 1 | 50 | 3.317 ms | 3.048 ms |
| piston | all optional | 12 | 26 | 1 | 50 | 9.631 ms | 9.135 ms |

## Notes

**These puzzles need few states.** The search explores only 17 to 38 states across all sub-problems of these high-level 6-piece burrs, so a solve costs well under 0.1 ms.

**A check costs mostly its fixed setup, not the search.** For a check that explores only 2 to 8 states, most of the time goes into the per-solve setup: the difference set of each of the 15 piece pairs, plus the allocations.

- In the first version, each pair zeroed and scanned a full 63×63 grid of rows, so every check cost about 50 µs.
- Each difference set is now built only inside its bounding box, which is computed from the two pieces' bounding boxes. This made checks 2–4× faster and fixture solves 1.5–2× faster.
- **What the generator (M3) can save:** a candidate changes a single piece, so only the 5 pairs that involve that piece need rebuilding.

**A uniqueness check costs milliseconds, not microseconds.** With the standard target it takes 2–10 ms, and with every cell optional up to 68 ms. That is about 1,000 times a solvability check, which is why the generator checks uniqueness only on leaderboard entries, in a separate worker (SPEC §4.4).
