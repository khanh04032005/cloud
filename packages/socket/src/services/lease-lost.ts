export class LeaseLost extends Error {
  constructor(gameId: string) {
    super(`Room lease lost for ${gameId}`)
  }
}
