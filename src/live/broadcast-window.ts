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
const COOKIE = 'dafeiyu_stage'
const FRAME_TIMEOUT_MS = 1_500
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
  frame?: { receivedAt: number; profileId: string; speaking: boolean; subtitle: string; level: number; safe: boolean; form: number; sampledAt: number; listening: boolean; version: number }
  /** 本次播放版本：切角色/打断/紧急停止时递增，旧版本帧一律拒收 */
  playbackVersion: number
  /** 版本号变更依据：上次生效的角色与安全态（用于自动递增） */
  versionKey: string
  /** 被拒收的过期帧数（诊断用） */
  staleFrames: number
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
        delete existing.frame
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
      playbackVersion: 1, versionKey: '', staleFrames: 0,
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
    const level = typeof input.level === 'number' && Number.isFinite(input.level) ? input.level : 0
    const profileId = typeof input.profileId === 'string' ? input.profileId : ''
    const safe = input.safe === true
    // 切角色（工作台已确认角色与帧角色不符）或进出安全画面都意味着「新的播放」：
    // 递增版本，让渲染端丢弃上一段在途的口型与动作，避免迟到帧恢复上一句。
    const versionKey = `${profileId}|${safe ? 'safe' : 'live'}`
    if (session.versionKey !== '' && session.versionKey !== versionKey) {
      session.playbackVersion += 1
    }
    session.versionKey = versionKey
    // 工作台可以显式声明它所属的播放版本；声明了旧版本的帧（迟到上传）直接拒收。
    const declared = typeof input.playbackVersion === 'number' && Number.isFinite(input.playbackVersion) ?
      input.playbackVersion : undefined
    if (declared !== undefined && declared < session.playbackVersion) {
      session.staleFrames += 1
      return false
    }
    session.frame = {
      receivedAt: Date.now(),
      profileId,
      speaking: input.speaking === true,
      subtitle: typeof input.subtitle === 'string' ? input.subtitle.slice(0, 500) : '',
      level: Math.max(0, Math.min(1, level)),
      safe,
      form: typeof input.form === 'number' && Number.isFinite(input.form) ? Math.max(-1, Math.min(1, input.form)) : 0,
      sampledAt: typeof input.sampledAt === 'number' && Number.isFinite(input.sampledAt) &&
        Math.abs(Date.now() - input.sampledAt) < 2_000 ? input.sampledAt : Date.now(),
      listening: input.listening === true,
      version: session.playbackVersion,
    }
    for (const viewer of session.viewers) this.pushFrame(session, viewer)
    return true
  }

  /** 当前播放版本（工作台据此对齐自己的口型/动作代次）。 */
  playbackVersion(owner: string): number | null {
    const session = this.session
    return !session || session.owner !== owner ? null : session.playbackVersion
  }

  /**
   * 打断：作废当前帧并递增播放版本。
   * 已推送的口型/字幕立即清空，在途的旧帧与旧版本上传随后都会被拒收。
   */
  interrupt(owner: string): number | null {
    const session = this.session
    if (!session || session.owner !== owner) return null
    session.playbackVersion += 1
    session.versionKey = ''
    delete session.frame
    for (const viewer of session.viewers) this.pushFrame(session, viewer)
    return session.playbackVersion
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
      child.stdin.write(`http://${LOCAL_HOST}:${address.port}/?token=${session.token}\n`)
    })
  }

  private frame(session: WindowSession) {
    const frame = session.frame
    const fresh = frame && Date.now() - frame.receivedAt < FRAME_TIMEOUT_MS ? frame : undefined
    const profileId = this.handle.settings.getPersonaProfile().id
    const safe = this.handle.live.session.current === 'safe_scene' || !fresh || fresh.safe || fresh.profileId !== profileId
    // Heartbeat liveness is separate from speech freshness. Never hold a stale open mouth.
    const current = fresh && Date.now() - fresh.sampledAt < 160
    const speech = !safe && current && fresh.speaking ?
      { speaking: true, subtitle: fresh.subtitle, level: fresh.level, form: fresh.form } : EMPTY_SPEECH
    return { ...speech, safe, profileId, listening: !safe && !!fresh?.listening,
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
      json(res, 200, { ok: true, turns: turns.map(({ id, source, author, text, status }) => ({ id, source, author, text, status })) })
      return
    }
    if (url.pathname.startsWith('/api/dafeiyu/avatar/') &&
        handleAvatarGetRoute(this.handle.avatar, url.pathname.slice('/api/dafeiyu/'.length), url.searchParams, res, req.headers)) return
    res.writeHead(404).end()
  }
}
