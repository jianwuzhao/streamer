/** Validate generated rigs before they reach the renderer. Model data never contains executable code. */
export function validateFaceRig(value: unknown, imageHash: string) {
  const m = value as Record<string, any> | null
  const numbers = (a: unknown, max: number, bound: number): a is number[] => Array.isArray(a) && a.length > 0 && a.length <= max &&
    a.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= bound)
  if (!m || m.version !== 1 || m.kind !== 'dafeiyu-face-2.5d' || m.sourceSha256 !== imageHash ||
      !Number.isInteger(m.width) || !Number.isInteger(m.height) || m.width < 1 || m.height < 1 || m.width > 4096 || m.height > 4096 ||
      !numbers(m.rect, 4, 4096) || m.rect.length !== 4 || m.rect[0]! < 0 || m.rect[1]! < 0 ||
      m.rect[2]! > m.width || m.rect[3]! > m.height || m.rect[0]! >= m.rect[2]! || m.rect[1]! >= m.rect[3]! ||
      !numbers(m.points, 4000, 4096) || m.points.length % 2 ||
      !numbers(m.indices, 12000, 2000) || m.indices.length % 3 ||
      m.indices.some((i: number) => !Number.isInteger(i) || i < 0 || i >= m.points.length / 2)) throw new Error('面部模型格式或原图匹配无效')
  const controls = ['jawOpen', 'mouthRound', 'smile', 'browLeft', 'browRight', 'blinkLeft', 'blinkRight']
  if (!m.targets || Object.keys(m.targets).length !== controls.length || controls.some(k =>
    !numbers(m.targets[k], 4000, 512) || m.targets[k].length !== m.points.length)) throw new Error('面部模型形变数据无效')
  if (!m.regions || ['leftEye', 'rightEye', 'innerLips'].some(k => !numbers(m.regions[k], 100, 2000) || m.regions[k].length < 3 ||
    m.regions[k].some((i: number) => !Number.isInteger(i) || i < 0 || i >= m.points.length / 2))) throw new Error('面部模型缺少五官边界')
  const basis = (b: any) => b && ['x', 'y', 'width', 'cos', 'sin'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k])) &&
    b.x >= 0 && b.x <= m.width && b.y >= 0 && b.y <= m.height && b.width > 1 && b.width < m.width &&
    Math.abs(b.cos * b.cos + b.sin * b.sin - 1) < 0.001
  if (!basis(m.mouth) || !Array.isArray(m.eyes) || m.eyes.length !== 2 || !m.eyes.every(basis)) throw new Error('面部模型局部坐标无效')
  return m
}
