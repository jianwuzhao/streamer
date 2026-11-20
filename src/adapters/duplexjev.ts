import { performance } from 'node:perf_hooks'

const maxAudioBytes = 2 ** 20
const maxBase64Length = Math.ceil(maxAudioBytes / 3) * 4
export const duplexjevBodyLimit = maxBase64Length + 512

const turnQuestions = {
  zh: { id: 'turn', text: '说话人说完了吗？', options: ['说完了', '还没说完'] },
  en: { id: 'turn', text: 'Has the user finished speaking?', options: ['finished', 'not finished'] },
} as const

export async function testDuplexJevTurn(args: Record<string, unknown>) {
  const { audioBase64, lang } = args
  if (lang !== 'zh' && lang !== 'en') return { status: 400, error: '请选择中文或英语音频' }
  if (typeof audioBase64 !== 'string' || audioBase64.length > maxBase64Length ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) {
    return { status: 400, error: '请选择不超过 1 MiB 的 WAV 文件' }
  }
  const audio = Buffer.from(audioBase64, 'base64')
  if (audio.length < 44 || audio.length > maxAudioBytes || audio.toString('base64') !== audioBase64 ||
      audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return { status: 400, error: '音频必须为有效的 WAV 文件，大小不超过 1 MiB' }
  }

  const base = URL.parse(process.env.DAFEIYU_DUPLEXJEV_URL?.trim() || 'http://127.0.0.1:8020')
  if (!base || base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    return { status: 503, error: '请将 DAFEIYU_DUPLEXJEV_URL 配置为本机 HTTP 网关地址' }
  }
  const question = turnQuestions[lang]
  const startedAt = performance.now()
  try {
    const response = await fetch(new URL('/v1/decide', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio_b64: audioBase64, format: 'wav', lang, questions: [{ ...question, lang }] }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { status: 502, error: `DuplexJev 网关返回 HTTP ${response.status}` }
    const data = await response.json() as { model?: unknown; answers?: { turn?: { answer?: unknown; confidence?: unknown } } }
    const { answer, confidence } = data.answers?.turn ?? {}
    if (typeof answer !== 'string' || !question.options.some((option) => option === answer) ||
        typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { status: 502, error: 'DuplexJev 未返回有效的语轮判定' }
    }
    return { status: 200, result: {
      model: typeof data.model === 'string' ? data.model.slice(0, 160) : null,
      answer,
      confidence,
      elapsedMs: Math.round(performance.now() - startedAt),
    } }
  } catch {
    return { status: 502, error: '无法完成本机 DuplexJev 判定，请检查网关是否已启动' }
  }
}
