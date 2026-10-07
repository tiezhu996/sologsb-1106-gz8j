/**
 * 裂纹记录的幂等键：同一木段、同一位置的裂纹只应登记一次。
 * 两个标签页同时提交同一裂纹时，后提交者凭此键立即看到冲突。
 */
export function normalizeCrackPosition(position: string): string {
  return position.trim().replace(/\s+/g, '')
}

export function crackIdFor(segmentId: string, position: string): string {
  return `crack-${segmentId}-${normalizeCrackPosition(position)}`
}

export class CrackConflictError extends Error {
  readonly existingId: string

  constructor(existingId: string) {
    super('同一裂纹已登记')
    this.name = 'CrackConflictError'
    this.existingId = existingId
  }
}
