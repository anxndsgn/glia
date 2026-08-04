/** A grouped, windowed multi-select prompt.
 *
 * Core owns it because it renders to the terminal, and because any module with
 * a long list of nameable things needs the same three properties: one row per
 * item so nothing wraps, a window that stays inside the viewport, and a group
 * row that selects everything beneath it in one key.
 *
 * `@clack/prompts`' own `groupMultiselect` cannot be used: it renders every
 * option on every frame with no window at all, which is exactly the overflow
 * that makes a long list unusable (see terminal.ts).
 *
 * The model below is pure — rows in, frame lines out — so the layout is
 * testable without a terminal. `pickGrouped` is the only part that touches one.
 */

import {
  colorEnabled,
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  dimmer,
  MIN_DESCRIPTION_COLUMN,
  nameColumnWidth,
  oneLine,
  symbolsFor,
  truncate,
  UNICODE_SYMBOLS,
  wrapLines,
  type Symbols,
  type Viewport,
} from "./terminal.ts";

/** Rows the frame spends on anything that is not the option window: the
 * message, the two rails, the detail block, the key hints — plus a row of
 * headroom, so the frame never fills the viewport exactly and scrolls it. */
const CHROME_ROWS = 9;
const MIN_WINDOW_ROWS = 3;
const MAX_WINDOW_ROWS = 16;
/** `│  ❯ ▾ ` and `│  ❯   ` — the columns ahead of the checkbox; the same for
 * both row kinds, so they share one text budget. The checkbox itself is the
 * one glyph whose width varies by glyph set (`◻` vs `[ ]`), so the full
 * prefix is derived from the active symbols. */
const ROW_PREFIX_BEFORE_BOX = 8;
/** Rows reserved for the focused row's full description. */
const DESCRIPTION_ROWS = 2;

export interface PickerItem {
  /** What the picker returns for this row. */
  value: string;
  name: string;
  description: string;
  /** The group this row belongs to; "" for ungrouped rows. */
  group: string;
}

/** What the prompt calls the things it is listing, for its own prose. */
export interface PickerNouns {
  /** Plural item label. */
  plural: string;
  /** Singular item label. */
  singular: string;
  /** How an empty group name reads, e.g. "the source root". */
  rootGroup: string;
}

const DEFAULT_NOUNS: PickerNouns = {
  plural: "items",
  singular: "item",
  rootGroup: "the root",
};

type Row = { kind: "group"; group: string; members: string[] } | { kind: "item"; item: PickerItem };

export type PickerState = "active" | "submit" | "cancel" | "error";

export interface PickerOptions {
  viewport?: Viewport;
  symbols?: Symbols;
  colors?: boolean;
  nouns?: Partial<PickerNouns>;
  /** Keep the caller's item order instead of sorting by group and name. */
  preserveOrder?: boolean;
}

/** The picker's whole state: which rows exist, which are selected, which
 * groups are folded, and where the cursor sits. No I/O. */
export class GroupedPicker {
  readonly items: PickerItem[];
  /** Group headers are shown once the items carry a group at all. */
  readonly grouped: boolean;
  readonly selected = new Set<string>();
  private readonly collapsed = new Set<string>();
  private readonly groups: { group: string; members: PickerItem[] }[];
  private readonly columns: number;
  private readonly windowRows: number;
  private readonly symbols: Symbols;
  private readonly dim: (text: string) => string;
  private readonly nouns: PickerNouns;
  cursor = 0;

  constructor(items: PickerItem[], options: PickerOptions = {}) {
    const viewport = options.viewport ?? {};
    const symbols = options.symbols ?? UNICODE_SYMBOLS;
    this.nouns = { ...DEFAULT_NOUNS, ...options.nouns };
    this.dim = dimmer(options.colors ?? false);
    this.items = options.preserveOrder
      ? [...items]
      : [...items].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    this.symbols = symbols;
    this.columns = viewport.columns ?? DEFAULT_COLUMNS;
    this.windowRows = Math.max(
      MIN_WINDOW_ROWS,
      Math.min(MAX_WINDOW_ROWS, (viewport.rows ?? DEFAULT_ROWS) - CHROME_ROWS),
    );

    const byGroup = new Map<string, PickerItem[]>();
    for (const item of this.items) {
      const bucket = byGroup.get(item.group);
      if (bucket === undefined) byGroup.set(item.group, [item]);
      else bucket.push(item);
    }
    this.groups = [...byGroup.entries()].map(([group, members]) => ({ group, members }));
    this.grouped = this.groups.some((g) => g.group !== "");
  }

  /** The rows on screen; a folded folder keeps its header row but hides its members. */
  get rows(): Row[] {
    if (!this.grouped) return this.items.map((item) => ({ kind: "item", item }) as Row);
    const rows: Row[] = [];
    for (const { group, members } of this.groups) {
      rows.push({ kind: "group", group, members: members.map((m) => m.value) });
      if (this.collapsed.has(group)) continue;
      for (const item of members) rows.push({ kind: "item", item });
    }
    return rows;
  }

  private get row(): Row | undefined {
    return this.rows[this.cursor];
  }

  move(delta: number): void {
    const total = this.rows.length;
    if (total === 0) return;
    this.cursor = (this.cursor + delta + total) % total;
  }

  /** Space: an item toggles itself; a folder toggles every item beneath it —
   * selecting the whole folder in one key, deselecting it once it is full. */
  toggle(): void {
    const row = this.row;
    if (row === undefined) return;
    if (row.kind === "item") {
      if (this.selected.has(row.item.value)) this.selected.delete(row.item.value);
      else this.selected.add(row.item.value);
      return;
    }
    const complete = row.members.every((v) => this.selected.has(v));
    for (const value of row.members) {
      if (complete) this.selected.delete(value);
      else this.selected.add(value);
    }
  }

  /** Left: fold the folder the cursor is in, and land on its header. */
  collapse(): void {
    const row = this.row;
    if (row === undefined || !this.grouped) return;
    const group = row.kind === "group" ? row.group : row.item.group;
    this.collapsed.add(group);
    this.cursor = this.rows.findIndex((r) => r.kind === "group" && r.group === group);
  }

  /** Right: unfold the folder under the cursor. */
  expand(): void {
    const row = this.row;
    if (row === undefined || row.kind !== "group") return;
    this.collapsed.delete(row.group);
  }

  values(): string[] {
    return this.items.map((i) => i.value).filter((v) => this.selected.has(v));
  }

  private groupBox(members: string[]): string {
    const chosen = members.filter((v) => this.selected.has(v)).length;
    if (chosen === 0) return this.symbols.none;
    return chosen === members.length ? this.symbols.all : this.symbols.some;
  }

  private get textBudget(): number {
    const prefix = ROW_PREFIX_BEFORE_BOX + this.symbols.none.length;
    return Math.max(MIN_DESCRIPTION_COLUMN, this.columns - prefix - 1);
  }

  private rowText(row: Row, nameColumn: number): string {
    if (row.kind === "group") {
      const folder = row.group === "" ? `(${this.nouns.rootGroup})` : `${row.group}/`;
      const count = `${row.members.length} ${this.nouns.plural}`;
      const clipped = truncate(folder, Math.max(1, this.textBudget - count.length - 2));
      return `${clipped}  ${this.dim(count)}`;
    }
    const name = truncate(row.item.name, nameColumn).padEnd(nameColumn, " ");
    const room = this.textBudget - nameColumn - 2;
    if (room < MIN_DESCRIPTION_COLUMN) return name.trimEnd();
    const description = truncate(oneLine(row.item.description), room);
    return description === "" ? name.trimEnd() : `${name}  ${this.dim(description)}`;
  }

  /** The option window: `windowRows` rows centred on the cursor, the clipped
   * ends replaced by a count of what they hide. */
  private windowLines(rows: Row[], nameColumn: number): string[] {
    const s = this.symbols;
    const total = rows.length;
    const size = Math.min(this.windowRows, total);
    const start = Math.min(
      Math.max(0, this.cursor - Math.floor(size / 2)),
      Math.max(0, total - size),
    );
    const end = Math.min(total, start + size);

    const lines = rows.slice(start, end).map((row, i) => {
      const index = start + i;
      const here = index === this.cursor;
      const mark = here ? s.cursor : " ";
      if (row.kind === "group") {
        const fold = this.collapsed.has(row.group) ? s.closed : s.open;
        return `${s.bar}  ${mark} ${fold} ${this.groupBox(row.members)} ${this.rowText(row, nameColumn)}`;
      }
      const box = this.selected.has(row.item.value) ? s.all : s.none;
      const indent = this.grouped ? "  " : "";
      return `${s.bar}  ${mark} ${indent}${box} ${this.rowText(row, nameColumn)}`;
    });

    // A clipped end reports what it hides, including the row it covers.
    if (start > 0 && lines.length > 0)
      lines[0] = `${s.bar}  ${this.dim(`${s.up} ${start + 1} more`)}`;
    if (end < total && lines.length > 0) {
      lines[lines.length - 1] = `${s.bar}  ${this.dim(`${s.down} ${total - end + 1} more`)}`;
    }
    return lines;
  }

  /** The whole frame, one string per terminal row; no row ever wraps. */
  frame(message: string, state: PickerState = "active", error = ""): string {
    const s = this.symbols;
    const rows = this.rows;
    const nameColumn = nameColumnWidth(
      this.items.map((i) => i.name),
      this.textBudget - (this.grouped ? 2 : 0),
    );

    if (state === "submit" || state === "cancel") {
      const chosen = this.values();
      const summary =
        state === "cancel"
          ? "cancelled"
          : chosen.length === 0
            ? "nothing selected"
            : truncate(chosen.join(", "), Math.max(MIN_DESCRIPTION_COLUMN, this.columns - 6));
      return `${state === "cancel" ? s.cancelled : s.submitted}  ${message}\n${s.bar}  ${summary}`;
    }

    const head = `${state === "error" ? s.cancelled : s.active}  ${truncate(message, Math.max(MIN_DESCRIPTION_COLUMN, this.columns - 3))}`;
    const lines = [head, s.bar, ...this.windowLines(rows, nameColumn), s.bar];

    // A fixed-height detail block: the frame's height must not change as the
    // cursor moves, or the differential redraw has to repaint the whole list.
    const row = rows[this.cursor];
    const detail =
      row === undefined
        ? ""
        : row.kind === "group"
          ? `Space selects all ${row.members.length} ${this.nouns.plural} in ${row.group === "" ? this.nouns.rootGroup : `${row.group}/`}.`
          : row.item.description;
    const detailWidth = Math.max(MIN_DESCRIPTION_COLUMN, this.columns - 5);
    const wrapped = wrapLines(detail, detailWidth, DESCRIPTION_ROWS);
    for (let i = 0; i < DESCRIPTION_ROWS; i++) {
      const text = wrapped[i];
      lines.push(text === undefined ? s.bar : `${s.bar}  ${this.dim(text)}`);
    }

    const chosen = this.selected.size;
    const keys = this.grouped
      ? `${s.up}${s.down} move · space select · ${"←→"} fold · enter confirm`
      : `${s.up}${s.down} move · space select · enter confirm`;
    lines.push(
      `${s.bar}  ${this.dim(truncate(`${chosen} selected · ${keys}`, Math.max(MIN_DESCRIPTION_COLUMN, this.columns - 5)))}`,
    );
    if (state === "error" && error !== "") {
      lines.push(
        `${s.end}  ${truncate(error, Math.max(MIN_DESCRIPTION_COLUMN, this.columns - 5))}`,
      );
    } else {
      lines.push(s.end);
    }
    return lines.join("\n");
  }
}

/** Run the picker against the terminal. Returns the chosen values, or null
 * when the user cancelled. */
export async function pickGrouped(
  items: PickerItem[],
  message: string,
  options: { viewport?: Viewport; nouns?: Partial<PickerNouns>; preserveOrder?: boolean } = {},
): Promise<string[] | null> {
  const { Prompt, isCancel } = await import("@clack/core");
  const nouns = { ...DEFAULT_NOUNS, ...options.nouns };
  const picker = new GroupedPicker(items, {
    viewport: options.viewport,
    nouns,
    preserveOrder: options.preserveOrder,
    symbols: symbolsFor(process.env, process.platform),
    colors: colorEnabled(process.env, process.stdout.isTTY === true),
  });

  const prompt = new Prompt(
    {
      render() {
        const self = this as unknown as { state: PickerState; error: string };
        return picker.frame(message, self.state, self.error);
      },
      validate: (value: unknown) =>
        Array.isArray(value) && value.length > 0
          ? undefined
          : `Select at least one ${nouns.singular} — space toggles the row under the cursor.`,
    },
    false,
  );
  prompt.value = [];

  prompt.on("cursor", (key) => {
    switch (key) {
      case "up":
        picker.move(-1);
        break;
      case "down":
        picker.move(1);
        break;
      case "left":
        picker.collapse();
        break;
      case "right":
        picker.expand();
        break;
      case "space":
        picker.toggle();
        break;
      default:
        return;
    }
    prompt.value = picker.values();
  });

  const answer = await prompt.prompt();
  if (isCancel(answer)) return null;
  return picker.values();
}
