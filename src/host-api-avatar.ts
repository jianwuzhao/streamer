/**
 * Live2D 桌宠资产 GET 路由（host-api/avatar）：
 * - avatar/catalog：vendor 就绪状态 + 已安装模型包列表（客户端据此决定渲染或回退）；
 * - avatar/vendor?name=core|pixi|extension：vendor 脚本文本（blob <script> 注入用）；
 * - avatar/model-file?id=&path=：模型包内单文件（base64；客户端拼 Blob URL 喂渲染器）。
 * Cubism 模型包从本地数据目录加载。
 */
import type { AvatarAssetStore } from './avatar/model-store.ts'
import { AvatarAssetError } from './avatar/model-store.ts'
import { BUILTIN_PROFILES, RIGGED_MODEL_ID } from './settings/catalogs.ts'
import { json, type ServerRequest, type ServerResponse } from './host-api-shared.ts'

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof AvatarAssetError) {
    json(res, err.status, { ok: false, error: err.message })
    return
  }
  json(res, 500, { ok: false, error: (err as Error).message })
}

function serveVideo(video: Buffer, res: ServerResponse, headers?: ServerRequest['headers']): void {
  const header = typeof headers?.range === 'string' ? headers.range : undefined
  const match = header?.match(/^bytes=(\d*)-(\d*)$/)
  const start = match?.[1] ? Number(match[1]) :
    match?.[2] ? Math.max(0, video.length - Number(match[2])) : 0
  const end = match?.[1] && match[2] ? Math.min(Number(match[2]), video.length - 1) : video.length - 1
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, no-cache')
  if (header && (!match || !(match[1] || match[2]) || start > end)) {
    res.statusCode = 416
    res.setHeader('content-range', `bytes */${video.length}`)
    res.end()
    return
  }
  const body = video.subarray(start, end + 1)
  res.statusCode = header ? 206 : 200
  res.setHeader('content-type', 'video/mp4')
  res.setHeader('content-length', String(body.length))
  if (header) res.setHeader('content-range', `bytes ${start}-${end}/${video.length}`)
  res.end(body)
}

export function handleAvatarGetRoute(
  avatar: AvatarAssetStore,
  path: string,
  query: URLSearchParams,
  res: ServerResponse,
  headers?: ServerRequest['headers'],
): boolean {
  if (path === 'avatar/catalog') {
    const scenes = BUILTIN_PROFILES.flatMap(({ media }) => media && avatar.hasScene(media.modelId) ? [media.modelId] : [])
    const prototypes = BUILTIN_PROFILES.flatMap(({ media }) => media && avatar.hasPrototype(media.modelId) ? [media.modelId] : [])
    json(res, 200, { ok: true, catalog: { vendors: avatar.vendorStatus(), models: avatar.listModels(), scenes, prototypes,
      rigged: avatar.hasRiggedAvatar() ? [RIGGED_MODEL_ID] : [], originalStages: avatar.listOriginalStages() } })
    return true
  }

  if (path === 'avatar/rigged') {
    if (query.get('id') !== RIGGED_MODEL_ID) {
      json(res, 404, { ok: false })
      return true
    }
    try {
      const { body, type } = avatar.readRiggedAsset(query.get('asset') ?? '')
      res.statusCode = 200
      res.setHeader('content-type', type)
      res.setHeader('content-length', String(body.length))
      res.setHeader('x-content-type-options', 'nosniff')
      res.end(body)
    } catch (err) { fail(res, err) }
    return true
  }

  if (path === 'avatar/prototype') {
    const id = query.get('id')
    if (!id || !BUILTIN_PROFILES.some(({ media }) => media?.modelId === id) || !avatar.hasPrototype(id)) {
      json(res, 404, { ok: false })
      return true
    }
    try { json(res, 200, { ok: true, ...avatar.readPrototype(id) }) } catch (err) { fail(res, err) }
    return true
  }

  if (path === 'avatar/original-stage') {
    try {
      const id = query.get('id') ?? ''
      if (query.get('asset') === 'mouth') {
        const frames = avatar.readOriginalStageMouth(id)
        if (frames) json(res, 200, { ok: true, frames })
        else json(res, 404, { ok: false, error: '原场景缺少匹配的口型数据' })
      } else if (query.get('asset') === 'poster') {
        const poster = avatar.readOriginalStage(id, 'png')
        res.setHeader('content-type', 'image/png')
        res.setHeader('cache-control', 'private, no-cache')
        res.end(poster)
      } else {
        serveVideo(avatar.readOriginalStage(id, 'mp4'), res, headers)
      }
    } catch (err) { fail(res, err) }
    return true
  }

  if (path === 'avatar/stage-backdrop' || path === 'avatar/stage-matte') {
    try {
      const body = path === 'avatar/stage-matte' ? avatar.readStageMatte(query.get('id') ?? '') : avatar.readStageBackdrop()
      res.statusCode = 200
      res.setHeader('content-type', 'image/webp')
      res.setHeader('cache-control', path === 'avatar/stage-matte' ? 'private, no-cache' : 'private, max-age=3600')
      res.end(body)
    } catch (err) { fail(res, err) }
    return true
  }

  if (path === 'avatar/dsh-idle') {
    try {
      const video = avatar.readDshIdle()
      res.statusCode = 200
      res.setHeader('content-type', 'video/webm')
      res.end(video)
    } catch (err) { fail(res, err) }
    return true
  }

  if (path === 'avatar/mouth-track') {
    const id = query.get('id')
    if (!id || !BUILTIN_PROFILES.some(({ media }) => media?.modelId === id) || !avatar.hasScene(id)) {
      json(res, 404, { ok: false })
      return true
    }
    try {
      const file = avatar.readModelFile(id, 'mouth-track.json')
      const track = JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')) as { frames?: unknown }
      const frames = track?.frames
      if (!Array.isArray(frames) || frames.length > 3000 || !frames.every((row: unknown) =>
        Array.isArray(row) && row.length === 6 && row.every((value, i) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 && (i === 0 || value <= 1)))) {
        json(res, 400, { ok: false, error: '口型跟踪文件无效' })
        return true
      }
      json(res, 200, { ok: true, frames })
    } catch (err) {
      fail(res, err)
    }
    return true
  }

  if (path === 'avatar/scene') {
    const id = query.get('id')
    if (!id || !BUILTIN_PROFILES.some(({ media }) => media?.modelId === id)) {
      json(res, 404, { ok: false, error: '角色动态形象不存在' })
      return true
    }
    try {
      const video = avatar.readScene(id)
      serveVideo(video, res, headers)
    } catch (err) {
      fail(res, err)
    }
    return true
  }

  if (path === 'avatar/vendor') {
    const name = query.get('name') ?? ''
    try {
      const file = avatar.readVendorFile(name)
      json(res, 200, { ok: true, vendor: { name: file.name, file: file.file, text: file.text } })
    } catch (err) {
      fail(res, err)
    }
    return true
  }

  if (path === 'avatar/model-file') {
    const id = query.get('id') ?? ''
    const filePath = query.get('path') ?? ''
    try {
      const file = avatar.readModelFile(id, filePath)
      json(res, 200, { ok: true, file })
    } catch (err) {
      fail(res, err)
    }
    return true
  }

  return false
}
