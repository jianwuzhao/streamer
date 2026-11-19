# 发行与市场收录 / Release and catalog submission

发行流程由 `.github/workflows/release.yml` 执行：版本标签触发，检查版本、类型、测试、worker 和构建，在 macOS 上生成含 arm64/x86_64 原生播出窗口的预构建包，校验归档内容后发布 GitHub Release 与 SHA-256 摘要。安装包包含宿主入口、浏览器界面、默认配置、许可说明与中英文文档，不包含运行数据、密钥或本地模型。

The release workflow runs on version tags, checks the manifest version, types, tests, worker and build, creates a prebuilt archive on macOS including the universal native output window, verifies its contents, and publishes a GitHub Release with SHA-256 checksums. Runtime data, credentials and local models are excluded.

```bash
pnpm typecheck
pnpm test
pnpm test:worker
pnpm build
npm pack --ignore-scripts --pack-destination /tmp
```

`npm pack` 归档版本必须与 `package.json` 及标签一致。发布依赖 GitHub Actions 与仓库写权限；npm 登录不是 GitHub Release 发布的前提。

The archive version, package manifest and tag must match. Publication requires GitHub Actions and repository write access, not an npm login.

社区目录：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。按其 [贡献说明](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，提交单文件 `data/plugins/jianwuzhao__streamer.yml`。本目录保存对应条目，`tarball` 钉住实际版本；先核实发行包可下载，再投稿。仓库应有 `dsh-plugin` topic。目录合并与站点构建完成后市场才可见。

Submit the single entry file under `data/plugins/` in the community catalog, following its contribution guide. This directory holds the entry to submit. Verify the pinned release asset first and add the `dsh-plugin` repository topic. A release or open PR alone is not a live market listing; maintainers must merge it and the catalog must rebuild.
