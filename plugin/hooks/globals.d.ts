// The engine runtime has Uint8Array.prototype.toBase64; lib es2023 does not declare it yet.
export {}

declare global {
  interface Uint8Array {
    toBase64(): string
  }
}
