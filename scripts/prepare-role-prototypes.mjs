import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const data = resolve(process.argv[2] ?? process.env.DAFEIYU_DATA_DIR ?? join(repository, 'data'))
const poses = [
  { role: 'xiaxia', time: 0, left: 590 },
  { role: 'lubai', time: 0, left: 545 },
  { role: 'guyu', time: 2.5, left: 596 },
  { role: 'beila', time: 2.875, left: 490 },
]
const sourceWidth = 1920
const height = 1080
const width = 768

for (const { role, time, left } of poses) {
  const model = join(data, 'models', 'eciyuan-' + role)
  const video = join(model, 'scene.mp4')
  const tracks = join(model, 'mouth-track.json')
  if (!existsSync(video) || !existsSync(tracks)) {
    console.error(role + ' · 需要原片和嘴部追踪文件')
    process.exitCode = 1
    continue
  }
  const { frames } = JSON.parse(readFileSync(tracks, 'utf8'))
  const points = Array.isArray(frames) && frames.filter((row) =>
    Array.isArray(row) && row.length === 6 && row.every(Number.isFinite) && row[3] > row[1])
  if (!points || !points.length) {
    console.error(role + ' · 嘴部追踪文件无有效帧')
    process.exitCode = 1
    continue
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
  console.log(role + ' · 口型预览素材就绪')
}
