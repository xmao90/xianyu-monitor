# 🐟 闲鱼上新监控

实时监控闲鱼商品上新，发现好价立即提醒。

## 功能特性

- 🔍 **关键词监控** - 支持多个关键词同时监控，自定义价格区间
- 📊 **实时上新** - 自动轮询，发现新商品高亮显示
- ⭐ **收藏管理** - 一键收藏/隐藏商品
- 🔔 **声音提醒** - 发现新商品时播放提示音
- 📱 **响应式设计** - 支持手机和电脑访问

## 一键部署到 Render（免费）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xmao90/xianyu-monitor)

部署步骤：
1. 点击上方按钮，进入 Render
2. 用 GitHub 账号登录
3. 点击 **"New Web Service"**
4. 确保选择了 `xianyu-monitor` 仓库
5. 设置：
   - **Name**: `xianyu-monitor`
   - **Region**: Singapore（新加坡节点，速度快）
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. 点击 **"Create Web Service"** 等待部署完成
7. 部署成功后，复制 Render 给你的域名

## 本地运行

```bash
git clone https://github.com/xmao90/xianyu-monitor
cd xianyu-monitor
npm install
npm start
# 访问 http://localhost:3000
```

## 登录信息

- **默认账号**: `admin`
- **默认密码**: `admin123`

> ⚠️ 首次登录后请立即修改密码！

## 技术栈

- **后端**: Node.js + Express
- **前端**: 纯 HTML/CSS/JS（无框架）
- **数据存储**: JSON 文件

## 免责声明

本工具仅供学习研究使用，请勿用于商业目的或违反闲鱼平台规则的行为。
