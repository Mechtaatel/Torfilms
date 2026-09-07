export const MIN_RAM_MB = 500
export const MAX_RAM_MB = 2048

export function ramLimitBytes (value) {
  const mb = Number(value)
  if (!Number.isInteger(mb) || mb < MIN_RAM_MB || mb > MAX_RAM_MB) throw new Error(`RAM-кеш: от ${MIN_RAM_MB} до ${MAX_RAM_MB} МБ`)
  return mb * 1024 ** 2
}
