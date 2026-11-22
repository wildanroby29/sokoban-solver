// Sokoban solver: room-decomposed PUSH-OPTIMAL A*.
// Every level is a 1-wide hallway (the player's row) + 1-4 rooms (6x6 slots,
// 3-4 boxes each, one door onto the hallway). Boxes stay in their room in an
// optimal solution, so P* = sum of the rooms' optima. Each room is solved
// push-optimally (A* over push states, admissible matching heuristic, dead
// squares, 2x2 frozen blocks, transposition table), then the rooms are stitched
// with hallway walking. Deterministic: fixed expansion order, node/state
// budgets only, never the wall clock.
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DIRS = [[0, -1, 'u'], [0, 1, 'd'], [-1, 0, 'l'], [1, 0, 'r']];
const MAX_EXP = 600000; // expansions per room A* run (deterministic work budget)

// ---------- parsing ----------
function parse(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goals = new Set();
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ---------- BFS: walking path (returns move string) or null ----------
function bfsPath(from, isGoal, blocked, level, allowed) {
  const { w, h, wall } = level;
  if (isGoal(from)) return '';
  const prev = new Map([[from, -1]]);
  const prevMove = new Map();
  const q = [from];
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    const cx = c % w, cy = Math.floor(c / w);
    for (const [dx, dy, letter] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || blocked.has(n) || prev.has(n)) continue;
      if (allowed && !allowed.has(n)) continue;
      prev.set(n, c);
      prevMove.set(n, letter);
      if (isGoal(n)) {
        let s = letter;
        for (let t = c; t !== from; t = prev.get(t)) s = prevMove.get(t) + s;
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

// ---------- flood fill: set of cells reachable from `from` ----------
function flood(from, blocked, level, allowed) {
  const { w, h, wall } = level;
  const seen = new Set([from]);
  const q = [from];
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    const cx = c % w, cy = Math.floor(c / w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || blocked.has(n) || seen.has(n)) continue;
      if (allowed && !allowed.has(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

// ---------- room detection ----------
// The hallway is the player's row. Each room is a connected floor region above
// or below it (flood fill excluding the hallway row) that holds boxes.
function findRooms(level) {
  const { w, h, wall, player } = level;
  const hallwayRow = Math.floor(player / w);
  const visited = new Set();
  const rooms = [];
  for (let x = 0; x < w; x++) {
    const hc = hallwayRow * w + x;
    if (wall[hc]) continue;
    for (const dy of [-1, 1]) {
      const ny = hallwayRow + dy;
      if (ny < 0 || ny >= h) continue;
      const nc = ny * w + x;
      if (wall[nc] || visited.has(nc)) continue;
      const cells = new Set();
      const q = [nc];
      visited.add(nc);
      cells.add(nc);
      while (q.length) {
        const c = q.pop();
        const cx = c % w, cy = Math.floor(c / w);
        for (const [dx, dy2] of DIRS) {
          const nx = cx + dx, ny2 = cy + dy2;
          if (nx < 0 || nx >= w || ny2 < 0 || ny2 >= h) continue;
          if (ny2 === hallwayRow) continue;
          const n2 = ny2 * w + nx;
          if (wall[n2] || visited.has(n2)) continue;
          visited.add(n2);
          cells.add(n2);
          q.push(n2);
        }
      }
      const boxes = level.boxes.filter((b) => cells.has(b));
      if (boxes.length === 0) continue;
      const goals = [...level.goals].filter((g) => cells.has(g));
      const entryCells = [];
      for (const c of cells) {
        if (Math.abs(Math.floor(c / w) - hallwayRow) === 1) entryCells.push(c);
      }
      const hallCells = [];
      for (const e of entryCells) {
        const hcell = hallwayRow * w + (e % w);
        if (!wall[hcell] && !hallCells.includes(hcell)) hallCells.push(hcell);
      }
      rooms.push({ cells, boxes, goals, entryCells, hallCells });
    }
  }
  return { hallwayRow, rooms };
}

// ---------- dead squares (reverse pull from goals) ----------
// A cell is live if a box on it can be pulled to a goal (player reachability
// ignored, so this over-approximates live cells and never prunes a live state).
function computeDead(room, level) {
  const { w, wall } = level;
  const live = new Set(room.goals);
  const q = [...room.goals];
  while (q.length) {
    const g = q.pop();
    const gx = g % w, gy = Math.floor(g / w);
    for (const [dx, dy] of DIRS) {
      const n = (gy + dy) * w + (gx + dx);
      if (!room.cells.has(n) || live.has(n)) continue;
      const beyond = (gy + 2 * dy) * w + (gx + 2 * dx);
      if (beyond < 0 || beyond >= wall.length || wall[beyond]) continue;
      live.add(n);
      q.push(n);
    }
  }
  const dead = new Set();
  for (const c of room.cells) if (!live.has(c)) dead.add(c);
  return dead;
}

// ---------- 2x2 frozen block check around a moved box ----------
function frozen2x2(boxesSet, at, room, level) {
  const { w, wall } = level;
  const ax = at % w, ay = Math.floor(at / w);
  for (let ox = -1; ox <= 0; ox++) {
    for (let oy = -1; oy <= 0; oy++) {
      const cells = [];
      let ok = true;
      let hasGoal = false;
      for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
          const x = ax + ox + ix, y = ay + oy + iy;
          if (x < 0 || x >= w || y < 0 || y >= level.h) { ok = false; break; }
          const c = y * w + x;
          if (room.goals.includes(c)) hasGoal = true;
          if (!wall[c] && !boxesSet.has(c)) { ok = false; break; }
          cells.push(c);
        }
        if (!ok) break;
      }
      if (ok && !hasGoal) return true;
    }
  }
  return false;
}

// ---------- A* over push states for one room ----------
// Returns { moves, pushes, startHall } or null. requireExit: the final state
// must let the player walk back out to a hall cell.
function solveRoom(room, level, requireExit) {
  const { w, h, wall } = level;
  const goalSet = new Set(room.goals);
  const arena = new Set([...room.cells, ...room.hallCells]);
  const hallSet = new Set(room.hallCells);
  const dead = computeDead(room, level);
  // BFS distances from each goal over room cells (walls block, boxes ignored).
  const distTo = new Map();
  for (const g of room.goals) {
    const d = new Int32Array(w * h).fill(-1);
    d[g] = 0;
    const q = [g];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      const cx = c % w, cy = Math.floor(c / w);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (!room.cells.has(n) || d[n] >= 0) continue;
        d[n] = d[c] + 1;
        q.push(n);
      }
    }
    distTo.set(g, d);
  }
  // Admissible heuristic: min-cost matching boxes -> goals by shortest-path
  // distance (brute-force permutations, <= 4 boxes). Each push moves one box
  // one cell, so the matching distance lower-bounds the remaining pushes.
  const heuristic = (boxes) => {
    const n = boxes.length;
    if (n === 0) return 0;
    const goals = room.goals;
    let best = Infinity;
    const used = new Array(n).fill(false);
    const rec = (i, cost) => {
      if (cost >= best) return;
      if (i === n) { best = cost; return; }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = distTo.get(goals[j])[boxes[i]];
        if (d < 0) continue;
        used[j] = true;
        rec(i + 1, cost + d);
        used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  };
  const canExit = (player, boxes) => {
    const reach = flood(player, new Set(boxes), level, arena);
    for (const c of reach) if (hallSet.has(c)) return true;
    return false;
  };
  // Binary heap on [f, g, stateIdx]; ties: larger g first, then lower index.
  const heap = [];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const hpush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const hpop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  const sBoxes = [];
  const sPlayer = [];
  const sG = [];
  const sParent = [];
  const sPush = [];
  const best = new Map();
  const keyOf = (boxes, player) => player + ':' + boxes.join(',');
  const addState = (boxes, player, g, parent, push) => {
    const idx = sBoxes.length;
    sBoxes.push(boxes);
    sPlayer.push(player);
    sG.push(g);
    sParent.push(parent);
    sPush.push(push);
    return idx;
  };
  const startBoxes = room.boxes.slice();
  if (startBoxes.some((b) => dead.has(b))) return null;
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  for (const hc of room.hallCells) {
    const idx = addState(startBoxes, hc, 0, -1, null);
    best.set(keyOf(startBoxes, hc), idx);
    hpush([h0, 0, idx]);
  }
  let expanded = 0;
  while (heap.length > 0 && expanded < MAX_EXP) {
    const [, g, si] = hpop();
    if (best.get(keyOf(sBoxes[si], sPlayer[si])) !== si) continue;
    const boxes = sBoxes[si];
    const player = sPlayer[si];
    const solved = boxes.every((b) => goalSet.has(b));
    if (solved) {
      if (!requireExit || canExit(player, boxes)) {
        // Reconstruct the move string.
        const chain = [];
        for (let t = si; t !== -1; t = sParent[t]) chain.push(t);
        chain.reverse();
        let moves = '';
        for (let i = 1; i < chain.length; i++) {
          const prev = chain[i - 1], cur = chain[i];
          const push = sPush[cur];
          const behind = push.from - push.dy * w - push.dx;
          const walk = bfsPath(sPlayer[prev], (c) => c === behind, new Set(sBoxes[prev]), level, arena);
          if (walk === null) return null;
          moves += walk + push.dir;
        }
        if (requireExit) {
          const exit = bfsPath(sPlayer[si], (c) => hallSet.has(c), new Set(boxes), level, arena);
          if (exit === null) return null;
          moves += exit;
        }
        return { moves, pushes: chain.length - 1, startHall: sPlayer[chain[0]] };
      }
      continue; // solved but cannot exit: do not expand, keep searching
    }
    expanded++;
    const reach = flood(player, new Set(boxes), level, arena);
    for (const b of boxes) {
      const bx = b % w, by = Math.floor(b / w);
      for (const [dx, dy, letter] of DIRS) {
        const behind = (by - dy) * w + (bx - dx);
        const beyond = (by + dy) * w + (bx + dx);
        if (!reach.has(behind)) continue;
        if (!room.cells.has(beyond)) continue;
        if (boxes.includes(beyond)) continue;
        if (dead.has(beyond)) continue;
        const nb = boxes.slice();
        nb[nb.indexOf(b)] = beyond;
        nb.sort((a, b) => a - b);
        const nbSet = new Set(nb);
        if (frozen2x2(nbSet, beyond, room, level)) continue;
        const nplayer = b;
        const key = keyOf(nb, nplayer);
        const ng = g + 1;
        const ex = best.get(key);
        if (ex !== undefined && sG[ex] <= ng) continue;
        const ni = addState(nb, nplayer, ng, si, { from: b, to: beyond, dir: letter, dx, dy });
        best.set(key, ni);
        const hv = heuristic(nb);
        if (hv === Infinity) continue;
        hpush([ng + hv, ng, ni]);
      }
    }
  }
  return null;
}

// ---------- solve one level ----------
function solveLevel(text) {
  const level = parse(text);
  const { hallwayRow, rooms } = findRooms(level);
  // Every box must belong to some room; otherwise fall back to an empty answer.
  const inRoom = new Set();
  for (const r of rooms) for (const c of r.cells) inRoom.add(c);
  if (!level.boxes.every((b) => inRoom.has(b))) return '';
  if (rooms.length === 0) return '';
  // Solve each room unconstrained (u) and exit-constrained (e).
  const perRoom = rooms.map((room) => {
    const u = solveRoom(room, level, false);
    const e = solveRoom(room, level, true);
    return { room, u, e };
  });
  for (const pr of perRoom) if (!pr.u) return '';
  // Choose the last room to minimise total pushes: total = sum(e_i, i != k) + u_k.
  let bestK = 0;
  let bestTotal = Infinity;
  for (let k = 0; k < perRoom.length; k++) {
    let total = 0;
    for (let i = 0; i < perRoom.length; i++) {
      total += i === k ? perRoom[i].u.pushes : (perRoom[i].e ? perRoom[i].e.pushes : Infinity);
    }
    if (total < bestTotal) { bestTotal = total; bestK = k; }
  }
  const order = perRoom.map((_, i) => i).filter((i) => i !== bestK);
  order.push(bestK);
  // Walkable area for stitching: floor cells that are not inside any room.
  const roomCells = new Set();
  for (const r of rooms) for (const c of r.cells) roomCells.add(c);
  const walkable = new Set();
  for (let c = 0; c < level.w * level.h; c++) {
    if (!level.wall[c] && !roomCells.has(c)) walkable.add(c);
  }
  let moves = '';
  let cur = level.player;
  for (let oi = 0; oi < order.length; oi++) {
    const ri = order[oi];
    const pr = perRoom[ri];
    const sol = oi === order.length - 1 ? pr.u : (pr.e ?? pr.u);
    if (!sol) return '';
    const walk = bfsPath(cur, (c) => c === sol.startHall, new Set(), level, walkable);
    if (walk === null) return '';
    moves += walk + sol.moves;
    // After the room solution the player is at a hall cell (exit walk included,
    // except for the last room where the player ends inside the room).
    // Recompute the player's cell by replaying the appended moves.
    cur = replay(moves, level);
    if (cur < 0) return '';
  }
  return moves;
}

// Replay a move string on the level; returns the player's final cell, or -1 on
// an illegal step. Boxes are tracked so pushes are honoured.
function replay(moves, level) {
  const { w, wall } = level;
  let player = level.player;
  const boxes = new Set(level.boxes);
  for (const ch of moves) {
    const d = DIRS.find(([,, letter]) => letter === ch);
    if (!d) return -1;
    const [dx, dy] = d;
    const q = player + dy * w + dx;
    if (wall[q]) return -1;
    if (boxes.has(q)) {
      const beyond = q + dy * w + dx;
      if (wall[beyond] || boxes.has(beyond)) return -1;
      boxes.delete(q);
      boxes.add(beyond);
    }
    player = q;
  }
  return player;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
