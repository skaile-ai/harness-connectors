/**
 * Splits a long-poll `GET` answer (`{"frames":[...],"cursor":"...","closed":{...}}`) without
 * decoding the frames: each frame comes back as its raw JSON text, so the receiver can check its
 * byte size before it parses it (spec §6). Only the small top-level fields are decoded here.
 * Returns null for anything that is not such an object.
 */
export type RawPollBatch = { frames: string[] | null; cursor: unknown; closed: unknown }

export function splitPollBatch(text: string): RawPollBatch | null {
  const batch: RawPollBatch = { frames: null, cursor: undefined, closed: undefined }
  let i = skipSpace(text, 0)
  if (text[i] !== '{') {
    return null
  }
  i = skipSpace(text, i + 1)
  if (text[i] === '}') {
    return skipSpace(text, i + 1) === text.length ? batch : null
  }
  for (;;) {
    const keyEnd = text[i] === '"' ? endOfString(text, i) : -1
    if (keyEnd < 0) {
      return null
    }
    const key = JSON.parse(text.slice(i, keyEnd)) as string
    i = skipSpace(text, keyEnd)
    if (text[i] !== ':') {
      return null
    }
    const start = skipSpace(text, i + 1)
    const end = endOfValue(text, start)
    if (end < 0) {
      return null
    }
    if (key === 'frames') {
      batch.frames = text[start] === '[' ? splitArray(text, start) : null
      if (batch.frames === null) {
        return null
      }
    } else if (key === 'cursor' || key === 'closed') {
      batch[key] = JSON.parse(text.slice(start, end))
    }
    i = skipSpace(text, end)
    if (text[i] === ',') {
      i = skipSpace(text, i + 1)
      continue
    }
    if (text[i] === '}' && skipSpace(text, i + 1) === text.length) {
      return batch
    }
    return null
  }
}

/** The raw text of each element of the array that starts at `start`, or null when malformed. */
function splitArray(text: string, start: number): string[] | null {
  const elements: string[] = []
  let i = skipSpace(text, start + 1)
  if (text[i] === ']') {
    return elements
  }
  for (;;) {
    const end = endOfValue(text, i)
    if (end < 0) {
      return null
    }
    elements.push(text.slice(i, end))
    i = skipSpace(text, end)
    if (text[i] === ',') {
      i = skipSpace(text, i + 1)
      continue
    }
    return text[i] === ']' ? elements : null
  }
}

/**
 * The index just past the JSON value that starts at `i`, or -1. Strings and nesting are tracked
 * so a bracket or quote inside a string does not count; the value itself is checked only by its
 * receiver (a frame is parsed, and refused if invalid, by the client).
 */
function endOfValue(text: string, i: number): number {
  const first = text[i]
  if (first === '"') {
    return endOfString(text, i)
  }
  if (first === '{' || first === '[') {
    let depth = 0
    for (let j = i; j < text.length; j++) {
      const char = text[j]
      if (char === '"') {
        j = endOfString(text, j) - 1
        if (j < 0) {
          return -1
        }
      } else if (char === '{' || char === '[') {
        depth += 1
      } else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) {
          return j + 1
        }
      }
    }
    return -1
  }
  // A number, true, false or null: up to the next delimiter.
  let j = i
  while (j < text.length && !',]} \t\n\r'.includes(text[j] as string)) {
    j += 1
  }
  return j > i ? j : -1
}

/** The index just past the string that starts at `i` (a quote), or -1 when it never ends. */
function endOfString(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    const char = text[j]
    if (char === '\\') {
      j += 1
    } else if (char === '"') {
      return j + 1
    }
  }
  return -1
}

function skipSpace(text: string, i: number): number {
  let j = i
  while (j < text.length && ' \t\n\r'.includes(text[j] as string)) {
    j += 1
  }
  return j
}
