/** Shared admission limits for the table dialog and direct cell input. */
export const tableEditLimits = {
  rows: 200,
  columns: 32,
  cells: 2048,
  cellUnits: 4096,
  sourceBytes: 256 * 1024,
  outputBytes: 512 * 1024,
} as const
