/** Terminal text measurement and styling — core's, because rendering to the
 * terminal is core's concern and every module that lists things needs it.
 *
 * A list prompt may hold dozens of rows, so the rows have to be measured.
 * Clack windows its option list by counting *options*, not the terminal rows
 * they occupy: an option whose text wraps costs two rows, the frame outgrows
 * the viewport, and the differential redraw then paints stale rows — the
 * screen fills, the list is pinned to its bottom, and several rows appear
 * active at once. Every row therefore has to fit one terminal row, and the
 * window has to stay well inside the viewport.
 */

/** Widest a name column may grow, however long the names are. */
export const MAX_NAME_COLUMN = 34;
/** Below this, a description column is not worth the row. */
export const MIN_DESCRIPTION_COLUMN = 16;
/** Names stay legible even on a narrow terminal. */
export const MIN_NAME_COLUMN = 12;
/** `│  ◻ ` — a prompt's own gutter, ahead of the label. */
const GUTTER = 5;
/** Rows a plain clack list spends on its message and framing. */
const CHROME_ROWS = 8;

export const DEFAULT_COLUMNS = 80;
export const DEFAULT_ROWS = 24;

export interface Viewport {
  columns?: number | undefined;
  rows?: number | undefined;
}

/** Secondary text — descriptions, counts, key hints — is dimmed so the names
 * carry the row. Colour is a rendering concern only: it is applied after the
 * text is measured and clipped, never before. */
export function dimmer(enabled: boolean): (text: string) => string {
  return enabled ? (text) => `\x1b[2m${text}\x1b[22m` : (text) => text;
}

/** Honours NO_COLOR and FORCE_COLOR, and stays off where there is no terminal
 * to colour. */
export function colorEnabled(env: Record<string, string | undefined> = {}, isTTY = false): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  if (env["TERM"] === "dumb") return false;
  return isTTY;
}

/** The terminal's current size, with the conventional fallback where there is
 * no terminal to measure. */
export function viewportOf(stream: { columns?: number; rows?: number } = process.stdout): Viewport {
  return { columns: stream.columns, rows: stream.rows };
}

/** The glyph set a prompt draws with; ASCII where the terminal cannot be
 * trusted with the box-drawing and geometric ranges. */
export interface Symbols {
  cursor: string;
  none: string;
  some: string;
  all: string;
  open: string;
  closed: string;
  bar: string;
  end: string;
  active: string;
  submitted: string;
  cancelled: string;
  up: string;
  down: string;
}

const UNICODE: Symbols = {
  cursor: "❯",
  none: "◻",
  some: "◐",
  all: "◼",
  open: "▾",
  closed: "▸",
  bar: "│",
  end: "└",
  active: "◆",
  submitted: "◇",
  cancelled: "■",
  up: "↑",
  down: "↓",
};

const ASCII: Symbols = {
  cursor: ">",
  none: "[ ]",
  some: "[-]",
  all: "[x]",
  open: "-",
  closed: "+",
  bar: "|",
  end: "-",
  active: "*",
  submitted: "o",
  cancelled: "x",
  up: "^",
  down: "v",
};

export function symbolsFor(env: Record<string, string | undefined> = {}, platform = ""): Symbols {
  if (platform === "win32") return env["WT_SESSION"] !== undefined ? UNICODE : ASCII;
  return env["TERM"] === "linux" || env["TERM"] === "dumb" ? ASCII : UNICODE;
}

export { UNICODE as UNICODE_SYMBOLS };

/** Collapse whitespace so a description can never claim a second row. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * East Asian Wide and Fullwidth code points, and the emoji blocks, occupy
 * two terminal columns; everything else occupies one. Code-unit length is
 * not column width, and a column that pads by length misaligns every row
 * carrying such text.
 */
function columnsOf(codePoint: number): number {
  const wide =
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
  return wide ? 2 : 1;
}

/** Terminal columns a string occupies, measured by code point. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += columnsOf(char.codePointAt(0) ?? 0);
  return width;
}

/**
 * Clip to `width` terminal columns rather than code units, iterating by
 * code point so a surrogate pair is never split into a lone half.
 */
export function truncateWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  let out = "";
  let used = 0;
  for (const char of text) {
    const columns = columnsOf(char.codePointAt(0) ?? 0);
    if (used + columns > width - 1) break;
    out += char;
    used += columns;
  }
  return `${out.trimEnd()}…`;
}

/** Pad to `width` terminal columns so the next column stays a column. */
export function padWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1).trimEnd()}…`;
}

/** Wrap to at most `lines` rows of `width`, the last one clipped. */
export function wrapLines(text: string, width: number, lines: number): string[] {
  const words = oneLine(text)
    .split(" ")
    .filter((w) => w !== "");
  if (width <= 0 || lines <= 0 || words.length === 0) return [];
  const out: string[] = [];
  let row = "";
  for (const word of words) {
    const candidate = row === "" ? word : `${row} ${word}`;
    if (candidate.length <= width) {
      row = candidate;
      continue;
    }
    if (row !== "") out.push(row);
    if (out.length === lines - 1) {
      // The last row absorbs the remainder, clipped.
      const rest = words.slice(words.indexOf(word)).join(" ");
      out.push(truncate(rest, width));
      return out;
    }
    row = word.length <= width ? word : truncate(word, width);
  }
  if (row !== "") out.push(row);
  return out.slice(0, lines);
}

/**
 * Lossless wrap for prompt messages: clack repaints by counting the frame's
 * logical lines, so a physical row wider than the terminal shifts every
 * repaint below it and leaves stale rows on screen (see the header note).
 * Each line breaks at the last space inside the budget where that leaves
 * visible text ahead of the break, mid-word otherwise.
 */
export function hardWrap(text: string, width: number): string {
  if (width <= 0) return text;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > width) {
      const space = rest.lastIndexOf(" ", width);
      const cut = space > 0 && rest.slice(0, space).trim() !== "" ? space : width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ +/, "");
    }
    out.push(rest);
  }
  return out.join("\n");
}

/** How many options a plain clack list may show at once — a window that stays
 * inside the viewport rather than one option per remaining row. */
export function listWindowSize(viewport: Viewport = {}): number {
  const rows = viewport.rows ?? DEFAULT_ROWS;
  return Math.max(5, Math.min(12, rows - CHROME_ROWS));
}

/** A plain option label, clipped to one terminal row. */
export function truncateLabel(text: string, viewport: Viewport = {}): string {
  const columns = viewport.columns ?? DEFAULT_COLUMNS;
  return truncate(oneLine(text), Math.max(MIN_DESCRIPTION_COLUMN, columns - GUTTER - 1));
}

/** Width of the name column for a two-column list: as wide as the longest
 * name, but never at the cost of the description's floor, and never past its
 * own ceiling. The name is what the user addresses a row by, so it is clipped
 * last — it takes the whole row once the description no longer fits at all. */
export function nameColumnWidth(names: string[], available: number): number {
  const room = Math.max(1, available);
  const wanted = Math.min(MAX_NAME_COLUMN, Math.max(1, ...names.map((n) => n.length)));
  const shared = Math.min(
    wanted,
    room,
    Math.max(MIN_NAME_COLUMN, room - MIN_DESCRIPTION_COLUMN - 2),
  );
  return room - shared - 2 >= MIN_DESCRIPTION_COLUMN ? shared : Math.min(wanted, room);
}
