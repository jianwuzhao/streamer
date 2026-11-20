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


## 官网收录与 DSH「发现」 / Website listing versus DSH Discover

`plugins.json` 是官网与 dsh-market 的完整目录；`index.json` 是宿主「插件 → 发现」使用的 format-1 索引。社区当前的索引生成器只收录具有 npm 包名、准确版本和发布时间的条目，GitHub Release 安装包本身不会进入这份索引。因此，目录 PR 已合并或官网展示页可访问，并不能证明应用内「发现」能搜到。

`plugins.json` is the complete website/dsh-market catalog. `index.json` is the format-1 source consumed by the host's Discover tab. The current community generator requires an npm package name, exact version and publication timestamp; a GitHub Release archive alone is omitted. A merged catalog PR or working website page does not establish Discover search availability.

补齐流程：使用已验证的同版本预构建包发布 npm，包的 `repository` 必须指回 `jianwuzhao/streamer`；等待社区 npm 映射探测与索引重新发布，再分别核对完整目录和宿主索引中存在本插件。不要手写不被支持的 `npm:` 投稿字段，也不要在 npm 发布前宣称已能搜索到。

Publish the verified prebuilt archive to npm with its repository pointing back to `jianwuzhao/streamer`, then wait for the catalog's npm mapping probe and index publication. Verify both catalog surfaces before declaring it searchable. Do not add an unsupported `npm:` field to the catalog entry.

来源 / Sources: [索引生成器](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/build-index.mjs) · [收录条件](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/lib/market-index.mjs) · [npm 关联说明](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md#npm-package--npm-包optional--可选)


npm 发布需要账号二次验证或符合 npm 要求的发布凭据；`npm whoami` 成功仅表示已登录，不代表能发布。若 `npm publish` 返回 `Two-factor authentication ... is required`，由账号持有人在 npm 官网完成二次验证设置，再在自己的终端完成发布验证；不要把验证码或令牌发到 Issues 或聊天里。

npm publication requires two-factor authentication or an accepted publishing credential. A successful `npm whoami` only confirms sign-in. If npm requires 2FA, the account holder must complete setup on npm and authenticate the publication in their own terminal. Never post OTPs or tokens in issues or chat.


发布记录：2026-11-20，`dsh-dafeiyu-evolve@0.20.0` 已正式发布至 [npm](https://www.npmjs.com/package/dsh-dafeiyu-evolve)，`latest` 指向 `0.20.0`，仓库关联为 `jianwuzhao/streamer`；包摘要与 GitHub Release 安装包一致。正式发布完成与社区发现索引同步是两个状态，须分别确认。

Publication record: `dsh-dafeiyu-evolve@0.20.0` was published to npm on 2026-11-20 with `latest` set to `0.20.0`, its repository mapped to `jianwuzhao/streamer`, and the archive digest matching the GitHub Release asset. npm publication and community Discover index synchronization must be verified separately.
