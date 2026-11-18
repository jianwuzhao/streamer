import { execFileSync } from 'node:child_process'
import { hash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const motionOnly = args.includes('--motion-only')
const data = resolve(args.find((arg) => arg !== '--motion-only') ?? process.env.DAFEIYU_DATA_DIR ?? join(repository, 'data'))
const poses = [
  { role: 'xiaxia', time: 0, left: 590 },
  { role: 'lubai', time: 0, left: 545 },
  { role: 'guyu', time: 2.5, left: 596 },
  { role: 'beila', time: 2.875, left: 490 },
]
const sourceWidth = 1920
const height = 1080
const width = 768

function preparePortrait(model, time, left) {
  const video = join(model, 'scene.mp4')
  const tracks = join(model, 'mouth-track.json')
  if (!existsSync(video) || !existsSync(tracks)) {
    throw new Error('需要原片和嘴部追踪文件')
  }
  const { frames } = JSON.parse(readFileSync(tracks, 'utf8'))
  const points = Array.isArray(frames) && frames.filter((row) =>
    Array.isArray(row) && row.length === 6 && row.every(Number.isFinite) && row[3] > row[1])
  if (!points || !points.length) {
    throw new Error('嘴部追踪文件无有效帧')
  }
  const [at, lx, ly, rx, ry] = points.reduce((best, row) =>
    Math.abs(row[0] - time) < Math.abs(best[0] - time) ? row : best)
  const mouthSpan = (rx - lx) * sourceWidth
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', video, '-vf',
    `crop=${width}:${height}:${left}:0`, '-frames:v', '1', join(model, 'portrait-frame.png')], { stdio: 'inherit' })
  const mouth = {
    x: ((lx + rx) * sourceWidth / 2 - left) / width,
    y: (ly + ry) / 2,
    width: mouthSpan / width,
    tilt: Math.atan2((ry - ly) * height, mouthSpan),
  }
  writeFileSync(join(model, 'mouth-model.json'), JSON.stringify(mouth) + '\n')
}

function prepareMotion(model, cache) {
  const portrait = join(model, 'portrait-frame.png')
  const config = join(model, 'mouth-model.json')
  const mouth = JSON.parse(readFileSync(config, 'utf8'))
  const source = hash('sha256', readFileSync(portrait))
  const pending = join(model, '.motion-mask-' + randomUUID())
  try {
    execFileSync('swift', ['-module-cache-path', cache, join(repository, 'scripts/prepare-role-motion.swift'),
      portrait, pending + '.png', pending + '-head.png', pending + '-eyes.json'], { stdio: 'inherit' })
    const eyes = JSON.parse(readFileSync(pending + '-eyes.json', 'utf8'))
    writeFileSync(pending + '.json', JSON.stringify({ ...mouth, eyes, motionMaskSource: source }) + '\n')
    renameSync(pending + '.png', join(model, 'motion-mask.png'))
    renameSync(pending + '-head.png', join(model, 'head-mask.png'))
    renameSync(pending + '.json', config)
  } finally {
    rmSync(pending + '.png', { force: true })
    rmSync(pending + '-head.png', { force: true })
    rmSync(pending + '-eyes.json', { force: true })
    rmSync(pending + '.json', { force: true })
  }
}

const cache = process.platform === 'darwin' ? mkdtempSync(join(tmpdir(), 'dafeiyu-motion-')) : null
try {
  if (motionOnly && !cache) throw new Error('生成角色轮廓需要 macOS 的 Vision')
  for (const { role, time, left } of poses) {
    const model = join(data, 'models', 'eciyuan-' + role)
    try {
      if (!motionOnly) preparePortrait(model, time, left)
    } catch (error) {
      console.error(role + ' · ' + error.message)
      process.exitCode = 1
      continue
    }
    try {
      if (cache) prepareMotion(model, cache)
      console.log(role + (cache ? ' · 角色轮廓与口型就绪' : ' · 口型预览素材就绪'))
    } catch {
      console.error(role + ' · 轮廓生成失败，仍可使用口型预览')
      if (motionOnly) process.exitCode = 1
    }
  }
} finally {
  if (cache) rmSync(cache, { recursive: true, force: true })
}
