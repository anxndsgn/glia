interface ValueRange {
  start: number;
  end: number;
}

interface PropertyRange extends ValueRange {
  name: string;
  propertyStart: number;
}

function skipWhitespace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  return at;
}

function stringEnd(text: string, start: number): number {
  let escaped = false;
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at]!;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return at + 1;
    }
  }
  throw new Error("unterminated JSON string");
}

function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first === "{" || first === "[") {
    const stack = [first];
    for (let at = start + 1; at < text.length; at += 1) {
      const char = text[at]!;
      if (char === '"') {
        at = stringEnd(text, at) - 1;
        continue;
      }
      if (char === "{" || char === "[") stack.push(char);
      if (char === "}" || char === "]") {
        stack.pop();
        if (stack.length === 0) return at + 1;
      }
    }
    throw new Error("unterminated JSON value");
  }
  let at = start;
  while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at += 1;
  return at;
}

export function rootRange(text: string): ValueRange {
  const start = skipWhitespace(text, 0);
  return { start, end: valueEnd(text, start) };
}

export function objectProperties(text: string, object: ValueRange): PropertyRange[] {
  const properties: PropertyRange[] = [];
  let at = skipWhitespace(text, object.start + 1);
  while (at < object.end - 1 && text[at] !== "}") {
    const propertyStart = at;
    const keyEnd = stringEnd(text, at);
    const name = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipWhitespace(text, keyEnd);
    if (text[at] !== ":") throw new Error("invalid JSON object");
    const start = skipWhitespace(text, at + 1);
    const end = valueEnd(text, start);
    properties.push({ name, propertyStart, start, end });
    at = skipWhitespace(text, end);
    if (text[at] === ",") at = skipWhitespace(text, at + 1);
  }
  return properties;
}

export function arrayElements(text: string, array: ValueRange): ValueRange[] {
  const elements: ValueRange[] = [];
  let at = skipWhitespace(text, array.start + 1);
  while (at < array.end - 1 && text[at] !== "]") {
    const end = valueEnd(text, at);
    elements.push({ start: at, end });
    at = skipWhitespace(text, end);
    if (text[at] === ",") at = skipWhitespace(text, at + 1);
  }
  return elements;
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return text.slice(lineStart, at).match(/^\s*/)?.[0] ?? "";
}

function trailingWhitespaceStart(text: string, close: number, open: number): number {
  let at = close;
  while (at > open + 1 && /\s/.test(text[at - 1]!)) at -= 1;
  return at;
}

function formatted(value: unknown, indent: string, multiline: boolean): string {
  const json = JSON.stringify(value, null, multiline ? 2 : undefined);
  return multiline ? json.replaceAll("\n", `\n${indent}`) : json;
}

function insertBeforeClose(
  text: string,
  range: ValueRange,
  hasMembers: boolean,
  renderItem: (indent: string, multiline: boolean) => string,
): string {
  const close = range.end - 1;
  const trailing = trailingWhitespaceStart(text, close, range.start);
  const multiline = text.slice(range.start, range.end).includes("\n");
  if (!multiline) {
    const insertion = `${hasMembers ? "," : ""}${renderItem("", false)}`;
    return text.slice(0, close) + insertion + text.slice(close);
  }
  const closingIndent = lineIndent(text, close);
  const itemIndent = `${closingIndent}  `;
  const insertion = `${hasMembers ? "," : ""}\n${itemIndent}${renderItem(itemIndent, true)}\n${closingIndent}`;
  return text.slice(0, trailing) + insertion + text.slice(close);
}

export function insertObjectProperty(
  text: string,
  object: ValueRange,
  name: string,
  value: unknown,
): string {
  return insertBeforeClose(
    text,
    object,
    objectProperties(text, object).length > 0,
    (indent, multiline) =>
      `${JSON.stringify(name)}${multiline ? ": " : ":"}${formatted(value, indent, multiline)}`,
  );
}

export function insertArrayElement(text: string, array: ValueRange, value: unknown): string {
  return insertBeforeClose(
    text,
    array,
    arrayElements(text, array).length > 0,
    (indent, multiline) => formatted(value, indent, multiline),
  );
}

export function replaceValue(text: string, range: ValueRange, value: unknown): string {
  const multiline = text.slice(range.start, range.end).includes("\n");
  const indent = lineIndent(text, range.start);
  return text.slice(0, range.start) + formatted(value, indent, multiline) + text.slice(range.end);
}

/** Rebuilds only the array separators; retained element bytes stay verbatim. */
export function removeArrayElements(
  text: string,
  array: ValueRange,
  removeIndexes: ReadonlySet<number>,
): string {
  const elements = arrayElements(text, array);
  const retained = elements
    .filter((_element, index) => !removeIndexes.has(index))
    .map((element) => text.slice(element.start, element.end));
  const multiline = text.slice(array.start, array.end).includes("\n");
  let interior = retained.join(",");
  if (multiline && retained.length > 0) {
    const closingIndent = lineIndent(text, array.end - 1);
    const elementIndent = `${closingIndent}  `;
    interior = `\n${elementIndent}${retained.join(`,\n${elementIndent}`)}\n${closingIndent}`;
  }
  return text.slice(0, array.start + 1) + interior + text.slice(array.end - 1);
}

export type { PropertyRange, ValueRange };
