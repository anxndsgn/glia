import { describe, expect, test } from "bun:test";
import {
  createDeclaration,
  declarationBytes,
  parseDeclaration,
} from "../../src/core/config/glia-json.ts";

describe("Project Declaration", () => {
  test("uses the slim canonical schema", () => {
    expect(declarationBytes(createDeclaration("prj_test"))).toBe(
      '{\n  "schemaVersion": 1,\n  "projectId": "prj_test",\n  "store": {},\n  "secretDetection": {\n    "enabled": true\n  }\n}\n',
    );
  });

  test("preserves unrecognized top-level and nested fields", () => {
    const declaration = parseDeclaration({
      schemaVersion: 1,
      projectId: "prj_test",
      store: { remote: "/tmp/store.git", future: 1 },
      secretDetection: { enabled: false, future: 2 },
      contexts: { legacy: true },
    });
    expect(declaration.unknownKeys).toEqual({ contexts: { legacy: true } });
    expect(declaration.store.unknownKeys).toEqual({ future: 1 });
    expect(declaration.secretDetection.unknownKeys).toEqual({ future: 2 });
    expect(declarationBytes(declaration)).toContain('"contexts"');
  });
});
