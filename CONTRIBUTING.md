# 参与贡献

欢迎提交缺陷报告、功能建议和代码。缺陷报告请注明扩展版本、浏览器版本、页面类型与复现步骤。模型问题可附服务商和模型名。提交前请从截图和日志中去掉密钥、账号信息和私密正文。安全问题请参阅 [安全报告指南](SECURITY.md)。

## 本地开发

1. Fork 仓库并克隆，在独立分支上修改。开发测试需要 Node.js 24+、Chrome 或 Chromium。项目使用原生 JavaScript，无需安装 npm 依赖。
2. 在 Chrome 的扩展管理页开启开发者模式，加载源码根目录。修改后重新加载扩展，并刷新测试页面。
3. 运行 `npm test`。后台测试使用模拟响应，浏览器测试使用本地 HTML。两者均无需 X 登录或模型 API Key。
4. 若浏览器测试被跳过，通过 `CHROME_BIN` 指定浏览器的可执行文件路径。例如在 macOS 上运行以下命令。

```sh
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
```

5. 提交 PR，说明问题、改动和实际验证结果。调整模型输入、网页权限或存储方式时，请同步更新 [隐私说明](PRIVACY.md)。

## 打包与发布

本地安装包使用 Node.js 和 `zip` 构建。

```sh
npm test
npm run package
```

解压 `dist/post-english-v<版本>.zip`，确认可在 Chrome 加载。安装包文件由 [打包清单](scripts/package-extension.mjs) 显式列出。添加脚本、页面或图标时要同步更新清单。

发版时更新 `manifest.json` 和 [更新记录](CHANGELOG.md)，合并到 `main`。给该提交推送与清单版本一致的注释标签。例如版本为 `1.5.1` 时，运行以下命令。

```sh
git tag -a v1.5.1 -m "读帖英语 v1.5.1"
git push origin v1.5.1
```

GitHub Actions 在测试通过并核对标签后创建 Release，上传 ZIP。GitHub 仓库需要启用 Actions。
