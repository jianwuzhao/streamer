import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { packageDir } from './index-wiring.ts'

/**
 * client/client.js 结构回归（0.14.1 白屏修复）：
 * React 对 void 元素（input）携带 children 会抛
 * "input is a void element tag ..."（Minified React error #137），
 * 未捕获时整棵面板树被卸载 → 白屏。此处在语法层钉住三条防线：
 * 1) 任何 h("input", ...) 调用实参内不得再出现 datalist（必须挂为兄弟节点）；
 * 2) 面板根有错误边界（渲染错误收敛成卡片而非白屏）；
 * 3) 预设目录缺 models 字段时 pickPreset 不抛错（Array.isArray 防御）。
 */
const source = readFileSync(join(packageDir(), 'client', 'client.js'), 'utf8')

/** 截取每个 h("input", …) 调用的完整实参区间（括号配平）。 */
function inputCallSpans(src: string): string[] {
  const spans: string[] = []
  const marker = 'h("input"'
  let idx = src.indexOf(marker)
  while (idx !== -1) {
    let depth = 0
    let i = idx + marker.length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    spans.push(src.slice(idx, i + 1))
    idx = src.indexOf(marker, i)
  }
  return spans
}

test('client 结构：input 调用内不得嵌 datalist（void 元素 children 白屏回归）', () => {
  const spans = inputCallSpans(source)
  assert.ok(spans.length >= 8, `应有多个 input 调用（实际 ${spans.length}）`)
  const offenders = spans.filter((span) => span.includes('datalist'))
  assert.deepEqual(offenders, [], 'h("input") 调用内出现 datalist：必须挂为兄弟节点')
})

test('client 结构：模型建议列表经兄弟 datalist 提供，且对预设 models 做防御', () => {
  assert.ok(source.includes('selModels.length > 0 ? h("datalist"'), 'datalist 应以兄弟节点 + selModels 防御渲染')
  assert.ok(
    source.includes('const models = Array.isArray(p.models) ? p.models : []'),
    'pickPreset 应对缺失 models 的预设降级为空数组',
  )
})

test('client 结构：面板根挂错误边界（渲染错误不再白屏）', () => {
  assert.ok(source.includes('class PanelErrorBoundary'), '应定义 PanelErrorBoundary')
  assert.ok(source.includes('getDerivedStateFromError'), '错误边界需实现 getDerivedStateFromError')
  assert.ok(source.includes('PanelErrorBoundary, null, h(Panel)'), 'main slot 应以错误边界包裹 Panel')
})

test('client 结构：一键部署本地模型经 model/deploy 端点轮询', () => {
  assert.ok(source.includes('api("model/deploy"'), '应调用 model/deploy（GET 轮询）')
  assert.ok(source.includes('api(canSwitch ? "model/switch" : "model/deploy", legacy ? {} : { model: target })'),
    '新后端应收到选中的模型，旧后端应使用原部署参数')
  assert.ok(source.includes('LocalModelDeployCard'), 'CloudStep 应挂载一键部署卡片')
})

test('client 结构：云端密钥界面维护 + 未安装提示与进度条（0.15）', () => {
  assert.ok(source.includes('api("settings/cloud/key"'), '应调用 settings/cloud/key 维护密钥')
  assert.ok(source.includes('type: "password"'), '密钥输入应为 password 类型')
  assert.ok(source.includes('key.masked'), '应展示掩码而非明文')
  assert.ok(source.includes('ModelScope'), '应说明默认国内镜像来源')
  assert.ok(source.includes('"progressbar"'), '部署进度条应带 progressbar 语义')
  assert.ok(source.includes('aria-valuenow'), '进度条应带 aria-valuenow')
  assert.ok(source.includes('本地模型未安装'), '未安装时应给出界面提示')
  assert.ok(source.includes('一键部署并启用'), '未安装时应提供一键部署')
})

test('client 结构：部署状态接口异常显式报错，不静默停在检查状态', () => {
  assert.ok(source.includes('部署状态异常：'), 'GET 失败应在卡片内显示错误')
  assert.ok(source.includes('重载大肥鱼插件'), '未知路径（旧后端）应提示重载宿主插件')
  assert.ok(source.includes('重试连接'), '出错时按钮应可重试')
})

test('旧宿主的部署状态与进度响应可用于单模型面板', () => {
  const start = source.indexOf('function normalizeModelDeployResponse(')
  const end = source.indexOf('function LocalModelDeployCard(', start)
  const normalize = runInNewContext(`${source.slice(start, end)}\nnormalizeModelDeployResponse`)
  const deploy = { model: 'qwen3:4b', status: 'idle' }
  const legacy = normalize({
    ok: true, deploy, install: { reachable: true, model: deploy.model, modelInstalled: true },
  })
  assert.equal(legacy.legacy, true)
  assert.equal(legacy.activeModel, deploy.model)
  assert.equal(legacy.reachable, true)
  assert.equal(legacy.models[0].installed, true)
  const running = normalize({ ok: true, deploy: { ...deploy, status: 'running', log: ['模型下载：50%'] } })
  assert.equal(running.deploy.status, 'running')
  assert.equal(running.models[0].installed, null)
  const modern = { ok: true, deploy, activeModel: 'gemma3:1b', models: [{ id: 'gemma3:1b' }] }
  assert.equal(normalize(modern), modern)
  assert.equal(normalize({ ok: false, error: '未知路径' }), null)
})

test('client 结构：云端配置先测试通过再保存（0.15.1）', () => {
  assert.ok(source.includes('api("settings/cloud/test"'), '应调用 settings/cloud/test 连接测试')
  assert.ok(source.includes('测试连接'), '应有「测试连接」按钮')
  assert.ok(source.includes('const canSave = test?.ok || (sameConnection && policyChanged'), '连接字段变更须先测试，独立的用量和隐私设置可保存')
  assert.ok(source.includes('disabled: !canSave'), '保存按钮应应用配置门禁')
  assert.ok(source.includes('先「测试连接」通过后再保存'), '未通过时应提示先测试')
})

test('client 结构：额度/可用余额展示（0.15.2）', () => {
  assert.ok(source.includes('api("cloud/quota"'), '应调用 cloud/quota 查询额度')
  assert.ok(source.includes('额度 / 可用余额'), '应有额度展示区块')
  assert.ok(source.includes('刷新额度'), '应有手动刷新按钮')
  assert.ok(source.includes('不支持余额查询'), '不支持时应如实标注')
})

test('client 结构：自定义端点 URL 接入（0.15.3）', () => {
  assert.ok(source.includes('端点 URL（自定义网关）'), '应有自定义端点输入框')
  assert.ok(source.includes('baseUrl: baseUrl.trim(), dailyBudgetCny'), '保存应携带端点字段')
  assert.ok(source.includes('{ baseUrl: baseUrl.trim() }'), '连接测试应携带表单端点')
})
