/** Decode streaming response lines across arbitrary network and UTF-8 boundaries. */
export async function* responseLines(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('模型响应缺少数据流')
  const decoder = new TextDecoder()
  let pending = ''
  let complete = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      complete = done
      pending += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        yield pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
      }
      if (pending.length > 1_048_576) throw new Error('模型响应行过大')
      if (done) {
        if (pending) yield pending
        return
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
