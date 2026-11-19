# 参与方式 / Contributing

[需求墙 / Feature wall](https://github.com/jianwuzhao/streamer/issues)

## 提需求 / Feature requests

用中文或英文描述使用场景、当前困难、期望操作与验收方式。提交前搜索已有问题，相同需求在原条目讨论。请勿提交密钥、完整配置备份、观众个人信息或未经授权的素材。

Describe your use case, obstacle, expected interaction and acceptance criteria in Chinese or English. Search before opening an issue; discuss duplicates in the original thread. Never post credentials, unreviewed configuration backups, audience personal data or assets you cannot share.

需求通过 GitHub Issues 持续讨论。是否实施、状态与关闭原因以维护者回复为准，赞助不构成功能或排期承诺。

Requests are discussed in GitHub Issues. Maintainer replies determine acceptance, status and closing reasons. Sponsorship does not promise implementation or scheduling.

## 报故障 / Bug reports

提供插件/宿主版本、系统、最小复现步骤、预期与实际结果，以及检查后的脱敏诊断。先在「设置 → 诊断」导出报告，提交前再检查内容。

Include plugin/host versions, OS, minimal reproduction steps, expected/actual results and a reviewed, sanitized diagnostic report from Settings → Diagnostics.

## 贡献代码 / Code contributions

小步提交，解释实际行为变化。修改设置不能绕过 AI 标识、隐私下限、开播保护和密钥掩码。运行 `pnpm typecheck`、`pnpm test` 与 `pnpm build`；worker 变更额外运行 `pnpm test:worker`。自动化与真实设备验收分开说明。

Keep changes focused and explain observable behavior. Preserve AI labeling, privacy constraints, active-session protections and secret masking. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:worker` for worker changes. Distinguish automated checks from device testing.
