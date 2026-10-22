# 开发检查与依赖镜像

2026-10-22 的本机验证：完整 `npm run check` 退出码为 0，包含格式、依赖声明、导入路径、入口体积、安装锁、全库 TypeScript 和浏览器依赖检查。没有通过排除文件或添加假的类型声明绕过检查。

## 本次修复

- NVIDIA 的在线测试指定 Nemotron 3.5 Super VL，但本地下载的模型目录尚未收录它。测试现在只在实际执行时精确查找同一个模型；缺失则明确提示更新目录。没有更换模型，也保留全部五项在线测试。
- `@cloudflare/vitest-plugin@1.4.4` 与 `fake-indexeddb@6.2.6` 已在仓库中声明并锁定，但本机安装目录缺少这两个包及其依赖。按原锁补齐后，类型检查恢复。
- IndexedDB 测试增加 telemetry 的源码别名，源码检出后可以直接运行，不必先生成 telemetry 的编译输出。该文件 54 项本地测试通过。

## 当前源不可用时

本机原先的 npm 镜像缺少上述两个锁定版本，官方 npm 直连失败。查询 [腾讯云官方软件源说明](https://www.tencentcloud.com/zh/document/product/213/8623) 后，实测其 HTTPS 镜像提供两个精确版本；返回的完整性摘要与仓库 `package-lock.json` 一致。

已安装过依赖的本机，本次采用以下命令补齐 durable 工作区的缺项：

```bash
npm install --no-save --ignore-scripts --include=dev \
  --workspace=@earendil-works/pi-durable \
  --registry=https://mirrors.tencent.com/npm/ \
  --no-audit --no-fund
```

实际安装新增 33 个已锁定的包，并重新链接一个同版本工作区包。`package.json`、`package-lock.json` 与 durable 的依赖清单均未变化；registry 仅对该次命令生效。镜像可用性会变化，后续安装仍以锁文件完整性校验为准。

全新检出应使用主 README 的安装流程。需要指定本次验证过的镜像时，可使用：

```bash
npm ci --ignore-scripts --registry=https://mirrors.tencent.com/npm/
npm run hydrate:model-data
npm run check
```

## 复现本地存储测试

在仓库根目录完成检查后：

```bash
cd packages/durable
node ../../node_modules/vitest/dist/cli.js --run test/indexeddb-storage.test.ts
```

NVIDIA 的五项在线测试没有在本次验证中调用真实模型；采用隔离验证检查了精确查找、缺目录报错和原测试参数。完整类型检查包含该文件。

本机 npm 11.6.2 会对仓库中的 `min-release-age` 设置发出“不识别此配置”的警告；安装时还有既有 autoevals 包关于包管理器的警告。上述信息没有阻止本次完整检查，依赖版本及安全配置未因此修改。
