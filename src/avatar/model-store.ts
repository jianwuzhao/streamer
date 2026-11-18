/**
 * Live2D 桌宠资产服务（形象层本地化）：
 * - vendor 运行时（Cubism Core / pixi.js / pixi-live2d-display，随插件分发，
 *   许可见 client/vendor/VENDOR-LICENSES.md）经共享 API 以脚本文本下发；
 * - 角色模型包按「数据目录 + 目录名」管理（data/models/&lt;id&gt;/，不入仓库），
 *   每包一个 *.model3.json 入口，可选 manifest.json（name/source/license）。
 *
 * 安全边界：模型文件读取只允许白名单扩展、解析结果必须落在该模型目录内、
 * 模型目录本身（符号链接解析后）必须是 models 根的直接子目录、
 * 符号链接真实目标同样过扩展名白名单、manifest.json 限 lstat 常规文件
 * 且限读取上限——host-api 返回 base64，防巨文件撑爆面板请求。
 */
import { validateFaceRig } from './face-rig.ts'
import { hash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

export interface Live2DModelEntry {
  /** 模型目录名（host-api 的 id） */
  readonly id: string
  /** 展示名（manifest.name，缺省回落 id） */
  readonly name: string
  /** 相对模型目录的 *.model3.json 入口 */
  readonly entry: string
  readonly source: string | null
  readonly license: string | null
  readonly lipSyncDeclared: boolean
  readonly lipSync?: LipSyncCalibration
}

interface LipSyncCalibration {
  readonly ids?: string[]
  readonly closed?: number
  readonly open?: number
  readonly gain?: number
  readonly threshold?: number
}

const VENDOR_FILES = {
  core: 'live2dcubismcore.min.js',
  pixi: 'pixi.min.js',
  extension: 'pixi-live2d-display.min.js',
} as const

export type VendorName = keyof typeof VENDOR_FILES
export const VENDOR_NAMES: readonly VendorName[] = ['core', 'pixi', 'extension']

/** 模型包内允许读取的扩展（Live2D Cubism 常见产物；不含可执行类） */
const MODEL_FILE_EXTENSIONS = new Set([
  '.json',
  '.moc3',
  '.moc',
  '.png',
  '.webp',
  '.jpg',
  '.jpeg',
  '.cd3',
  '.cdi',
  '.mtn',
  '.wav',
  '.mp3',
])

/** 单文件下发上限（24MB：足够覆盖 4K 贴图与 moc3） */
const MODEL_FILE_MAX_BYTES = 24 * 1024 * 1024

/** manifest.json 读取上限（64KB 足够 name/source/license；防巨文件与符号链接逃逸） */
const MANIFEST_MAX_BYTES = 64 * 1024

const SCENE_EXTENSIONS = new Set(['.mp4'])

const SAMPLE_IDS = new Set(['haru', 'hiyori', 'mao', 'mark', 'natori', 'ren', 'rice', 'wanko'])
export function isRetiredSample(id: string): boolean {
  return SAMPLE_IDS.has(id.toLowerCase())
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class AvatarAssetError extends Error {
  public readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AvatarAssetError'
    this.status = status
  }
}

interface ModelManifest {
  readonly name?: unknown
  readonly source?: unknown
  readonly license?: unknown
  readonly lipSync?: unknown
}

function parseCalibration(raw: unknown): LipSyncCalibration | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Record<string, unknown>
  const number = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined
  const ids = Array.isArray(input.ids) && input.ids.length <= 8 &&
    input.ids.every((value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(value)) ?
    input.ids as string[] : undefined
  const closed = number(input.closed, -100, 100)
  const open = number(input.open, -100, 100)
  const gain = number(input.gain, 0.1, 10)
  const threshold = number(input.threshold, 0, 0.9)
  return {
    ...(ids?.length ? { ids } : {}), ...(closed === undefined ? {} : { closed }),
    ...(open === undefined ? {} : { open }), ...(gain === undefined ? {} : { gain }),
    ...(threshold === undefined ? {} : { threshold }),
  }
}

function hasLipSync(path: string): boolean {
  try {
    if (lstatSync(path).size > MANIFEST_MAX_BYTES) return false
    const data = JSON.parse(readFileSync(path, 'utf8')) as { Groups?: { Name?: string; Ids?: unknown[] }[] }
    return Array.isArray(data.Groups) && data.Groups.some((group) => group?.Name === 'LipSync' &&
      Array.isArray(group.Ids) && group.Ids.some((value) => typeof value === 'string' && value.length > 0))
  } catch { return false }
}

function readManifest(modelDir: string): ModelManifest | null {
  const p = join(modelDir, 'manifest.json')
  let st
  try {
    // lstat 不跟随符号链接：manifest 为符号链接/目录等非常规文件时按缺失处理
    st = lstatSync(p)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MANIFEST_MAX_BYTES) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ModelManifest
  } catch {
    return null
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

export class AvatarAssetStore {
  private readonly modelsDir: string
  private readonly vendorDir: string
  private readonly dshPetDir?: string | undefined

  constructor(opts: { modelsDir: string; vendorDir: string; dshPetDir?: string }) {
    this.modelsDir = opts.modelsDir
    this.vendorDir = opts.vendorDir
    this.dshPetDir = opts.dshPetDir
  }

  /** vendor 文件是否齐备（缺件时客户端自动回退 CSS 桌宠） */
  vendorStatus(): Record<VendorName, boolean> {
    const out = {} as Record<VendorName, boolean>
    for (const name of VENDOR_NAMES) {
      out[name] = existsSync(join(this.vendorDir, VENDOR_FILES[name]))
    }
    return out
  }

  /** 读取 vendor 脚本文本（注入顺序由客户端保证：core → pixi → extension） */
  readVendorFile(name: string): { name: VendorName; file: string; text: string } {
    if (!(VENDOR_NAMES as readonly string[]).includes(name)) {
      throw new AvatarAssetError(`未知 vendor 文件：${name}`)
    }
    const key = name as VendorName
    const file = join(this.vendorDir, VENDOR_FILES[key])
    if (!existsSync(file)) throw new AvatarAssetError(`vendor 文件缺失：${VENDOR_FILES[key]}`, 404)
    return { name: key, file: VENDOR_FILES[key], text: readFileSync(file, 'utf8') }
  }

  /** 列出已安装模型包（目录内含 *.model3.json 即算；坏 manifest 降级展示） */
  listModels(): readonly Live2DModelEntry[] {
    if (!existsSync(this.modelsDir)) return []
    const out: Live2DModelEntry[] = []
    for (const ent of readdirSync(this.modelsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !MODEL_ID_PATTERN.test(ent.name) || isRetiredSample(ent.name)) continue
      const dir = join(this.modelsDir, ent.name)
      const files = readdirSync(dir, { withFileTypes: true })
      const entry = files.find((f) => f.isFile() && /\.model3\.json$/.test(f.name))
      if (entry === undefined) continue
      const manifest = readManifest(dir)
      const lipSync = parseCalibration(manifest?.lipSync)
      out.push({
        id: ent.name,
        name: asString(manifest?.name) ?? ent.name,
        entry: entry.name,
        source: asString(manifest?.source),
        license: asString(manifest?.license),
        lipSyncDeclared: !!lipSync?.ids?.length || hasLipSync(join(dir, entry.name)),
        ...(lipSync ? { lipSync } : {}),
      })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 读取模型包内文件（base64 下发；路径穿越/扩展名/大小不合规一律拒绝） */
  readModelFile(id: string, relPath: string): { path: string; base64: string; bytes: number } {
    const file = this.resolveAsset(id, relPath, MODEL_FILE_EXTENSIONS)
    return { path: relPath, base64: readFileSync(file.path).toString('base64'), bytes: file.bytes }
  }

  hasPrototype(id: string): boolean {
    if (id === 'dsh-pet') return !!this.dshPetDir && existsSync(join(this.dshPetDir, 'still.png'))
    try {
      this.resolveAsset(id, 'mouth-model.json', MODEL_FILE_EXTENSIONS)
      this.resolveAsset(id, 'portrait-frame.png', MODEL_FILE_EXTENSIONS)
      return true
    } catch { return false }
  }

  readPrototype(id: string) {
    if (id === 'dsh-pet') {
      if (!this.dshPetDir) throw new AvatarAssetError('DSH 桌宠资源未安装', 404)
      return { image: readFileSync(join(this.dshPetDir, 'still.png')).toString('base64'),
        mouth: { x: 0.459, y: 0.551, width: 0.034, tilt: 0 } }
    }
    const { base64 } = this.readModelFile(id, 'mouth-model.json')
    const mouth = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>
    if (!mouth || !['x', 'y', 'width'].every((key) => typeof mouth[key] === 'number' && mouth[key] > 0 && mouth[key] < 1) ||
      typeof mouth.tilt !== 'number' || !Number.isFinite(mouth.tilt) || Math.abs(mouth.tilt) > Math.PI / 2) {
      throw new AvatarAssetError('角色口型配置无效')
    }
    const image = this.readModelFile(id, 'portrait-frame.png').base64
    const { motionMaskSource, eyes: eyeConfig, ...calibration } = mouth
    const optionalMask = (file: string) => {
      try {
        return this.readModelFile(id, file).base64
      } catch (error) {
        if (!(error instanceof AvatarAssetError)) throw error
        return undefined
      }
    }
    const matches = typeof motionMaskSource === 'string' && hash('sha256', Buffer.from(image, 'base64')) === motionMaskSource
    const motionMask = matches ? optionalMask('motion-mask.png') : undefined
    const headMask = motionMask ? optionalMask('head-mask.png') : undefined
    const eyes = matches && Array.isArray(eyeConfig) && eyeConfig.length === 2 && eyeConfig.every((eye) =>
      eye && ['x', 'y', 'width', 'height'].every((key) => typeof eye[key] === 'number' &&
        Number.isFinite(eye[key]) && eye[key] > 0 && eye[key] < 1) &&
      eye.width < 0.3 && eye.height < 0.2 && eye.x > eye.width && eye.x + eye.width < 1 &&
      eye.y > eye.height * 1.5 && eye.y + eye.height * 1.5 < 1 &&
      typeof eye.tilt === 'number' && Number.isFinite(eye.tilt) && Math.abs(eye.tilt) < Math.PI / 3) ? eyeConfig : undefined
    let faceRig: ReturnType<typeof validateFaceRig> | undefined
    try {
      const file = this.readModelFile(id, 'face-rig.json')
      faceRig = validateFaceRig(JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')), hash('sha256', Buffer.from(image, 'base64')))
    } catch (error) {
      if (!(error instanceof AvatarAssetError && error.status === 404)) throw new AvatarAssetError('完整面部模型需要重新生成：' + (error as Error).message)
    }
    return { image, mouth: calibration, ...(faceRig ? { faceRig } : {}), ...(eyes ? { eyes } : {}), ...(motionMask ? { motionMask } : {}), ...(headMask ? { headMask } : {}) }
  }

  readDshIdle(): Buffer {
    if (!this.dshPetDir) throw new AvatarAssetError('DSH 桌宠资源未安装', 404)
    return readFileSync(join(this.dshPetDir, 'idle.webm'))
  }

  readScene(id: string): Buffer {
    return readFileSync(this.resolveAsset(id, 'scene.mp4', SCENE_EXTENSIONS).path)
  }

  hasScene(id: string): boolean {
    try {
      this.resolveAsset(id, 'scene.mp4', SCENE_EXTENSIONS)
      return true
    } catch {
      return false
    }
  }

  private resolveAsset(id: string, relPath: string, extensions: ReadonlySet<string>): { path: string; bytes: number } {
    if (isRetiredSample(id)) throw new AvatarAssetError('示例角色已移除', 404)
    if (!MODEL_ID_PATTERN.test(id)) throw new AvatarAssetError(`非法模型 id：${id}`)
    if (relPath.includes('\0')) throw new AvatarAssetError('非法路径')
    const dir = resolve(this.modelsDir, id)
    if (!existsSync(dir)) throw new AvatarAssetError(`模型不存在：${id}`, 404)
    // 模型目录真实路径（解析符号链接后的安全边界基准）：
    // 必须恰为解析后 models 根下名为 id 的直接子目录——挡模型目录符号链接
    // 指向根外任意目录，也挡别名到根内其他模型目录
    const realRoot = realpathSync(this.modelsDir)
    const realDir = realpathSync(dir)
    if (realDir !== join(realRoot, id)) {
      throw new AvatarAssetError(`模型不存在：${id}`, 404)
    }
    const abs = resolve(dir, relPath)
    // 解析后必须仍落在该模型目录内（挡 ../ 与绝对路径注入）
    if (abs !== dir && !abs.startsWith(dir + sep)) {
      throw new AvatarAssetError('路径越界')
    }
    // 全部扩展名一律走白名单（无扩展名同样拒绝）
    const ext = extname(relPath).toLowerCase()
    if (!extensions.has(ext)) {
      throw new AvatarAssetError(`不允许的文件类型：${ext}`)
    }
    let realAbs: string
    try {
      realAbs = realpathSync(abs)
    } catch {
      throw new AvatarAssetError(`文件不存在：${relPath}`, 404)
    }
    // 文件真实路径也必须落在模型目录真实路径内（挡符号链接逃逸）
    if (realAbs !== realDir && !realAbs.startsWith(realDir + sep)) {
      throw new AvatarAssetError('路径越界')
    }
    // 符号链接的真实目标同样过白名单：挡「允许扩展名符号链接 →
    // 无扩展名/可执行类真实文件」（如 data.json -> payload、steal.png -> run.sh）
    const realExt = extname(realAbs).toLowerCase()
    if (!extensions.has(realExt)) {
      throw new AvatarAssetError(`不允许的文件类型：${realExt}`)
    }
    let st
    try {
      st = statSync(realAbs)
    } catch {
      throw new AvatarAssetError(`文件不存在：${relPath}`, 404)
    }
    if (!st.isFile()) throw new AvatarAssetError('不是文件')
    if (st.size > MODEL_FILE_MAX_BYTES) throw new AvatarAssetError('文件超出下发上限（24MB）', 413)
    return { path: realAbs, bytes: st.size }
  }
}
