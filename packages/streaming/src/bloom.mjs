import { createHash } from "node:crypto"

// An optimization only: PostgreSQL remains the final duplicate check.
export class BloomFilter {
  constructor(bits = 1 << 20, hashes = 7) {
    this.bits = bits
    this.hashes = hashes
    this.bytes = new Uint8Array(Math.ceil(bits / 8))
  }

  indexes(value) {
    const digest = createHash("sha256").update(value).digest()
    const a = digest.readUInt32BE(0)
    const b = digest.readUInt32BE(4) | 1

    return Array.from(
      { length: this.hashes },
      (_, i) => (a + i * b) % this.bits,
    )
  }

  add(value) {
    for (const index of this.indexes(value)) {
      this.bytes[index >> 3] |= 1 << (index & 7)
    }
  }

  has(value) {
    return this.indexes(value).every((index) =>
      Boolean(this.bytes[index >> 3] & (1 << (index & 7))),
    )
  }
}
