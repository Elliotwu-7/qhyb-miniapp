# 微信小程序

独立 uni-app Vue 3 工程，使用 [Wot UI](https://wot-ui.cn/)（npm：`@wot-ui/ui`）。不替换线上 React 站点 `qhyb.online`。

```bash
cd miniapp
pnpm install
pnpm run build:mp-weixin
```

Windows 上不要在 `H:` 用 npm 11 装依赖（会写出空 `node_modules`）。本机工作树在 `G:\qhyb-miniapp`（pnpm；本机没有全局 pnpm，用 `corepack pnpm ...`）。

用微信开发者工具打开 `dist/build/mp-weixin`（开发：`pnpm run dev:mp-weixin` → `dist/dev/mp-weixin`）。AppID `wx38caf724f6f31625`。

无头核对：`corepack pnpm exec uni build -p h5 && node scripts/check_h5.mjs` —— 把同一套页面编到 H5，在 headless Edge 里验首页计数、药品搜索、hop 过滤，断言只查结果区，不查搜索框。

隐私授权使用注册页的 `PrivacyPrompt` 和微信原生同意按钮；`onNeedPrivacyAuthorization` 接收的是函数回调。普通点击、打开协议失败不能授权，页面隐藏/卸载会拒绝尚未结束的请求。`node scripts/check_privacy.mjs` 验证状态逻辑；H5 构建后 `node scripts/check_privacy_ui.mjs` 以模拟 SDK 事件验证三语言 375px 页面；`check_privacy_wechat.mjs` 检查真实编译模块、WXML 并截取原生渲染，不能代替真机同意流程。当前模拟器端口默认 9432，可用 `QHYB_AUTOMATION_PORT` 覆盖。

全套核对：`node scripts/run_checks.mjs`（串行跑 `scripts/check_*.mjs`，单个超过 12 分钟自动杀掉，可加关键词只跑一部分，如 `run_checks.mjs spec hc`）。微信模拟器那三项要先起自动化，而且同一个项目只能有一个实例：先 `cli.bat auto --project G:\qhyb-miniapp --auto-port 9431` 跑 `check_wechat_search`／`check_wechat_terms`／`check_wechat_feedback`，再换 `--auto-port 9432` 跑 `check_privacy_wechat`；两个实例同时开着，后起的会把先起的顶掉，那两个脚本会 0 秒断连。刚起好的实例逻辑层还没热身，头一两次 RPC 可能被桥回 `timeout waiting for automator response`，所以 `check_privacy_wechat` 先空转等它能答话再开验。

H5 那批检查的端口一律 `await freePort()`（见 `scripts/h5env.mjs`），不要写回 `8990 + Math.random() * 80` 那种随机号：本机常驻程序占着其中某个号时（2026-09-25 撞到 9012 上的 ASUS ArmourySocketServer）会 `EADDRINUSE` 崩在启动那一步，0 秒失败、没有输出，和「端口没起」长得一样，白查一轮。

2026-09-25 最新上传为开发版 **1.1.18**（556038 Byte，回执 `G:\QYB\tmp\miniapp-upload-1.1.18.json`）；上一版 1.1.17 是 553603 Byte。这一版修「返回」：分享卡和扫码进来的页面（项目详情 / 关联网络 / 技术规范 / 药品说明书 / 登录）微信给的页面栈里只有这一页，原生返回箭头会**退出小程序**，而 `uni.navigateBack` 在单页栈上是静默空操作 —— 实测栈和当前页都不变、`fail` 不触发、自动化连接也不断，所以 `register.vue` 原来那句「navigateBack 失败就兜底」是死代码。现在这几页用 `lib/nav.ts` 先看栈：有上一页才 `navigateBack`，只有这一页就 `switchTab` 回查询页，并在左上角画一颗「返回首页」胶囊（`components/HomePill.vue`）。胶囊只在单页栈上出现，有上一页时不显示，搜索结果页的顶栏不受影响。平台上**没有**「让原生导航栏画一个返回首页按钮」的 API：基础库 3.17.3 的 `wx` 上只有 `hideHomeButton`，没有 `showHomeButton`（2026-09-25 在模拟器里对着 749 个 `wx` 键查过）。上传不等于提审或正式发布。平台隐私设置修订草稿在 `G:\QYB\微信平台发布材料-2026-09-23`，待实际数据存放地区及保存策略核实。CLI 的 `upload`／`preview` 可以和 `auto` 起的自动化实例并存（都走 IDE 的 3800 端口），不用先停掉自动化。

1.1.17（553603 Byte）把技术规范做成搜索时与药品、诊疗项目平级的第五栏（首页与搜索页的范围栏），命中线上规范库并以普通结果卡渲染（靛色「技术规范」标记 + 编号 + 页码 + 赞/踩/反馈），点整张卡进规范原文页；规范不并入本地目录的 `hits`，「全部」档的分档计数与顺序不受影响，其他档里原有的规范小节保留为兜底。

微信的 `setClipboardData`／`getClipboardData` 属于隐私接口：用户没同意隐私协议时**调用直接失败**，实测 `errno 104 privacy permission is not authorized`（2026-09-25 在模拟器里验到）。复制类按钮一律要接 `fail` 并把内容直接显示出来，否则点了什么都不发生（「反馈微信无效」就是这个）。同意只能来自原生 `agreePrivacyAuthorization` 按钮，模拟器里改不动，所以这类分支在检查里要打桩成成功／失败各跑一遍（`scripts/check_wechat_feedback.mjs`）。

## 小程序端的坑：不要用 for...of / 别在块里声明局部量

微信开发者工具会把 ES6 降到 ES5。降级时 `for (const x of xs)` 会变成**函数作用域**的 `var x`，而压缩器是照着 ES6 的块级作用域取名的 —— 一旦循环变量和某个模块级绑定重名，提升上来的 `var` 就会把同一个函数里更早的引用顶成 `undefined`。症状是 `Cannot read properties of undefined (reading 'xxx')`，而且 H5 构建完全复现不出来。

实际踩过：`relatedOf` 里 `for (const edge of edges)` 与 types 模块重名，`isDrug` 崩。同类还有 `try` 块里 `const r = await ...` 把模块引用的名字顶掉，导致 `catch` 里的 `failMessage` 失效。

规避方式：

- 遍历用 `forEach` / `map` / `some` —— 回调参数在嵌套函数作用域里，不受降级影响。
- 结果变量声明在 `try` 外面（`let x; try { x = await ... }`），不要 `try { const x = await ... }`。

改完必须跑守卫生效检查：

```bash
corepack pnpm run build:mp-weixin && node scripts/check_es5_shadow.mjs
```

它会报出"某个函数既引用了模块级绑定、又在嵌套块里声明了同名变量"的地方。`common/vendor.js` 是框架预构建产物，已跳过。

数据走 `https://qhyb.lynkco.site/data/{meta,search,usage,d/*.json}`，账号接口走同域 `/api/mp/*`。`qhyb.lynkco.site` 已备案；`qhyb.online` 未备案，不要当小程序合法域名。公众平台 request 合法域名配 `https://qhyb.lynkco.site`。源码在 `src/`。

功能：

- 启动时 `wx.login` → `POST /api/mp/login`，会话 token 存在本地。
- 「我的」里配置医院等级（三级/二级/一级），查询和详情只显示该等级价格。
- 每日签到写入服务端；激励广告位预留，未接 SDK。

Excel「备注」展示在结果卡和详情；类别「使用说明」来自 `usage.json`，不要混成备注。查询页无导出。
