import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { handleAvatarGetRoute } from '../host-api-avatar.ts'
import { handleDataGetRoute } from '../host-api-data.ts'
import { json } from '../host-api-shared.ts'
import type { DafeiyuPluginHandle } from '../index.ts'

const LOCAL_HOST = '127.0.0.1'
const COOKIE = 'dafeiyu_stage' // dsh-skip-sensitive
const FRAME_TIMEOUT_MS = 1_500
const SPEECH_SAMPLE_TIMEOUT_MS = 160
const EMPTY_SPEECH = { speaking: false, subtitle: '', level: 0, form: 0 }
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼直播画面</title></head><body style="margin:0;background:#173047">
<div id="broadcast"></div><script src="/renderer.js" defer></script><script src="/client.js" defer></script></body></html>`

interface WindowSession {
  owner: string
  token: string
  openedAt: number
  server: Server
  viewers: Set<ServerResponse>
  started?: Promise<void>
  child?: ChildProcessWithoutNullStreams
  frame?: { receivedAt: number; profileId: string; speaking: boolean; subtitle: string; captionProgress: number | undefined; level: number; safe: boolean; form: number; sampledAt: number; listening: boolean; version: number }
  /** 本次播放版本：切角色/打断/紧急停止时递增，旧版本帧一律拒收 */
  playbackVersion: number
  /** 版本号变更依据：上次生效的角色与安全态（用于自动递增） */
  versionKey: string
}

/** The native viewer has a private loopback origin with read-only access to stage data and assets. */
export class BroadcastWindow {
  private session: WindowSession | undefined
  private readonly handle: DafeiyuPluginHandle
  private readonly root: string
  private readonly executable: string

  constructor(handle: DafeiyuPluginHandle, root: string) {
    this.handle = handle
    this.root = root
    this.executable = join(root, 'lib', 'DafeiyuBroadcast.app', 'Contents', 'MacOS', 'DafeiyuBroadcast')
  }

  async open(owner: string): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('独立播出窗口目前支持 macOS')
    if (!existsSync(this.executable)) throw new Error('当前插件包缺少播出窗口，请在 Mac 上重新构建并重载插件')
    const existing = this.session
    if (existing) {
      await existing.started
      if (this.session !== existing) throw new Error('播出窗口已关闭')
      if (existing.owner !== owner) {
        if (Date.now() - (existing.frame?.receivedAt ?? existing.openedAt) < FRAME_TIMEOUT_MS) {
          throw new Error('另一个工作台已打开播出窗口，请先关闭该窗口')
        }
        existing.owner = owner
        this.interrupt(owner)
      }
      existing.child?.stdin.write('show\n')
      return
    }

    const server = createServer((request, response) => {
      void this.serve(session, request, response).catch(() => {
        if (response.headersSent) response.destroy()
        else json(response, 500, { ok: false })
      })
    })
    const session: WindowSession = {
      owner, server, openedAt: Date.now(), token: randomBytes(32).toString('hex'), viewers: new Set(),
      playbackVersion: 1, versionKey: this.stageKey(),
    }
    this.session = session
    server.on('error', () => this.dispose(session))
    session.started = this.start(session)
    try {
      await session.started
    } catch (error) {
      this.dispose(session)
      throw error
    }
  }

  publish(owner: string, input: Record<string, unknown>): boolean {
    const session = this.session
    if (!session || session.owner !== owner) return false
    this.syncStage(session)
    if (input.playbackVersion !== session.playbackVersion) return false
    const profileId = this.handle.settings.getPersonaProfile().id
    if (input.profileId !== profileId) return false
    const now = Date.now()
    const sampledAt = input.sampledAt
    if (typeof sampledAt !== 'number' || !Number.isFinite(sampledAt) || sampledAt > now ||
        now - sampledAt >= FRAME_TIMEOUT_MS || (session.frame && sampledAt < session.frame.sampledAt)) return false
    const level = typeof input.level === 'number' && Number.isFinite(input.level) ? input.level : 0
    session.frame = {
      receivedAt: now,
      profileId,
      speaking: input.speaking === true,
      subtitle: typeof input.subtitle === 'string' ? input.subtitle.slice(0, 500) : '',
      captionProgress: typeof input.captionProgress === 'number' && Number.isFinite(input.captionProgress) ?
        Math.max(0, Math.min(1, input.captionProgress)) : undefined,
      level: Math.max(0, Math.min(1, level)),
      safe: input.safe === true || this.handle.live.session.current === 'safe_scene',
      form: typeof input.form === 'number' && Number.isFinite(input.form) ? Math.max(-1, Math.min(1, input.form)) : 0,
      sampledAt,
      listening: input.listening === true,
      version: session.playbackVersion,
    }
    for (const viewer of session.viewers) this.pushFrame(session, viewer)
    return true
  }

  /** 当前播放版本（工作台据此对齐自己的口型/动作代次）。 */
  playbackVersion(owner: string): number | null {
    const session = this.session
    if (!session || session.owner !== owner) return null
    this.syncStage(session)
    return session.playbackVersion
  }

  /**
   * 打断：作废当前帧并递增播放版本。
   * 已推送的口型/字幕立即清空，在途的旧帧与旧版本上传随后都会被拒收。
   */
  interrupt(owner = this.session?.owner): number | null {
    const session = this.session
    if (!session || session.owner !== owner) return null
    session.playbackVersion += 1
    session.versionKey = this.stageKey()
    delete session.frame
    for (const viewer of session.viewers) this.pushFrame(session, viewer)
    return session.playbackVersion
  }

  private stageKey(): string {
    const profile = this.handle.settings.getPersonaProfile().id
    return `${profile}|${this.handle.live.session.current === 'safe_scene'}`
  }

  private syncStage(session: WindowSession): void {
    const key = this.stageKey()
    if (session.versionKey === key) return
    session.versionKey = key
    session.playbackVersion += 1
    delete session.frame
  }

  close(owner: string): void {
    if (this.session?.owner === owner) this.dispose()
  }

  dispose(session = this.session): void {
    if (!session || this.session !== session) return
    this.session = undefined
    for (const viewer of session.viewers) viewer.destroy()
    session.viewers.clear()
    session.server.close()
    session.server.closeAllConnections()
    session.child?.stdin.destroy()
    session.child?.kill()
  }

  private async start(session: WindowSession): Promise<void> {
    const { server } = session
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LOCAL_HOST, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (this.session !== session || !address || typeof address === 'string') {
      server.close()
      throw new Error('播出窗口已关闭')
    }

    const child = session.child = spawn(this.executable, [], { stdio: 'pipe' })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', () => this.dispose(session))
    child.once('exit', () => this.dispose(session))
    await new Promise<void>((resolve, reject) => {
      const stopped = () => finish(new Error('播出窗口启动失败'))
      const timeout = setTimeout(() => finish(new Error('播出窗口打开超时')), 10_000)
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        child.removeListener('error', stopped)
        child.removeListener('exit', stopped)
        child.stdout.removeListener('data', ready)
        child.stdout.resume()
        if (error) reject(error)
        else resolve()
      }
      let output = ''
      const ready = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('ready\n')) finish()
        else if (output.length > 1024) stopped()
      }
      child.on('error', stopped)
      child.on('exit', stopped)
      child.stdout.on('data', ready)
      child.stdin.write(`http://${LOCAL_HOST}:${address.port}/?token=${session.token}&layout=${this.handle.settings.getScene().broadcastLayout}\n`)
    })
  }

  private frame(session: WindowSession) {
    this.syncStage(session)
    const frame = session.frame
    const fresh = frame && Date.now() - frame.receivedAt < FRAME_TIMEOUT_MS ? frame : undefined
    const profileId = this.handle.settings.getPersonaProfile().id
    const safe = this.handle.live.session.current === 'safe_scene' || !fresh || fresh.safe || fresh.profileId !== profileId
    // Heartbeat liveness is separate from speech freshness. Never hold a stale open mouth.
    const current = fresh && Date.now() - fresh.sampledAt < SPEECH_SAMPLE_TIMEOUT_MS
    const speech = !safe && current && fresh.speaking ?
      { speaking: true, subtitle: fresh.subtitle, captionProgress: fresh.captionProgress, level: fresh.level, form: fresh.form } : EMPTY_SPEECH
    return { ...speech, safe, profileId, listening: !safe && !speech.speaking && !!fresh && (fresh.listening || fresh.speaking),
      sampledAt: fresh?.sampledAt ?? 0, sentAt: Date.now(), version: session.playbackVersion }
  }

  private pushFrame(session: WindowSession, res: ServerResponse): void {
    if (res.destroyed) return
    if (res.writableLength > 16_384) { res.destroy(); return }
    res.write('data: ' + JSON.stringify(this.frame(session)) + '\n\n')
  }

  private async serve(session: WindowSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = session.server.address()
    const host = address && typeof address !== 'string' ? `${LOCAL_HOST}:${address.port}` : ''
    if (this.session !== session || req.method !== 'GET' || req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== 'http://' + host)) {
      res.writeHead(404).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://' + host)
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    if (url.pathname === '/' && url.searchParams.get('token') === session.token) {
      res.setHeader('set-cookie', `${COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/`)
      // Bundled Pixi 7 generates shader uniform synchronizers with Function; no remote scripts are admitted.
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self' blob: 'unsafe-eval'; " +
        "style-src 'unsafe-inline'; connect-src 'self' blob:; img-src 'self' data: blob: https://upage.imtt.qq.com; media-src 'self' blob:; frame-ancestors 'none'")
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      return
    }
    if (!req.headers.cookie?.split(/;\s*/).includes(`${COOKIE}=${session.token}`)) {
      res.writeHead(404).end()
      return
    }
    if (url.pathname === '/renderer.js' || url.pathname === '/client.js') {
      const path = url.pathname === '/renderer.js' ? ['lib', 'broadcast-renderer.iife.js'] : ['client', 'client.js']
      const data = await readFile(join(this.root, ...path))
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(data)
      return
    }
    if (url.pathname === '/frame') {
      json(res, 200, this.frame(session))
      return
    }
    if (url.pathname === '/frames') {
      // No queued frames: disconnect a slow reader instead of accumulating obsolete speech.
      if (session.viewers.size >= 4) { res.writeHead(429).end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      session.viewers.add(res)
      this.pushFrame(session, res)
      const timer = setInterval(() => this.pushFrame(session, res), 40)
      res.once('close', () => { clearInterval(timer); session.viewers.delete(res) })
      return
    }
    if (url.pathname === '/api/dafeiyu/preview') {
      await handleDataGetRoute(this.handle, 'preview', res)
      return
    }
    if (url.pathname === '/api/dafeiyu/interaction') {
      const { turns } = this.handle.live.conversation.snapshot()
      json(res, 200, { ok: true, turns: turns.map(({ id, source, kind, author, text, status, sentAt }) => ({ id, source, kind, author, text, status, sentAt })) })
      return
    }
    if (url.pathname.startsWith('/api/dafeiyu/avatar/') &&
        handleAvatarGetRoute(this.handle.avatar, url.pathname.slice('/api/dafeiyu/'.length), url.searchParams, res, req.headers)) return
    res.writeHead(404).end()
  }
}
