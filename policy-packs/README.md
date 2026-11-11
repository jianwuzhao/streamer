# 平台政策包（方案 §23.1）

规则包随安装版本固定签名发布：`rule_id / source_url / published_at / fetched_at / content_hash / effective_scope / check / action / tests / reviewer`。开播前 `LiveSession.preflight` 校验包有效性与账号适用范围；缺包或校验失败 ⇒ 开播 fail-closed（单一可操作原因）。外部网页变化只生成待审政策差异，不让大模型自动改合规边界。

- `douyin/rules.json`：直播行为规范（2024-06-13 标注）、直播伴侣开播说明、《人工智能生成合成内容标识办法》（2025-03-14）、《关于加强网络直播打赏规范管理的通知》（2026-04-13）
- 当前 `content_hash: pinned-no-fetch` 表示按发布版本钉住（未在安装期重新抓取）；正式安装器将替换为实抓哈希并签名
