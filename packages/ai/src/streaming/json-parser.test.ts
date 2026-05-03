import { describe, it, expect } from "vitest"
import { createIncrementalJsonParser } from "./json-parser"

function parseChunked(chunks: string[]) {
  const parser = createIncrementalJsonParser()
  for (const chunk of chunks) {
    parser.push(chunk)
  }
  parser.end()
  return parser.partial
}

function getField(parsed: any, key: string): any {
  if (parsed?._tag === "object") {
    const entry = parsed.entries.find(([k]: [string, any]) => k === key)
    return entry?.[1]
  }
}

function getStringField(parsed: any, key: string): string | undefined {
  const field = getField(parsed, key)
  return field?._tag === "string" ? field.value : undefined
}

// ============================================================================
// A. Escape sequences — single chunk (baseline, should pass)
// ============================================================================

describe("A. Escape sequences — single chunk baseline", () => {
  it("decodes \\n", () => {
    const result = parseChunked(['{"x":"a\\nb"}'])
    expect(getStringField(result, "x")).toBe("a\nb")
  })

  it("decodes \\t", () => {
    const result = parseChunked(['{"x":"a\\tb"}'])
    expect(getStringField(result, "x")).toBe("a\tb")
  })

  it("decodes \\r", () => {
    const result = parseChunked(['{"x":"a\\rb"}'])
    expect(getStringField(result, "x")).toBe("a\rb")
  })

  it("decodes \\b", () => {
    const result = parseChunked(['{"x":"a\\bb"}'])
    expect(getStringField(result, "x")).toBe("a\bb")
  })

  it("decodes \\f", () => {
    const result = parseChunked(['{"x":"a\\fb"}'])
    expect(getStringField(result, "x")).toBe("a\fb")
  })

  it("decodes \\\\", () => {
    const result = parseChunked(['{"x":"a\\\\b"}'])
    expect(getStringField(result, "x")).toBe("a\\b")
  })

  it('decodes \\"', () => {
    const result = parseChunked(['{"x":"a\\"b"}'])
    expect(getStringField(result, "x")).toBe('a"b')
  })

  it("decodes \\/", () => {
    const result = parseChunked(['{"x":"a\\/b"}'])
    expect(getStringField(result, "x")).toBe("a/b")
  })

  it("decodes \\u0041 to A", () => {
    const result = parseChunked(['{"x":"\\u0041"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("decodes \\u000a to newline", () => {
    const result = parseChunked(['{"x":"a\\u000ab"}'])
    expect(getStringField(result, "x")).toBe("a\nb")
  })
})

// ============================================================================
// B. Escape sequences — split after backslash (RED — will fail)
// ============================================================================

describe("B. Escape sequences — split after backslash", () => {
  it("decodes \\n split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', 'nb"}'])
    expect(getStringField(result, "x")).toBe("a\nb")
  })

  it("decodes \\t split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', 'tb"}'])
    expect(getStringField(result, "x")).toBe("a\tb")
  })

  it("decodes \\r split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', 'rb"}'])
    expect(getStringField(result, "x")).toBe("a\rb")
  })

  it("decodes \\b split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', 'bb"}'])
    expect(getStringField(result, "x")).toBe("a\bb")
  })

  it("decodes \\f split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', 'fb"}'])
    expect(getStringField(result, "x")).toBe("a\fb")
  })

  it("decodes \\\\ split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', '\\b"}'])
    expect(getStringField(result, "x")).toBe("a\\b")
  })

  it('decodes \\" split after backslash', () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"say \\', '"hi\\""}'])
    expect(getStringField(result, "x")).toBe('say "hi"')
  })

  it("decodes \\/ split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', '/b"}'])
    expect(getStringField(result, "x")).toBe("a/b")
  })

  it("decodes \\u0041 split after backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"\\', 'u0041"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("decodes multiple split escapes across multiple chunks", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"x":"line1\\',
      'nline2\\',
      'nline3"}',
    ])
    expect(getStringField(result, "x")).toBe("line1\nline2\nline3")
  })

  it("decodes split escape followed by more content in same chunk", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"x":"hello\\',
      'nworld and more text"}',
    ])
    expect(getStringField(result, "x")).toBe("hello\nworld and more text")
  })
})

// ============================================================================
// C. Unicode escapes — various split points (RED — will fail)
// ============================================================================

describe("C. Unicode escapes — split at various points", () => {
  it("baseline: \\u0041 in one chunk", () => {
    const result = parseChunked(['{"x":"\\u0041"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("split after \\u", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"\\u', '0041"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("split after \\u0", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"\\u0', '041"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("split after \\u00", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"\\u00', '41"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("split after \\u004", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"\\u004', '1"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("split backslash from u0041", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"\\', 'u0041"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("unicode escape for newline \\u000a split after \\u00", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\u00', '0ab"}'])
    expect(getStringField(result, "x")).toBe("a\nb")
  })
})

// ============================================================================
// D. Invalid escape handling
// ============================================================================

describe("D. Invalid escape handling", () => {
  it("\\q — backslash should not be silently dropped", () => {
    // Current behavior drops the backslash, producing "aq" instead of "a\\q"
    const result = parseChunked(['{"x":"a\\qz"}'])
    const val = getStringField(result, "x")
    // At minimum the backslash should be preserved
    expect(val).toContain("\\")
  })

  it("\\x — backslash should not be silently dropped", () => {
    const result = parseChunked(['{"x":"a\\xz"}'])
    const val = getStringField(result, "x")
    expect(val).toContain("\\")
  })

  it("trailing backslash before end() with no following char", () => {
    // Parser should handle gracefully — not crash
    const result = parseChunked(['{"x":"abc\\'])
    const val = getStringField(result, "x")
    // Value should at least contain "abc"
    expect(val).toBeDefined()
    expect(val!.startsWith("abc")).toBe(true)
  })

  it("\\u with fewer than 4 hex digits before end", () => {
    const result = parseChunked(['{"x":"\\u00"}'])
    // Should not crash; value is implementation-defined but should exist
    expect(getStringField(result, "x")).toBeDefined()
  })

  it("\\u with invalid hex chars should not silently decode wrong character", () => {
    // \\u12zz — parseInt("12zz", 16) returns 0x12, which is wrong
    const result = parseChunked(['{"x":"\\u12zz"}'])
    const val = getStringField(result, "x")
    // Should NOT decode to String.fromCharCode(0x12)
    expect(val).not.toBe(String.fromCharCode(0x12) + "zz")
  })
})

// ============================================================================
// E. Quote tracking edge cases
// ============================================================================

describe("E. Quote tracking edge cases", () => {
  it("empty string value", () => {
    const result = parseChunked(['{"x":""}'])
    expect(getStringField(result, "x")).toBe("")
  })

  it("escaped quote at chunk boundary", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', '"b"}'])
    expect(getStringField(result, "x")).toBe('a"b')
  })

  it("two backslashes before quote — quote closes the string", () => {
    // \\\\" in JSON source = two real backslashes, then closing quote
    const result = parseChunked(['{"x":"a\\\\\\\\"}'])
    expect(getStringField(result, "x")).toBe("a\\\\")
  })

  it("one backslash before quote — quote is escaped", () => {
    const result = parseChunked(['{"x":"a\\\\\\"b"}'])
    expect(getStringField(result, "x")).toBe('a\\"b')
  })

  it("escaped quote split across chunks — backslash in chunk 1, quote in chunk 2", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"x":"before\\',
      '"after"}',
    ])
    expect(getStringField(result, "x")).toBe('before"after')
  })

  it("double backslash split across chunks", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"x":"a\\',
      '\\b"}',
    ])
    expect(getStringField(result, "x")).toBe("a\\b")
  })

  it("double backslash then quote, split so second backslash starts chunk 2", () => {
    // RED - chunk boundary bug
    // Source: "a\\\\" → value should be "a\\"
    // Split: chunk1 has a\\, chunk2 has \\"
    const result = parseChunked([
      '{"x":"a\\',
      '\\"}',
    ])
    expect(getStringField(result, "x")).toBe("a\\")
  })
})

// ============================================================================
// F. Unquoted token boundary tests
// ============================================================================

describe("F. Unquoted tokens — single chunk", () => {
  it("true", () => {
    const result = parseChunked(['{"x":true}'])
    const field = getField(result, "x")
    expect(field).toEqual({ _tag: "boolean", value: true, state: "complete" })
  })

  it("false", () => {
    const result = parseChunked(['{"x":false}'])
    const field = getField(result, "x")
    expect(field).toEqual({ _tag: "boolean", value: false, state: "complete" })
  })

  it("null", () => {
    const result = parseChunked(['{"x":null}'])
    const field = getField(result, "x")
    expect(field).toEqual({ _tag: "null", state: "complete" })
  })

  it("number", () => {
    const result = parseChunked(['{"x":123}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("number")
    expect(field?.value).toBe("123")
  })
})

describe("F. Unquoted tokens — split across chunks", () => {
  it("true split as tru + e}", () => {
    const result = parseChunked(['{"x":tru', 'e}'])
    const field = getField(result, "x")
    expect(field).toEqual({ _tag: "boolean", value: true, state: "complete" })
  })

  it("false split as fal + se}", () => {
    const result = parseChunked(['{"x":fal', 'se}'])
    const field = getField(result, "x")
    expect(field).toEqual({ _tag: "boolean", value: false, state: "complete" })
  })

  it("null split as nu + ll}", () => {
    const result = parseChunked(['{"x":nu', 'll}'])
    const field = getField(result, "x")
    expect(field).toEqual({ _tag: "null", state: "complete" })
  })

  it("number 123 split as 1 + 23}", () => {
    const result = parseChunked(['{"x":1', '23}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("number")
    expect(field?.value).toBe("123")
  })
})

describe("F. Array unquoted tokens — off-by-one bug", () => {
  it("array with true split as [tru + e]", () => {
    // RED - array off-by-one bug
    const result = parseChunked(["[tru", "e]"])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items.length).toBe(1)
      expect(result.items[0]).toEqual({ _tag: "boolean", value: true, state: "complete" })
    }
  })

  it("array with 123 split as [12 + 3]", () => {
    // RED - array off-by-one bug
    const result = parseChunked(["[12", "3]"])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items.length).toBe(1)
      expect(result.items[0]?._tag).toBe("number")
      expect(result.items[0]?.value).toBe("123")
    }
  })

  it("array with null split as [nul + l]", () => {
    // RED - array off-by-one bug
    const result = parseChunked(["[nul", "l]"])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items.length).toBe(1)
      expect(result.items[0]).toEqual({ _tag: "null", state: "complete" })
    }
  })

  it("array with false split as [fals + e]", () => {
    // RED - array off-by-one bug
    const result = parseChunked(["[fals", "e]"])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items.length).toBe(1)
      expect(result.items[0]).toEqual({ _tag: "boolean", value: false, state: "complete" })
    }
  })

  it("array with string split as [\"ab + c\"]", () => {
    const result = parseChunked(['["ab', 'c"]'])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items.length).toBe(1)
      expect(result.items[0]?.value).toBe("abc")
    }
  })
})

// ============================================================================
// G. Structural delimiter boundaries
// ============================================================================

describe("G. Structural delimiter boundaries", () => {
  it("object split at every structural point", () => {
    const result = parseChunked(["{", '"x"', ":", '"y"', "}"])
    expect(getStringField(result, "x")).toBe("y")
  })

  it("object with opening brace alone", () => {
    const result = parseChunked(["{", '"x":"y"}'])
    expect(getStringField(result, "x")).toBe("y")
  })

  it("array split at every element", () => {
    const result = parseChunked(["[", '"a"', ",", '"b"', "]"])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items.map((i: any) => i.value)).toEqual(["a", "b"])
    }
  })

  it("nested object at chunk boundary", () => {
    const result = parseChunked(['{"a":', '{"b":"c"', "}}"])
    const inner = getField(result, "a")
    expect(inner?._tag).toBe("object")
    expect(getStringField(inner, "b")).toBe("c")
  })

  it("nested array inside object at chunk boundary", () => {
    const result = parseChunked(['{"a":[', '"x","y"', "]}"])
    const arr = getField(result, "a")
    expect(arr?._tag).toBe("array")
    if (arr?._tag === "array") {
      expect(arr.items.map((i: any) => i.value)).toEqual(["x", "y"])
    }
  })

  it("closing brace in its own chunk", () => {
    const result = parseChunked(['{"x":"y"', "}"])
    expect(getStringField(result, "x")).toBe("y")
  })

  it("multiple fields with comma at chunk boundary", () => {
    const result = parseChunked(['{"a":"1"', ',', '"b":"2"}'])
    expect(getStringField(result, "a")).toBe("1")
    expect(getStringField(result, "b")).toBe("2")
  })
})

// ============================================================================
// H. Multiple escapes in sequence
// ============================================================================

describe("H. Multiple escapes in sequence", () => {
  it("three newlines in one chunk", () => {
    const result = parseChunked(['{"x":"a\\nb\\nc\\nd"}'])
    expect(getStringField(result, "x")).toBe("a\nb\nc\nd")
  })

  it("three newlines each split at backslash", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"x":"a\\',
      'nb\\',
      'nc\\',
      'nd"}',
    ])
    expect(getStringField(result, "x")).toBe("a\nb\nc\nd")
  })

  it("a\\\\nb — double backslash then n (not a newline)", () => {
    // Source JSON: "a\\\\nb" → value: "a\\nb" (backslash, n, b — not a newline)
    // Wait — actually "a\\\\nb" in JSON source means: a, \\, n, b → "a\nb" with literal backslash-n? No.
    // Let me be precise: in the JSON source string a\\nb, the \\ decodes to \, then n is literal n
    const result = parseChunked(['{"x":"a\\\\nb"}'])
    expect(getStringField(result, "x")).toBe("a\\nb")
  })

  it("a\\\\nb split so first backslash ends chunk", () => {
    // RED - chunk boundary bug
    const result = parseChunked(['{"x":"a\\', '\\nb"}'])
    expect(getStringField(result, "x")).toBe("a\\nb")
  })

  it("a\\\\\\\\n — four backslashes then n", () => {
    // JSON source: a\\\\\\\\n → value: a\\\\n (two real backslashes then literal n)
    const result = parseChunked(['{"x":"a\\\\\\\\n"}'])
    expect(getStringField(result, "x")).toBe("a\\\\n")
  })

  it("mixed escapes: tab then newline then quote", () => {
    const result = parseChunked(['{"x":"a\\tb\\nc\\"d"}'])
    expect(getStringField(result, "x")).toBe('a\tb\nc"d')
  })

  it("mixed escapes all split at backslashes", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"x":"a\\',
      'tb\\',
      'nc\\',
      '"d"}',
    ])
    expect(getStringField(result, "x")).toBe('a\tb\nc"d')
  })
})

// ============================================================================
// I. Real-world tool call argument patterns
// ============================================================================

describe("I. Real-world tool call patterns", () => {
  it("write tool JSON with multiline content — single chunk", () => {
    const json = '{"path":"hello.py","content":"print(\\"hello\\")\\nprint(\\"world\\")\\n"}'
    const result = parseChunked([json])
    expect(getStringField(result, "path")).toBe("hello.py")
    expect(getStringField(result, "content")).toBe('print("hello")\nprint("world")\n')
  })

  it("write tool JSON — split at first newline escape backslash", () => {
    // RED - chunk boundary bug — the exact Kimi K2.6 pattern
    const result = parseChunked([
      '{"path":"hello.py","content":"print(\\"hello\\")\\',
      'nprint(\\"world\\")\\',
      'n"}',
    ])
    expect(getStringField(result, "path")).toBe("hello.py")
    expect(getStringField(result, "content")).toBe('print("hello")\nprint("world")\n')
  })

  it("write tool JSON — char-by-char streaming", () => {
    // RED - chunk boundary bug
    const json = '{"path":"a.ts","content":"x\\ny"}'
    const chunks = json.split("") // each char is its own chunk
    const result = parseChunked(chunks)
    expect(getStringField(result, "path")).toBe("a.ts")
    expect(getStringField(result, "content")).toBe("x\ny")
  })

  it("write tool JSON — split right before closing quote of content", () => {
    const result = parseChunked([
      '{"path":"a.ts","content":"hello world',
      '"}',
    ])
    expect(getStringField(result, "content")).toBe("hello world")
  })

  it("write tool JSON with tabs and newlines — split at each escape", () => {
    // RED - chunk boundary bug
    const result = parseChunked([
      '{"content":"if (x) {\\',
      'n\\',
      'tconsole.log(x);\\',
      'n}"}',
    ])
    expect(getStringField(result, "content")).toBe("if (x) {\n\tconsole.log(x);\n}")
  })

  it("large multiline content — realistic token-sized chunks", () => {
    // RED - chunk boundary bug
    // Simulate ~20 char chunks with escapes landing at boundaries
    const result = parseChunked([
      '{"path":"index.ts",',
      '"content":"const x ',
      '= 1;\\nconst y = 2;',
      '\\nconst z = x + y;',
      '\\nconsole.log(z);\\',
      'n"}',
    ])
    expect(getStringField(result, "path")).toBe("index.ts")
    expect(getStringField(result, "content")).toBe(
      "const x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\n"
    )
  })
})

// ============================================================================
// J. EOF with pending escape state
// ============================================================================

describe("J. EOF with pending escape state", () => {
  it("trailing backslash at EOF is preserved", () => {
    const result = parseChunked(['{"x":"abc\\'])
    const field = getStringField(result, "x")
    expect(field).toBe("abc\\")
  })

  it("trailing \\u00 at EOF preserves partial unicode", () => {
    const result = parseChunked(['{"x":"abc\\u00'])
    const field = getStringField(result, "x")
    expect(field).toBe("abc\\u00")
  })
})

// ============================================================================
// K. Character-by-character streaming
// ============================================================================

describe("K. Character-by-character streaming", () => {
  function charByChar(json: string) {
    return parseChunked(json.split(""))
  }

  it('{"content":"hello\\nworld"} char by char', () => {
    const result = charByChar('{"content":"hello\\nworld"}')
    expect(getStringField(result, "content")).toBe("hello\nworld")
  })

  it('{"content":"a\\\\b"} char by char', () => {
    const result = charByChar('{"content":"a\\\\b"}')
    expect(getStringField(result, "content")).toBe("a\\b")
  })

  it('{"content":"\\u0041"} char by char', () => {
    const result = charByChar('{"content":"\\u0041"}')
    expect(getStringField(result, "content")).toBe("A")
  })

  it('{"a":"1","b":"2","c":"3"} char by char', () => {
    const result = charByChar('{"a":"1","b":"2","c":"3"}')
    expect(getStringField(result, "a")).toBe("1")
    expect(getStringField(result, "b")).toBe("2")
    expect(getStringField(result, "c")).toBe("3")
  })

  it('nested object char by char', () => {
    const result = charByChar('{"a":{"b":"c\\nd"}}')
    const inner = getField(result, "a")
    expect(getStringField(inner, "b")).toBe("c\nd")
  })

  it('array of strings char by char', () => {
    const result = charByChar('["a\\nb","c\\td"]')
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      expect(result.items[0]?.value).toBe("a\nb")
      expect(result.items[1]?.value).toBe("c\td")
    }
  })

  it('multiple escapes char by char', () => {
    const result = charByChar('{"x":"\\n\\t\\r\\\\"}')
    expect(getStringField(result, "x")).toBe("\n\t\r\\")
  })

  it('unicode escape for é char by char', () => {
    const result = charByChar('{"x":"caf\\u00e9"}')
    expect(getStringField(result, "x")).toBe("café")
  })
})

// ============================================================================
// L. Chunk splits at every possible position
// ============================================================================

describe("L. Chunk splits at every possible position", () => {
  function testAllSplits(json: string, key: string, expected: string) {
    for (let i = 1; i < json.length; i++) {
      const chunks = [json.slice(0, i), json.slice(i)]
      const result = parseChunked(chunks)
      const val = getStringField(result, key)
      if (val !== expected) {
        throw new Error(
          `Split at ${i}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}. ` +
          `Chunks: ${JSON.stringify(chunks)}`
        )
      }
    }
  }

  it('{"x":"a\\nb"} — all two-chunk splits produce correct result', () => {
    testAllSplits('{"x":"a\\nb"}', "x", "a\nb")
  })

  it('{"x":"a\\tb"} — all two-chunk splits', () => {
    testAllSplits('{"x":"a\\tb"}', "x", "a\tb")
  })

  it('{"x":"a\\\\b"} — all two-chunk splits', () => {
    testAllSplits('{"x":"a\\\\b"}', "x", "a\\b")
  })

  it('{"x":"a\\"b"} — all two-chunk splits', () => {
    testAllSplits('{"x":"a\\"b"}', "x", 'a"b')
  })

  it('{"x":"\\u0041"} — all two-chunk splits', () => {
    testAllSplits('{"x":"\\u0041"}', "x", "A")
  })

  it('{"x":"a\\nb\\tc"} — all two-chunk splits', () => {
    testAllSplits('{"x":"a\\nb\\tc"}', "x", "a\nb\tc")
  })

  it('{"x":"\\\\n"} — all two-chunk splits (backslash then literal n)', () => {
    testAllSplits('{"x":"\\\\n"}', "x", "\\n")
  })
})

// ============================================================================
// M. Multi-byte/complex escape sequences in sequence
// ============================================================================

describe("M. Complex escape sequences in sequence", () => {
  it("multiple consecutive escapes: \\n\\t\\r\\n", () => {
    const result = parseChunked(['{"x":"\\n\\t\\r\\n"}'])
    expect(getStringField(result, "x")).toBe("\n\t\r\n")
  })

  it("alternating escapes and text: a\\nb\\tc\\rd", () => {
    const result = parseChunked(['{"x":"a\\nb\\tc\\rd"}'])
    expect(getStringField(result, "x")).toBe("a\nb\tc\rd")
  })

  it("all standard escapes in one string", () => {
    const result = parseChunked(['{"x":"\\n\\t\\r\\b\\f\\\\\\\"\\/"}'])
    expect(getStringField(result, "x")).toBe('\n\t\r\b\f\\\"/')
  })

  it("double backslash followed by n: \\\\n → backslash then literal n", () => {
    const result = parseChunked(['{"x":"\\\\n"}'])
    expect(getStringField(result, "x")).toBe("\\n")
  })

  it("triple backslash followed by n: \\\\\\n → backslash then newline", () => {
    const result = parseChunked(['{"x":"\\\\\\n"}'])
    expect(getStringField(result, "x")).toBe("\\\n")
  })

  it("quadruple backslash: \\\\\\\\ → two backslashes", () => {
    const result = parseChunked(['{"x":"\\\\\\\\"}'])
    expect(getStringField(result, "x")).toBe("\\\\")
  })

  it("double backslash then n — split after first backslash", () => {
    const result = parseChunked(['{"x":"\\', '\\n"}'])
    expect(getStringField(result, "x")).toBe("\\n")
  })

  it("triple backslash then n — split after second backslash", () => {
    const result = parseChunked(['{"x":"\\\\', '\\n"}'])
    expect(getStringField(result, "x")).toBe("\\\n")
  })

  it("quadruple backslash — split after second backslash", () => {
    const result = parseChunked(['{"x":"\\\\', '\\\\"}'])
    expect(getStringField(result, "x")).toBe("\\\\")
  })

  it("all escapes split at every backslash", () => {
    const result = parseChunked([
      '{"x":"\\', 'n\\', 't\\', 'r\\', 'b\\', 'f\\', '\\\\', '"\\/"}',
    ])
    expect(getStringField(result, "x")).toBe('\n\t\r\b\f\\\"/')
  })
})

// ============================================================================
// N. Nested objects and arrays with escapes
// ============================================================================

describe("N. Nested objects and arrays with escapes", () => {
  it('nested object: {"a":{"b":"hello\\nworld"}}', () => {
    const result = parseChunked(['{"a":{"b":"hello\\nworld"}}'])
    const inner = getField(result, "a")
    expect(getStringField(inner, "b")).toBe("hello\nworld")
  })

  it("nested object — split at escape boundary", () => {
    const result = parseChunked(['{"a":{"b":"hello\\', 'nworld"}}'])
    const inner = getField(result, "a")
    expect(getStringField(inner, "b")).toBe("hello\nworld")
  })

  it('array of objects with escapes', () => {
    const result = parseChunked(['{"a":[{"b":"x\\ny"},{"c":"p\\tq"}]}'])
    const arr = getField(result, "a")
    expect(arr?._tag).toBe("array")
    if (arr?._tag === "array") {
      expect(getStringField(arr.items[0], "b")).toBe("x\ny")
      expect(getStringField(arr.items[1], "c")).toBe("p\tq")
    }
  })

  it("array of objects — split at escape boundaries", () => {
    const result = parseChunked(['{"a":[{"b":"x\\', 'ny"},{"c":"p\\', 'tq"}]}'])
    const arr = getField(result, "a")
    expect(arr?._tag).toBe("array")
    if (arr?._tag === "array") {
      expect(getStringField(arr.items[0], "b")).toBe("x\ny")
      expect(getStringField(arr.items[1], "c")).toBe("p\tq")
    }
  })

  it('nested arrays: [["a\\nb","c\\td"]]', () => {
    const result = parseChunked(['[["a\\nb","c\\td"]]'])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      const inner = result.items[0]
      expect(inner?._tag).toBe("array")
      if (inner?._tag === "array") {
        expect(inner.items[0]?.value).toBe("a\nb")
        expect(inner.items[1]?.value).toBe("c\td")
      }
    }
  })

  it("nested arrays — split at escape boundaries", () => {
    const result = parseChunked(['[["a\\', 'nb","c\\', 'td"]]'])
    expect(result?._tag).toBe("array")
    if (result?._tag === "array") {
      const inner = result.items[0]
      if (inner?._tag === "array") {
        expect(inner.items[0]?.value).toBe("a\nb")
        expect(inner.items[1]?.value).toBe("c\td")
      }
    }
  })

  it("deeply nested: 3 levels with escape at leaf", () => {
    const result = parseChunked(['{"a":{"b":{"c":"\\n"}}}'])
    const b = getField(getField(result, "a"), "b")
    expect(getStringField(b, "c")).toBe("\n")
  })
})

// ============================================================================
// O. Empty and minimal values
// ============================================================================

describe("O. Empty and minimal values", () => {
  it("empty object", () => {
    const result = parseChunked(["{}"])
    expect(result?._tag).toBe("object")
  })

  it("empty array", () => {
    const result = parseChunked(["[]"])
    expect(result?._tag).toBe("array")
  })

  it('empty string value: {"x":""}', () => {
    const result = parseChunked(['{"x":""}'])
    expect(getStringField(result, "x")).toBe("")
  })

  it('null value: {"x":null}', () => {
    const result = parseChunked(['{"x":null}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("null")
  })

  it('true value: {"x":true}', () => {
    const result = parseChunked(['{"x":true}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("boolean")
    expect(field?.value).toBe(true)
  })

  it('false value: {"x":false}', () => {
    const result = parseChunked(['{"x":false}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("boolean")
    expect(field?.value).toBe(false)
  })

  it('zero: {"x":0}', () => {
    const result = parseChunked(['{"x":0}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("number")
    expect(field?.value).toBe("0")
  })

  it('negative: {"x":-1}', () => {
    const result = parseChunked(['{"x":-1}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("number")
    expect(field?.value).toBe("-1")
  })

  it('float: {"x":3.14}', () => {
    const result = parseChunked(['{"x":3.14}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("number")
    expect(field?.value).toBe("3.14")
  })

  it('scientific: {"x":1e10}', () => {
    const result = parseChunked(['{"x":1e10}'])
    const field = getField(result, "x")
    expect(field?._tag).toBe("number")
    expect(field?.value).toBe("1e10")
  })

  it("empty object char by char", () => {
    const result = parseChunked(["{", "}"])
    expect(result?._tag).toBe("object")
  })

  it("empty array char by char", () => {
    const result = parseChunked(["[", "]"])
    expect(result?._tag).toBe("array")
  })

  it("empty string char by char", () => {
    const result = parseChunked(['{', '"', 'x', '"', ':', '"', '"', '}'])
    expect(getStringField(result, "x")).toBe("")
  })
})

// ============================================================================
// P. Large realistic payloads
// ============================================================================

describe("P. Large realistic payloads", () => {
  const codeContent = [
    'import { Effect } from "effect";',
    "",
    "const main = Effect.gen(function* () {",
    '  const name = yield* Effect.succeed("world");',
    "  console.log(`hello ${name}`);",
    "  yield* Effect.sleep(1000);",
    '  console.log("done");',
    "});",
    "",
    "const program = main.pipe(",
    "  Effect.catchAll((e) => {",
    "    console.error(e);",
    "    return Effect.void;",
    "  })",
    ");",
    "",
    "Effect.runPromise(program);",
    "",
    "export { main, program };",
    "",
  ].join("\n")

  // Build the JSON with proper escaping
  const jsonContent = JSON.stringify({ path: "src/index.ts", content: codeContent })

  it("large payload — single chunk", () => {
    const result = parseChunked([jsonContent])
    expect(getStringField(result, "path")).toBe("src/index.ts")
    expect(getStringField(result, "content")).toBe(codeContent)
  })

  it("large payload — ~80 char chunks", () => {
    const chunks: string[] = []
    for (let i = 0; i < jsonContent.length; i += 80) {
      chunks.push(jsonContent.slice(i, i + 80))
    }
    const result = parseChunked(chunks)
    expect(getStringField(result, "path")).toBe("src/index.ts")
    expect(getStringField(result, "content")).toBe(codeContent)
  })

  it("large payload — 3 char chunks", () => {
    const chunks: string[] = []
    for (let i = 0; i < jsonContent.length; i += 3) {
      chunks.push(jsonContent.slice(i, i + 3))
    }
    const result = parseChunked(chunks)
    expect(getStringField(result, "path")).toBe("src/index.ts")
    expect(getStringField(result, "content")).toBe(codeContent)
  })

  it("large payload — char by char", () => {
    const result = parseChunked(jsonContent.split(""))
    expect(getStringField(result, "path")).toBe("src/index.ts")
    expect(getStringField(result, "content")).toBe(codeContent)
  })
})

// ============================================================================
// Q. Surrogate pairs and edge unicode
// ============================================================================

describe("Q. Unicode edge cases", () => {
  it("\\u0000 — null char", () => {
    const result = parseChunked(['{"x":"a\\u0000b"}'])
    expect(getStringField(result, "x")).toBe("a\u0000b")
  })

  it("\\u001f — control char", () => {
    const result = parseChunked(['{"x":"a\\u001fb"}'])
    expect(getStringField(result, "x")).toBe("a\u001fb")
  })

  it("\\u00e9 — é", () => {
    const result = parseChunked(['{"x":"caf\\u00e9"}'])
    expect(getStringField(result, "x")).toBe("café")
  })

  it("\\u4e16 — 世", () => {
    const result = parseChunked(['{"x":"\\u4e16"}'])
    expect(getStringField(result, "x")).toBe("世")
  })

  it("two consecutive unicode escapes: \\u0048\\u0069 → Hi", () => {
    const result = parseChunked(['{"x":"\\u0048\\u0069"}'])
    expect(getStringField(result, "x")).toBe("Hi")
  })

  it("two consecutive unicode escapes char by char", () => {
    const result = parseChunked('{"x":"\\u0048\\u0069"}'.split(""))
    expect(getStringField(result, "x")).toBe("Hi")
  })

  it("\\u0041 split: \\ | u | 0 | 0 | 4 | 1", () => {
    const result = parseChunked(['{"x":"', "\\", "u", "0", "0", "4", "1", '"}'])
    expect(getStringField(result, "x")).toBe("A")
  })

  it("\\u00e9 — all two-chunk splits", () => {
    const json = '{"x":"\\u00e9"}'
    for (let i = 1; i < json.length; i++) {
      const chunks = [json.slice(0, i), json.slice(i)]
      const result = parseChunked(chunks)
      const val = getStringField(result, "x")
      expect(val).toBe("é")
    }
  })

  it("\\u4e16 — all two-chunk splits", () => {
    const json = '{"x":"\\u4e16"}'
    for (let i = 1; i < json.length; i++) {
      const result = parseChunked([json.slice(0, i), json.slice(i)])
      expect(getStringField(result, "x")).toBe("世")
    }
  })
})

// ============================================================================
// R. Keys with escapes
// ============================================================================

describe("R. Keys with escapes", () => {
  it("escape in key: hello\\nworld", () => {
    const json = '{"hello\\nworld":"value"}'
    const result = parseChunked([json])
    const entry = result?._tag === "object"
      ? result.entries.find(([k]: [string, any]) => k === "hello\nworld")
      : undefined
    expect(entry).toBeDefined()
    expect(entry?.[1]?.value).toBe("value")
  })

  it("unicode escape in key: key\\u0041 → keyA", () => {
    const json = '{"key\\u0041":"value"}'
    const result = parseChunked([json])
    const entry = result?._tag === "object"
      ? result.entries.find(([k]: [string, any]) => k === "keyA")
      : undefined
    expect(entry).toBeDefined()
    expect(entry?.[1]?.value).toBe("value")
  })

  it("escape in key — split at backslash", () => {
    const result = parseChunked(['{"hello\\', 'nworld":"value"}'])
    const entry = result?._tag === "object"
      ? result.entries.find(([k]: [string, any]) => k === "hello\nworld")
      : undefined
    expect(entry).toBeDefined()
    expect(entry?.[1]?.value).toBe("value")
  })

  it("unicode escape in key — split at backslash", () => {
    const result = parseChunked(['{"key\\', 'u0041":"value"}'])
    const entry = result?._tag === "object"
      ? result.entries.find(([k]: [string, any]) => k === "keyA")
      : undefined
    expect(entry).toBeDefined()
    expect(entry?.[1]?.value).toBe("value")
  })
})

// ============================================================================
// S. Mixed content types in one object
// ============================================================================

describe("S. Mixed content types in one object", () => {
  const json = '{"s":"hello\\nworld","n":42,"b":true,"a":[1,2],"o":{"x":"y\\tz"}}'

  it("single chunk", () => {
    const result = parseChunked([json])
    expect(getStringField(result, "s")).toBe("hello\nworld")
    expect(getField(result, "n")?.value).toBe("42")
    expect(getField(result, "b")?.value).toBe(true)
    const arr = getField(result, "a")
    expect(arr?._tag).toBe("array")
    if (arr?._tag === "array") {
      expect(arr.items.map((i: any) => i.value)).toEqual(["1", "2"])
    }
    const obj = getField(result, "o")
    expect(getStringField(obj, "x")).toBe("y\tz")
  })

  it("split at escape in s field", () => {
    const result = parseChunked([
      '{"s":"hello\\',
      'nworld","n":42,"b":true,"a":[1,2],"o":{"x":"y\\tz"}}',
    ])
    expect(getStringField(result, "s")).toBe("hello\nworld")
    expect(getStringField(getField(result, "o"), "x")).toBe("y\tz")
  })

  it("split at escape in nested o field", () => {
    const result = parseChunked([
      '{"s":"hello\\nworld","n":42,"b":true,"a":[1,2],"o":{"x":"y\\',
      'tz"}}',
    ])
    expect(getStringField(result, "s")).toBe("hello\nworld")
    expect(getStringField(getField(result, "o"), "x")).toBe("y\tz")
  })

  it("char by char", () => {
    const result = parseChunked(json.split(""))
    expect(getStringField(result, "s")).toBe("hello\nworld")
  })

  it("~10 char chunks", () => {
    const chunks: string[] = []
    for (let i = 0; i < json.length; i += 10) {
      chunks.push(json.slice(i, i + 10))
    }
    const result = parseChunked(chunks)
    expect(getStringField(result, "s")).toBe("hello\nworld")
    expect(getStringField(getField(result, "o"), "x")).toBe("y\tz")
  })
})

// ============================================================================
// T. Stress: random chunk sizes
// ============================================================================

describe("T. Stress — deterministic pseudo-random chunk sizes", () => {
  function splitWithSeed(json: string, seed: number): string[] {
    // Simple LCG for deterministic pseudo-random
    let state = seed
    function nextRand(min: number, max: number) {
      state = (state * 1664525 + 1013904223) & 0x7fffffff
      return min + (state % (max - min + 1))
    }
    const chunks: string[] = []
    let i = 0
    while (i < json.length) {
      const size = nextRand(1, 10)
      chunks.push(json.slice(i, i + size))
      i += size
    }
    return chunks
  }

  const testCases = [
    { json: '{"x":"hello\\nworld\\t!"}', key: "x", expected: "hello\nworld\t!" },
    { json: '{"x":"\\u0041\\u0042\\u0043"}', key: "x", expected: "ABC" },
    { json: '{"x":"a\\\\b\\nc\\td"}', key: "x", expected: "a\\b\nc\td" },
    { json: '{"x":"line1\\nline2\\nline3\\nline4\\nline5"}', key: "x", expected: "line1\nline2\nline3\nline4\nline5" },
  ]

  for (const { json, key, expected } of testCases) {
    for (let seed = 1; seed <= 5; seed++) {
      it(`${json.slice(0, 30)}... seed=${seed}`, () => {
        const chunks = splitWithSeed(json, seed)
        const result = parseChunked(chunks)
        expect(getStringField(result, key)).toBe(expected)
      })
    }
  }
})
