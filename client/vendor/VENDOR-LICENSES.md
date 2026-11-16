# client/vendor — Live2D 桌宠渲染运行时（第三方）

按「插件单文件装载契约」，Web 客户端半（client.js）不能引用外部文件；
这三个运行时经宿主共享 API（`/api/dafeiyu/avatar/vendor`）以脚本文本下发，
由客户端以 blob `<script>` 顺序注入：**core → pixi → pixi-live2d-display**。

| 文件 | 版本 | 许可 | 来源 |
| --- | --- | --- | --- |
| `live2dcubismcore.min.js` | Cubism Core（Web） | Live2D Proprietary License（免费小规模事业者条款，允许随应用再分发；不得逆向） | https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js |
| `pixi.min.js` | pixi.js 7.4.3 | MIT | https://unpkg.com/pixi.js@7.4.3/dist/pixi.min.js |
| `pixi-live2d-display.min.js` | 0.5.0-beta（Cubism 4） | MIT，见 `pixi-live2d-display.LICENSE.txt` | https://registry.npmjs.org/pixi-live2d-display/-/pixi-live2d-display-0.5.0-beta.tgz（`package/dist/cubism4.min.js`） |

Cubism 4 发行包适配 PixiJS 7。浏览器单文件装载时，将包内唯一一处 `process.env.NODE_ENV` 替换为 `"production"`，避免依赖 Node.js 全局变量。

升级口径：替换文件并核对上表来源与许可不变；Cubism Core 版本以
[官方发布页](https://www.live2d.com/sdk/download/web/)为准。

角色模型（.moc3 等）**不在本目录、不入仓库**：模型按「本地数据目录 +
manifest」管理（`data/models/<id>/`，`data/` 已 gitignore），拉取脚本见
`scripts/fetch-live2d-samples.sh`（默认源为 Live2D 官方开源示例仓库
CubismWebSamples，其角色素材适用 Live2D Free Material License Agreement，
仅限本地/学习用途，商用需自行取得素材授权）。
