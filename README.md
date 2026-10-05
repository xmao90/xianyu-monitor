# 🐟 闲鱼上新监控

实时监控闲鱼商品上新，发现好价立即提醒。

## 功能特性

- 🔍 **关键词监控** - 支持多个关键词同时监控，自定义价格区间
- 📊 **实时上新** - 自动轮询，发现新商品高亮显示
- ⭐ **收藏管理** - 一键收藏/隐藏商品
- 🔔 **声音提醒** - 发现新商品时播放提示音
- 📱 **响应式设计** - 支持手机和电脑访问


## 快速部署

### 方式一：Railway 部署（推荐，免费）

1. 打开 [railway.app](https://railway.app)，用 GitHub 登录
2. 点击 **New Project** → **Deploy from GitHub repo** → 选择 `xmao90/xianyu-monitor`
3. Railway 会自动检测 Node.js 项目并部署
4. 部署完成后，访问 Railway 提供的域名即可

> Railway 免费额度：每月 500 小时，足够个人使用

### 方式二：本地运行

```bash
cd xianyu-monitor
npm install
npm start
# 访问 http://localhost:3000
```

### 方式三：Docker 部署

```bash
docker build -t xianyu-monitor .
docker run -d -p 3000:3000 xianyu-monitor
```

## 登录信息

- **默认账号**: `admin`
- **默认密码**: `admin123`

> ⚠️ 首次登录后请立即修改密码！

## 域名绑定

部署到 Railway 后，可以将自定义域名绑定到你的 Railway 项目：
- Railway Dashboard → 项目 → Settings → Networking → Add Domain

## 技术栈

- **后端**: Node.js + Express
- **前端**: 纯 HTML/CSS/JS（无框架）
- **数据存储**: JSON 文件（SQLite 兼容）

## 免责声明

本工具仅供学习研究使用，请勿用于商业目的或违反闲鱼平台规则的行为。
