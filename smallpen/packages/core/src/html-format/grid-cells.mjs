// INPUT:  a grid's tracks, flow direction and children's placement classes
// OUTPUT: Penpot grid cells (every cell, filled or empty) and the tracks
//         the children need
// POS:    The one placement rule shared by decode and encode, so the
//         encoder writes a child's lines only when the rule would not put it
//         there by itself.
//
// Children are placed in the order they are written. A child with
// col-start/row-start goes to that line; a child without goes to the first
// free cell in flow order (row by row for grid-flow-row) that fits its span.
// When children need more tracks than the classes give, auto tracks are
// added in the flow direction, as CSS adds implicit rows.

const key = (row, column) => `${row},${column}`;

function createPlacer(columnCount, rowCount, dir) {
  const taken = new Set();
  const state = { columns: columnCount, rows: rowCount };
  const fits = (row, column, rowSpan, columnSpan) => {
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) if (taken.has(key(r, c))) return false;
    }
    return true;
  };
  const take = (row, column, rowSpan, columnSpan) => {
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) taken.add(key(r, c));
    }
    state.rows = Math.max(state.rows, row + rowSpan - 1);
    state.columns = Math.max(state.columns, column + columnSpan - 1);
  };
  // Where an item without explicit lines goes (or with one of them).
  const next = ({ row, column, rowSpan, columnSpan }) => {
    if (row !== undefined && column !== undefined) return { row, column };
    if (column !== undefined) {
      for (let r = 1; ; r += 1) if (fits(r, column, rowSpan, columnSpan)) return { row: r, column };
    }
    if (row !== undefined) {
      for (let c = 1; ; c += 1) if (fits(row, c, rowSpan, columnSpan)) return { row, column: c };
    }
    if (dir === "column") {
      const rows = Math.max(state.rows, rowSpan, 1);
      for (let c = 1; ; c += 1) {
        for (let r = 1; r + rowSpan - 1 <= rows; r += 1) if (fits(r, c, rowSpan, columnSpan)) return { row: r, column: c };
      }
    }
    const columns = Math.max(state.columns, columnSpan, 1);
    for (let r = 1; ; r += 1) {
      for (let c = 1; c + columnSpan - 1 <= columns; c += 1) if (fits(r, c, rowSpan, columnSpan)) return { row: r, column: c };
    }
  };
  return { state, fits, take, next };
}

// items: [{ id, column?, row?, columnSpan, rowSpan, alignSelf?, justifySelf? }]
// in document order. Returns { placements, columns, rows, conflicts } where
// columns/rows are the track counts the grid needs.
export function placeGridItems(items, columnCount, rowCount, dir = "row") {
  const placer = createPlacer(columnCount, rowCount, dir);
  const placements = [];
  const conflicts = [];
  for (const item of items) {
    const at = placer.next(item);
    if (!placer.fits(at.row, at.column, item.rowSpan, item.columnSpan)) {
      conflicts.push(item);
      continue;
    }
    placer.take(at.row, at.column, item.rowSpan, item.columnSpan);
    placements.push({ ...item, row: at.row, column: at.column, manual: item.row !== undefined || item.column !== undefined });
  }
  return { placements, columns: Math.max(1, placer.state.columns), rows: Math.max(1, placer.state.rows), conflicts };
}

// Penpot cells for placed items plus one empty 1x1 cell for every free spot.
// cellId(row, column) gives a stable id.
export function gridCells(placements, columns, rows, cellId) {
  const cells = {};
  const taken = new Set();
  for (const placement of placements) {
    for (let r = placement.row; r < placement.row + placement.rowSpan; r += 1) {
      for (let c = placement.column; c < placement.column + placement.columnSpan; c += 1) taken.add(key(r, c));
    }
    const id = cellId(placement.row, placement.column);
    cells[id] = {
      "align-self": placement.alignSelf ?? "auto",
      column: placement.column,
      "column-span": placement.columnSpan,
      id,
      "justify-self": placement.justifySelf ?? "auto",
      position: placement.manual || placement.rowSpan > 1 || placement.columnSpan > 1 ? "manual" : "auto",
      row: placement.row,
      "row-span": placement.rowSpan,
      shapes: [placement.id],
    };
  }
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      if (taken.has(key(row, column))) continue;
      const id = cellId(row, column);
      cells[id] = {
        "align-self": "auto",
        column,
        "column-span": 1,
        id,
        "justify-self": "auto",
        position: "auto",
        row,
        "row-span": 1,
        shapes: [],
      };
    }
  }
  return cells;
}

// The cell holding each child: childId -> cell.
export function cellsByChild(cells) {
  const byChild = new Map();
  for (const cell of Object.values(cells ?? {})) {
    for (const shape of cell.shapes ?? []) byChild.set(shape, cell);
  }
  return byChild;
}

// For the encoder: which children need col-start/row-start written, given
// the cells they are in. children: ids in document order (absolute ones
// excluded). Returns Set of child ids whose lines must be written.
export function explicitLines(children, byChild, columnCount, rowCount, dir = "row") {
  const placer = createPlacer(columnCount, rowCount, dir);
  const explicit = new Set();
  // The placer only grows the flow direction; the other one is fixed by the
  // tracks the encoder writes.
  if (dir === "column") placer.state.rows = rowCount;
  else placer.state.columns = columnCount;
  for (const child of children) {
    const cell = byChild.get(child);
    if (!cell) continue;
    const rowSpan = cell["row-span"] ?? 1;
    const columnSpan = cell["column-span"] ?? 1;
    const auto = placer.next({ rowSpan, columnSpan });
    if (auto.row !== cell.row || auto.column !== cell.column) explicit.add(child);
    placer.take(cell.row, cell.column, rowSpan, columnSpan);
  }
  return explicit;
}
