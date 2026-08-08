export const errors = (...codes: number[]): Record<number, { description: string }> =>
  Object.fromEntries(codes.map((code) => [code, { description: `Error ${code}` }]))