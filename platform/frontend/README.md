# React 管理界面

前端使用 React 19、Vite、Tailwind CSS 4 和 shadcn/ui 的本地可编辑组件。组件源码位于 `src/components/ui/`，Dialog 和 Tabs 使用 Radix 的键盘、焦点管理与无障碍语义；组件配置见 `components.json`。

配色参考 [Linear 官网](https://linear.app)：近黑背景 `#08090a`、面板 `#0f1011`、浅灰主按钮 `#e5e5e6`、主文字 `#f7f8f8`、次级文字 `#8a8f98`、边框 `#23252a`。蓝紫强调色 `#7170ff` 用于图表、进度和焦点；菜单选中使用中性灰，绿、黄、红保留运行状态语义。配色集中在 `src/styles.css` 的主题变量中。

## 运行

在 `platform/` 中执行：

```sh
npm ci
npm start
```

`npm start`、`npm run app`、`npm run web` 都会先构建界面。默认访问 `http://127.0.0.1:18080`。需要管理凭证时，使用 `manager-auth/token` 文件或 `MANAGER_AUTH_TOKEN` 中的值。Electron 自动完成认证引导。

开发时另开终端运行 `npm run build:watch`，修改后刷新管理页面。直接通过 Express 提供页面，保持认证、SSE、WebSocket 和 SSH 代理同源。

## 目录与边界

- `src/App.jsx`：导航、实例列表、SSE、设备切换和工作空间概览。
- `src/pages/`：实例详情、模型、飞书访问规则、Agent、技能与插件、工作区、定时任务、会话、终端、镜像、备份和 SSH。
- `src/components/ui/`：shadcn/ui 组件源码；`shared.jsx`：业务表单、加载和错误状态。
- `src/lib/`：API、CSRF、请求取消、草稿保护及格式化工具。
- `src/styles.css`：Tailwind 入口和深色主题变量。
- `../public/ui/`：Vite 生成的产物，不提交版本控制。

Express 只提供 `public/ui/` 中的新前端。`public/` 原有页面和脚本保留作迁移审查、旧版代理兼容与历史测试参考，新入口不加载它们。后端 API 与认证协议保持兼容。

页面切换时，未保存编辑会请求确认。文件写入沿用服务端 revision 校验。插件安装保留来源审查、固定版本手动确认与权限变更后的再次确认。SSH 指纹与目标主机绑定，修改目标后需要重新核对。隐藏页面暂停轮询请求并关闭 SSE；终端离开页签时释放连接。

## 构建与部署

```sh
npm run build
npm run dist:win
```

Electron 的 `beforePack` 钩子重新构建前端。Docker 在依赖阶段安装开发工具并构建，在运行阶段使用生产依赖和静态产物。SSH 部署源码包包含 `frontend/` 与 `vite.config.mjs`；打包的桌面应用同样携带这些构建源文件，支持远程重新构建。新旧远程 Manager 的页面分别处理，React 页面不会注入旧版 DOM 设备切换脚本。

## 验证

```sh
npm test
npm run build
npm run test:frontend
npx playwright install chromium
npm run test:ui
```

浏览器测试使用生产构建和隔离的 API fixtures，不操作真实实例。覆盖认证、桌面与手机布局、实例创建、配置预览与 revision、流式对话、SSH 指纹、插件二阶段确认、镜像清理令牌及启动设置。`test:frontend` 还使用临时数据目录启动真实 Express 服务，验证静态入口、CSP 和 API 认证，并测试 UTF-8/NDJSON 流边界。

真实 Docker 容器、远程 SSH 目标以及 Electron 安装包需要在对应环境完成运行验收。
