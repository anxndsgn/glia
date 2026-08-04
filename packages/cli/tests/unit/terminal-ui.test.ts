import { describe, expect, test } from "bun:test";
import {
  colorEnabled,
  hardWrap,
  listWindowSize,
  nameColumnWidth,
  summarizeNames,
  summarizePaths,
  symbolsFor,
  wrapLines,
} from "../../src/core/output/terminal.ts";
import { GroupedPicker, type PickerItem } from "../../src/core/output/picker.ts";

describe("the grouped picker", () => {
  const long =
    "Use this skill whenever the user wants to do the thing, and also this other much longer clause that would certainly wrap on any terminal width at all.";

  function items(count: number, groups = ["skills/react", "skills/typescript"]): PickerItem[] {
    return Array.from({ length: count }, (_, i) => ({
      value: `${groups[i % groups.length]}/skill-${i}`,
      name: `skill-name-${i}`,
      description: long,
      group: groups[i % groups.length]!,
    }));
  }

  const lines = (p: GroupedPicker, message = "Select items from acme/skills — 41 found") =>
    p.frame(message).split("\n");

  test("no frame row wraps, and the frame stays inside the viewport", () => {
    const picker = new GroupedPicker(items(41), { viewport: { columns: 80, rows: 24 } });
    const rendered = lines(picker);
    // Strictly inside: a frame as tall as the viewport scrolls it, and a
    // scrolled frame is what leaves stale rows behind on redraw.
    expect(rendered.length).toBeLessThan(24);
    for (const line of rendered) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("the frame height does not change as the cursor moves", () => {
    const picker = new GroupedPicker(items(41), { viewport: { columns: 80, rows: 24 } });
    const height = lines(picker).length;
    for (let i = 0; i < 20; i++) {
      picker.move(1);
      expect(lines(picker).length).toBe(height);
    }
  });

  test("preserveOrder keeps the caller's item order instead of sorting", () => {
    const unsorted: PickerItem[] = [
      { value: "newest", name: "07-26 14:32  b-newest", description: "", group: "" },
      { value: "older", name: "07-25 09:10  a-older", description: "", group: "" },
    ];
    const sorted = new GroupedPicker(unsorted);
    expect(sorted.items.map((i) => i.value)).toEqual(["older", "newest"]);
    const kept = new GroupedPicker(unsorted, { preserveOrder: true });
    expect(kept.items.map((i) => i.value)).toEqual(["newest", "older"]);
  });

  test("clipped ends report how many rows they hide", () => {
    const picker = new GroupedPicker(items(41), { viewport: { columns: 80, rows: 24 } });
    expect(lines(picker).some((l) => l.includes("more"))).toBe(true);
  });

  test("space on a folder selects every Skill beneath it, and again clears them", () => {
    const picker = new GroupedPicker(items(6), { viewport: { columns: 80, rows: 40 } });
    expect(picker.rows[0]!.kind).toBe("group");
    picker.toggle();
    expect(picker.values()).toEqual([
      "skills/react/skill-0",
      "skills/react/skill-2",
      "skills/react/skill-4",
    ]);
    picker.toggle();
    expect(picker.values()).toEqual([]);
  });

  test("left folds the folder the cursor is in and lands on its header", () => {
    const picker = new GroupedPicker(items(6), { viewport: { columns: 80, rows: 40 } });
    picker.move(2); // inside the first folder
    picker.collapse();
    expect(picker.cursor).toBe(0);
    // Two headers, and only the second folder's three items.
    expect(picker.rows).toHaveLength(5);
    expect(picker.rows.filter((r) => r.kind === "group")).toHaveLength(2);
    picker.expand();
    expect(picker.rows).toHaveLength(8);
  });

  test("folding a folder keeps its selection", () => {
    const picker = new GroupedPicker(items(6), { viewport: { columns: 80, rows: 40 } });
    picker.toggle(); // whole first folder
    picker.collapse();
    expect(picker.values()).toHaveLength(3);
  });

  test("a source with every unit at the root gets no folder rows", () => {
    const picker = new GroupedPicker(
      [
        { value: "a", name: "a", description: "d", group: "" },
        { value: "b", name: "b", description: "d", group: "" },
      ],
      { viewport: { columns: 80, rows: 24 } },
    );
    expect(picker.grouped).toBe(false);
    expect(picker.rows.every((r) => r.kind === "item")).toBe(true);
    picker.toggle();
    expect(picker.values()).toEqual(["a"]);
  });

  test("a narrow terminal still renders one row per option", () => {
    const picker = new GroupedPicker(items(41), { viewport: { columns: 40, rows: 12 } });
    const rendered = lines(picker);
    expect(rendered.length).toBeLessThan(12);
    for (const line of rendered) expect(line.length).toBeLessThanOrEqual(40);
  });

  test("the ASCII glyph set is budgeted: its wider checkbox still fits the viewport", () => {
    const ascii = symbolsFor({ TERM: "linux" }, "linux");
    const wide = [
      {
        value: "a",
        name: "a",
        description: long,
        group: "a-folder-name-well-past-the-narrow-budget",
      },
      ...items(9),
    ];
    const picker = new GroupedPicker(wide, { viewport: { columns: 40, rows: 14 }, symbols: ascii });
    for (const line of lines(picker)) expect(line.length).toBeLessThanOrEqual(40);
  });

  test("the cursor wraps around the ends of the list", () => {
    const picker = new GroupedPicker(items(4), { viewport: { columns: 80, rows: 40 } });
    const total = picker.rows.length;
    picker.move(-1);
    expect(picker.cursor).toBe(total - 1);
    picker.move(1);
    expect(picker.cursor).toBe(0);
  });

  test("the submit frame lists what was chosen, on two rows", () => {
    const picker = new GroupedPicker(items(4), { viewport: { columns: 80, rows: 40 } });
    picker.move(1);
    picker.toggle();
    const rendered = picker.frame("Select Skills", "submit").split("\n");
    expect(rendered).toHaveLength(2);
    expect(rendered[1]).toInclude("skills/react/skill-0");
  });
});

describe("prompt text layout", () => {
  test("the plain-list window stays inside the viewport", () => {
    expect(listWindowSize({ rows: 24 })).toBeLessThanOrEqual(24 - 8);
    expect(listWindowSize({ rows: 200 })).toBeLessThanOrEqual(12);
    expect(listWindowSize({ rows: 6 })).toBeGreaterThanOrEqual(5);
    expect(listWindowSize({})).toBeGreaterThanOrEqual(5);
  });

  test("colour follows NO_COLOR, FORCE_COLOR, and the terminal", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
  });

  test("a terminal without unicode gets ASCII symbols", () => {
    expect(symbolsFor({ TERM: "linux" }, "linux").cursor).toBe(">");
    expect(symbolsFor({ TERM: "xterm-256color" }, "darwin").cursor).toBe("❯");
  });

  test("the detail block wraps to at most two clipped rows", () => {
    expect(wrapLines("a b c", 40, 2)).toEqual(["a b c"]);
    const wrapped = wrapLines("word ".repeat(60), 20, 2);
    expect(wrapped).toHaveLength(2);
    for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(20);
    expect(wrapped[1]).toEndWith("…");
    expect(wrapLines("", 20, 2)).toEqual([]);
  });

  test("the name column yields to the description's floor, but never disappears", () => {
    expect(nameColumnWidth(["short"], 80)).toBe(5);
    expect(nameColumnWidth(["x".repeat(60)], 80)).toBe(34);
    expect(nameColumnWidth(["x".repeat(60)], 20)).toBe(20);
  });

  test("hardWrap keeps every physical row inside the budget, losing nothing", () => {
    const preview = `Will materialize:\n  ${".claude/skills/some-skill, ".repeat(8).trim()}\n\nContinue?`;
    const wrapped = hardWrap(preview, 40);
    for (const line of wrapped.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
    const squash = (s: string) => s.replace(/\s+/g, " ");
    expect(squash(wrapped)).toBe(squash(preview));
  });

  test("hardWrap breaks at a space, mid-word only when a row has no usable one", () => {
    expect(hardWrap("alpha beta gamma", 11)).toBe("alpha beta\ngamma");
    expect(hardWrap("x".repeat(25), 10)).toBe(
      `${"x".repeat(10)}\n${"x".repeat(10)}\n${"x".repeat(5)}`,
    );
    // Indentation alone is not a break point — it would leave a blank row.
    expect(hardWrap(`  ${"y".repeat(12)}`, 10)).toBe(`  ${"y".repeat(8)}\n${"y".repeat(4)}`);
  });

  test("hardWrap leaves short lines, blank lines, and zero budgets alone", () => {
    expect(hardWrap("a\n\nb", 40)).toBe("a\n\nb");
    expect(hardWrap("anything at all", 0)).toBe("anything at all");
  });
});

describe("result summaries", () => {
  test("a short list is spelled out; a long one names a few and counts the rest", () => {
    expect(summarizeNames([])).toBe("");
    expect(summarizeNames(["a", "b"])).toBe("a, b");
    const many = Array.from({ length: 22 }, (_, i) => `s${i}`);
    expect(summarizeNames(many)).toBe("s0, s1, s2, s3, s4, s5 and 16 more");
    expect(summarizeNames(many, 2)).toBe("s0, s1 and 20 more");
  });

  test("targets collapse to their directories with counts", () => {
    const paths = ["x", "y"].flatMap((k) => [`.claude/skills/${k}`, `.agents/skills/${k}`]);
    expect(summarizePaths(paths)).toBe(".claude/skills/ (2), .agents/skills/ (2)");
    // A handful under one directory still reads better in full.
    expect(summarizePaths([".claude/skills/x", ".claude/skills/y"])).toBe(
      ".claude/skills/x, .claude/skills/y",
    );
    expect(summarizePaths([])).toBe("");
  });
});
