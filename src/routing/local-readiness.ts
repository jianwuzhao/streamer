import { probeOllamaInstallState } from '../model-deploy.ts'

interface Health {
  ready: boolean
  nextCheck: number
  failures: number
  pending?: boolean
}

export class LocalReadiness {
  private readonly health = new Map<string, Health>()

  available(url: string, model: string): boolean {
    const key = JSON.stringify([url, model])
    const entry = this.health.get(key) ?? { ready: true, nextCheck: 0, failures: 0 }
    if (!this.health.has(key)) {
      this.health.set(key, entry)
      if (this.health.size > 16) this.health.delete(this.health.keys().next().value!)
    }
    if (!entry.pending && Date.now() >= entry.nextCheck) {
      entry.pending = true
      void probeOllamaInstallState({ ollamaUrl: url, model, timeoutMs: 750 }).then(({ ready }) => {
        entry.ready = ready
        entry.nextCheck = Date.now() + (ready ? 15_000 : 5_000)
      }).finally(() => { entry.pending = false })
    }
    return entry.ready
  }

  outcome(url: string, model: string, ok: boolean): void {
    const entry = this.health.get(JSON.stringify([url, model]))
    if (!entry) return
    entry.failures = ok ? 0 : entry.failures + 1
    if (ok || entry.failures >= 2) {
      entry.ready = ok
      entry.nextCheck = Date.now() + (ok ? 15_000 : 5_000)
    }
  }
}
