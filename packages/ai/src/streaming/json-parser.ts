/**
 * Internal incremental JSON parser.
 * Handles streaming JSON tokenization and tree building.
 * No schema validation, no field events — those are in field-parser.ts.
 */

import type {
  CloseStringResult,
  CompletionState,
  IncrementalJsonParser,
  JsonCollection,
  ParsedValue,
  Pos,
} from "./types"

function resolveUnquotedString(collection: {
  readonly content: string
  readonly state: CompletionState
}): ParsedValue {
  const trimmed = collection.content.trim()

  if (trimmed === "true") return { _tag: "boolean", value: true, state: "complete" }
  if (trimmed === "false") return { _tag: "boolean", value: false, state: "complete" }
  if (trimmed === "null") return { _tag: "null", state: "complete" }
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return { _tag: "number", value: trimmed, state: collection.state }
  }
  return { _tag: "string", value: trimmed, state: collection.state }
}

function collectionToValue(collection: JsonCollection): ParsedValue {
  switch (collection._tag) {
    case "object": {
      const entries: Array<[string, ParsedValue]> = []
      const count = Math.min(collection.keys.length, collection.values.length)
      for (let index = 0; index < count; index += 1) {
        entries.push([collection.keys[index], collection.values[index]])
      }
      return { _tag: "object", entries, state: collection.state }
    }
    case "array":
      return { _tag: "array", items: [...collection.items], state: collection.state }
    case "quotedString":
      return { _tag: "string", value: collection.content, state: collection.state }
    case "unquotedString":
      return resolveUnquotedString(collection)
  }
}

function valueToString(value: ParsedValue): string {
  switch (value._tag) {
    case "string": return value.value
    case "number": return value.value
    case "boolean": return String(value.value)
    case "null": return "null"
    case "object": return `{${value.entries.map(([key, child]) => `${key}: ${valueToString(child)}`).join(", ")}}`
    case "array": return `[${value.items.map(valueToString).join(", ")}]`
  }
}

function isStringComplete(collection: { readonly content: string }): boolean {
  const trimmed = collection.content.trim()
  return (
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    (trimmed !== "" && Number.isFinite(Number(trimmed)))
  )
}

export function createIncrementalJsonParser(): IncrementalJsonParser {
  const collectionStack: JsonCollection[] = []
  const completedValues: ParsedValue[] = []

  function getPos(): Pos {
    if (collectionStack.length < 2) return { _tag: "inNothing" }
    const parent = collectionStack[collectionStack.length - 2]
    switch (parent._tag) {
      case "object":
        return parent.keys.length === parent.values.length
          ? { _tag: "inObjectKey" }
          : { _tag: "inObjectValue" }
      case "array":
        return { _tag: "inArray" }
      default:
        return { _tag: "unknown" }
    }
  }

  function updateQuoteTracking(
    collection: { trailingBackslashes: number; unescapedQuoteCount: number },
    char: string,
  ): void {
    if (char === "\\") {
      collection.trailingBackslashes += 1
      return
    }
    if (char === `"` && collection.trailingBackslashes % 2 === 0) {
      collection.unescapedQuoteCount += 1
    }
    collection.trailingBackslashes = 0
  }

  function completeCollection(state: CompletionState): void {
    const collection = collectionStack.pop()
    if (!collection) return

    collection.state = state
    const value = collectionToValue(collection)

    const parent = collectionStack[collectionStack.length - 1]
    if (!parent) {
      completedValues.push(value)
      return
    }

    switch (parent._tag) {
      case "object":
        if (parent.keys.length === parent.values.length) {
          parent.keys.push(value._tag === "string" ? value.value : valueToString(value))
        } else {
          parent.values.push(value)
        }
        break
      case "array":
        parent.items.push(value)
        break
    }
  }

  function shouldCloseString(): boolean {
    const top = collectionStack[collectionStack.length - 1]
    return top?._tag === "quotedString" ? top.unescapedQuoteCount % 2 === 0 : false
  }

  function shouldCloseUnescapedString(nextChars: string): CloseStringResult {
    const pos = getPos()

    switch (pos._tag) {
      case "inNothing": {
        for (let index = 0; index < nextChars.length; index += 1) {
          const char = nextChars[index]
          if (char === "{" || char === "[") {
            return { _tag: "close", charsConsumed: index, completion: "complete" }
          }
          if (/\s/.test(char)) {
            const top = collectionStack[collectionStack.length - 1]
            if (top?._tag === "unquotedString" && isStringComplete(top)) {
              return { _tag: "close", charsConsumed: index, completion: "complete" }
            }
          }
          const top = collectionStack[collectionStack.length - 1]
          if (top?._tag === "unquotedString") {
            top.content += char
          }
        }
        return { _tag: "continue", charsConsumed: nextChars.length }
      }

      case "inObjectKey":
        for (let index = 0; index < nextChars.length; index += 1) {
          const char = nextChars[index]
          if (char === ":") {
            return { _tag: "close", charsConsumed: index, completion: "complete" }
          }
          const top = collectionStack[collectionStack.length - 1]
          if (top?._tag === "unquotedString") {
            top.content += char
          }
        }
        return { _tag: "continue", charsConsumed: nextChars.length }

      case "inObjectValue":
        for (let index = 0; index < nextChars.length; index += 1) {
          const char = nextChars[index]
          if (char === "," || char === "}") {
            return { _tag: "close", charsConsumed: index, completion: "complete" }
          }
          const top = collectionStack[collectionStack.length - 1]
          if (top?._tag === "unquotedString") {
            top.content += char
          }
        }
        return { _tag: "continue", charsConsumed: nextChars.length }

      case "inArray":
        for (let index = 0; index < nextChars.length; index += 1) {
          const char = nextChars[index]
          if (char === "," || char === "]") {
            return { _tag: "close", charsConsumed: index, completion: "complete" }
          }
          const top = collectionStack[collectionStack.length - 1]
          if (top?._tag === "unquotedString") {
            top.content += char
          }
        }
        return { _tag: "continue", charsConsumed: nextChars.length }

      case "unknown":
        return { _tag: "continue", charsConsumed: 0 }
    }
  }

  function findAnyStartingValue(char: string, nextChars: string): number {
    switch (char) {
      case "{":
        collectionStack.push({ _tag: "object", keys: [], values: [], state: "incomplete" })
        return 0
      case "[":
        collectionStack.push({ _tag: "array", items: [], state: "incomplete" })
        return 0
      case `"`:
        collectionStack.push({
          _tag: "quotedString",
          content: "",
          state: "incomplete",
          trailingBackslashes: 0,
          unescapedQuoteCount: 0,
          pendingEscape: false,
          pendingUnicodeHex: null,
        })
        return 0
      case " ":
      case "\t":
      case "\n":
      case "\r":
        return 0
      default: {
        collectionStack.push({ _tag: "unquotedString", content: char, state: "incomplete" })
        const result = shouldCloseUnescapedString(nextChars)
        if (result._tag === "close") {
          completeCollection(result.completion)
        }
        return result.charsConsumed
      }
    }
  }

  /**
   * Resolve an escape sequence given the specifier character and remaining text.
   * @param fromPending - true if called from pending escape path (char is the specifier)
   * @returns number of additional characters consumed from nextChars
   *   When fromPending=true: chars consumed from nextChars (0 for simple escapes)
   *   When fromPending=false: 1 + chars consumed from rest (1 for simple escapes)
   */
  function resolveEscape(top: import("./types").QuotedStringCollection, escaped: string, rest: string, fromPending: boolean): number {
    const base = fromPending ? 0 : 1
    switch (escaped) {
      case "n": updateQuoteTracking(top, "\\"); top.content += "\n"; return base
      case "t": updateQuoteTracking(top, "\\"); top.content += "\t"; return base
      case "r": updateQuoteTracking(top, "\\"); top.content += "\r"; return base
      case "b": updateQuoteTracking(top, "\\"); top.content += "\b"; return base
      case "f": updateQuoteTracking(top, "\\"); top.content += "\f"; return base
      case "\\": updateQuoteTracking(top, "\\"); top.content += "\\"; return base
      case `"`: updateQuoteTracking(top, "\\"); top.content += `"`; return base
      case "/": updateQuoteTracking(top, "\\"); top.content += "/"; return base
      case "u": {
        updateQuoteTracking(top, "\\")
        const hex = rest.slice(0, 4)
        if (hex.length === 4) {
          if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
            top.content += String.fromCharCode(Number.parseInt(hex, 16))
          } else {
            top.content += "\\u" + hex
          }
          return base + 4
        }
        // Not enough hex digits in this chunk — buffer
        top.pendingUnicodeHex = hex
        return base + hex.length
      }
      default:
        updateQuoteTracking(top, "\\")
        top.content += "\\" + escaped
        return base
    }
  }

  function processToken(char: string, nextChars: string): number {
    const top = collectionStack[collectionStack.length - 1]
    if (!top) return findAnyStartingValue(char, nextChars)

    switch (top._tag) {
      case "object":
        if (char === "}") { completeCollection("complete"); return 0 }
        if (char === "," || char === ":") return 0
        return findAnyStartingValue(char, nextChars)

      case "array":
        if (char === "]") { completeCollection("complete"); return 0 }
        if (char === ",") return 0
        return findAnyStartingValue(char, nextChars)

      case "quotedString": {
        // Handle pending unicode hex completion
        if (top.pendingUnicodeHex !== null) {
          const needed = 4 - top.pendingUnicodeHex.length
          const available = char + nextChars
          const hexPart = available.slice(0, needed)
          top.pendingUnicodeHex += hexPart
          if (top.pendingUnicodeHex.length === 4) {
            const hex = top.pendingUnicodeHex
            top.pendingUnicodeHex = null
            if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
              top.content += String.fromCharCode(Number.parseInt(hex, 16))
            } else {
              top.content += "\\u" + hex
            }
          }
          // consumed hexPart.length chars total, but first one is `char` itself
          return hexPart.length - 1
        }

        // Handle pending escape from previous chunk
        if (top.pendingEscape) {
          top.pendingEscape = false
          return resolveEscape(top, char, nextChars, true)
        }

        if (char === `"`) {
          if (shouldCloseString()) { completeCollection("complete"); return 0 }
          updateQuoteTracking(top, char)
          top.content += char
          return 0
        }
        if (char === "\\") {
          if (nextChars.length === 0) {
            // Buffer the backslash for next chunk
            updateQuoteTracking(top, char)
            top.pendingEscape = true
            return 0
          }
          const escaped = nextChars[0]
          return resolveEscape(top, escaped, nextChars.slice(1), false)
        }
        updateQuoteTracking(top, char)
        top.content += char
        return 0
      }

      case "unquotedString": {
        top.content += char
        const result = shouldCloseUnescapedString(nextChars)
        if (result._tag === "close") {
          completeCollection(result.completion)
        }
        return result.charsConsumed
      }
    }
  }

  function getPartial(): ParsedValue | undefined {
    if (collectionStack.length === 0) return completedValues.at(-1)

    let current: ParsedValue | undefined = collectionToValue(collectionStack[0])

    for (let index = 1; index < collectionStack.length; index += 1) {
      const parent = collectionStack[index - 1]
      const child = collectionToValue(collectionStack[index])

      switch (parent._tag) {
        case "object": {
          const entries: Array<[string, ParsedValue]> = []
          const completeCount = Math.min(parent.keys.length, parent.values.length)
          for (let entryIndex = 0; entryIndex < completeCount; entryIndex += 1) {
            entries.push([parent.keys[entryIndex], parent.values[entryIndex]])
          }
          if (parent.keys.length > parent.values.length) {
            entries.push([parent.keys[parent.keys.length - 1], child])
          }
          current = { _tag: "object", entries, state: parent.state }
          break
        }
        case "array":
          current = { _tag: "array", items: [...parent.items, child], state: parent.state }
          break
        default:
          current = child
      }
    }

    return current
  }

  return {
    push(chunk: string): void {
      let offset = 0
      while (offset < chunk.length) {
        const char = chunk[offset]
        const nextChars = chunk.slice(offset + 1)
        const consumed = processToken(char, nextChars)
        offset += consumed + 1
      }
    },

    end(): void {
      // Flush any pending escape state on quoted strings before closing
      for (const col of collectionStack) {
        if (col._tag === "quotedString") {
          if (col.pendingUnicodeHex !== null) {
            col.content += "\\u" + col.pendingUnicodeHex
            col.pendingUnicodeHex = null
          }
          if (col.pendingEscape) {
            col.content += "\\"
            col.pendingEscape = false
          }
        }
      }
      while (collectionStack.length > 0) {
        const top = collectionStack[collectionStack.length - 1]
        if (collectionStack.length === 1 && top._tag === "unquotedString" && isStringComplete(top)) {
          completeCollection("complete")
        } else {
          completeCollection("incomplete")
        }
      }
    },

    get partial(): ParsedValue | undefined {
      return getPartial()
    },

    get done(): boolean {
      return completedValues.length > 0
    },

    get currentPath(): readonly string[] {
      const path: string[] = []
      for (const collection of collectionStack) {
        if (collection._tag === "object" && collection.keys.length > collection.values.length) {
          path.push(collection.keys[collection.keys.length - 1])
        } else if (collection._tag === "array") {
          path.push(String(collection.items.length))
        }
      }
      return path
    },
  }
}
