/**
 * A little-endian cursor over the file's bytes, with the format's own
 * primitive types (WORD, SHORT, DWORD, FIXED, STRING, …) as methods. Every
 * read is bounds-checked against a limit — the whole file, or the current
 * chunk — so a truncated or lying size field surfaces as an `AsepriteError`
 * naming the offset, never as garbage read from the next chunk.
 */

interface Utf8 {
  TextDecoder: new (label?: string, options?: { fatal?: boolean }) => { decode(input: Uint8Array): string }
}

// UTF-8 per the spec. Not fatal: a mis-encoded layer name should not make the
// whole file unreadable, so invalid bytes become U+FFFD.
const utf8 = new (globalThis as unknown as Utf8).TextDecoder('utf-8')

/** Everything that goes wrong reading a file is one of these, with the byte offset where it went wrong when there is one. */
export class AsepriteError extends Error {
  readonly offset: number | null

  constructor(message: string, offset: number | null = null) {
    super(offset === null ? message : `${message} (at byte ${offset})`)
    this.name = 'AsepriteError'
    this.offset = offset
  }
}

export class Reader {
  private readonly view: DataView
  offset: number
  /** Reads may not pass this offset. */
  limit: number

  constructor(readonly bytes: Uint8Array, offset = 0, limit = bytes.length) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
    this.limit = limit
  }

  private take(count: number): number {
    const at = this.offset
    if (count < 0 || at + count > this.limit) throw new AsepriteError(`Unexpected end of data reading ${count} bytes`, at)
    this.offset = at + count
    return at
  }

  get remaining(): number {
    return this.limit - this.offset
  }

  skip(count: number): void {
    this.take(count)
  }

  byte(): number {
    return this.view.getUint8(this.take(1))
  }

  word(): number {
    return this.view.getUint16(this.take(2), true)
  }

  short(): number {
    return this.view.getInt16(this.take(2), true)
  }

  dword(): number {
    return this.view.getUint32(this.take(4), true)
  }

  long(): number {
    return this.view.getInt32(this.take(4), true)
  }

  /** 16.16 fixed point, as a number. */
  fixed(): number {
    return this.long() / 65536
  }

  float(): number {
    return this.view.getFloat32(this.take(4), true)
  }

  double(): number {
    return this.view.getFloat64(this.take(8), true)
  }

  qword(): bigint {
    return this.view.getBigUint64(this.take(8), true)
  }

  long64(): bigint {
    return this.view.getBigInt64(this.take(8), true)
  }

  /** A copy, so the model never aliases the caller's buffer. */
  bytesOf(count: number): Uint8Array {
    const at = this.take(count)
    return this.bytes.slice(at, at + count)
  }

  /** A view, for data that is about to be decompressed or copied anyway. */
  view8(count: number): Uint8Array {
    const at = this.take(count)
    return this.bytes.subarray(at, at + count)
  }

  string(): string {
    const length = this.word()
    return utf8.decode(this.view8(length))
  }
}
