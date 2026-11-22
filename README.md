# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/wildanroby29/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/wildanroby29/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the make.fun contest
"Build the best Sokoban solver, 21 November 2026"
([sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)).

## Design

Every level is a 1-wide hallway (the player's row) plus 1–4 rooms (6×6 slots,
3–4 boxes each, one door onto the hallway). Boxes stay in their room in an
optimal solution, so the push-optimal count P\* is the sum of the rooms'
optima. The solver:

- finds the hallway and each room + door by flood fill (excluding the hallway row);
- solves each room **push-optimally** with A\* over push states — state =
  (sorted box cells, player cell); a push is legal when the player can walk to
  the cell behind the box and the cell beyond is free floor; heuristic is the
  min-cost matching of boxes to goals by shortest-path distance (admissible,
  so A\* returns the push-optimal count); prunes with dead squares (reverse
  pull from goals), 2×2 frozen blocks, and a transposition table;
- solves each room twice (unconstrained and exit-constrained) and orders the
  rooms so the total push count is minimised (the room with the largest exit
  penalty goes last);
- stitches the rooms with hallway walking (BFS).

Deterministic: fixed expansion order and a node/state budget only — the wall
clock is never read, so two executions produce byte-identical output.

## Practice score

Practice set (5 instances): **1,000,000** — every instance solved in exactly
P\* pushes (i001: 13, i002: 16, i003: 29, i004: 47, i005: 60), 1000/1000 each.
The house baseline (plain-astar 1.0.0) scores 200,000 on the same set (only
i001 solved).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT. See `LICENSE`.
