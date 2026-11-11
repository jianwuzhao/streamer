/** 测试用资源探测桩。 */
import type { ResourceProbe, ResourceSample } from '../resources/probe.ts'

export class FakeProbeHandle implements ResourceProbe {
  readonly id = 'fake'
  private readonly fixed: ResourceSample | null

  constructor(fixed: ResourceSample | null) {
    this.fixed = fixed
  }

  async sample(): Promise<ResourceSample | null> {
    return this.fixed
  }
}
