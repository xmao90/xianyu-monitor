const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== JSON 数据库 ====================
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return initDB();
}

function initDB() {
  return {
    users: [{ id: 1, username: 'admin', password: sha256('admin123') }],
    keywords: [],
    items: [],
    scanLogs: [],
    settings: {
      auto_scan: 'true',
      scan_interval: '30',
      notify_sound: 'true',
      // 存储所有平台的 cookies
      xianyu_cookies: '',
      proxy_enabled: 'false',
      proxy_url: '',
    },
    nextId: { users: 2, keywords: 1, items: 1, scanLogs: 1 }
  };
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();
let sessions = loadSessions();

// ==================== 认证 ====================
let currentSession = null;

function verifyToken(req, res, next) {
  const token = req.headers['x-token'];
  if (!token || token !== currentSession) return res.status(401).json({ error: '未登录或登录已过期' });
  next();
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function nextId(table) {
  const id = db.nextId[table];
  db.nextId[table]++;
  return id;
}

// ==================== HTTP 工具 ====================
function httpGet(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;
    const parsedUrl = new URL(url);
    
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers
    };
    
    // 添加当前保存的 cookies
    if (db.settings.xianyu_cookies) {
      reqHeaders['Cookie'] = db.settings.xianyu_cookies;
    }
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: reqHeaders,
      timeout,
    };
    
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, setCookies: res.headers['set-cookie'] || [] }));
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpPost(url, body, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;
    const parsedUrl = new URL(url);
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...headers
    };
    
    if (db.settings.xianyu_cookies) {
      reqHeaders['Cookie'] = db.settings.xianyu_cookies;
    }
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: reqHeaders,
      timeout,
    };
    
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, setCookies: res.headers['set-cookie'] || [] }));
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ==================== 闲鱼/Goofish API 抓取 ====================

// 尝试多个数据源
async function fetchItems(keyword, page = 1) {
  const allItems = [];
  const sources = [];
  
  // 方法1: goofish.com 搜索 API
  try {
    const result = await fetchFromGoofish(keyword, page);
    if (result.items.length > 0) {
      allItems.push(...result.items);
      sources.push('goofish');
    }
  } catch(e) { sources.push('goofish:error:' + e.message); }
  
  // 方法2: 闲鱼市场 API  
  try {
    const result = await fetchFromXianyu(keyword, page);
    if (result.items.length > 0) {
      allItems.push(...result.items);
      sources.push('xianyu');
    }
  } catch(e) { sources.push('xianyu:error:' + e.message); }
  
  // 方法3: 抓取搜索页 HTML（无登录）
  try {
    const result = await fetchFromSearchPage(keyword, page);
    if (result.items.length > 0) {
      allItems.push(...result.items);
      sources.push('html');
    }
  } catch(e) { sources.push('html:error:' + e.message); }
  
  // 去重
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (seen.has(item.itemId)) return false;
    seen.add(item.itemId);
    return true;
  });
  
  return { items: unique, sources };
}

// Goofish.com 搜索
async function fetchFromGoofish(keyword, page) {
  // Goofish API endpoints
  const urls = [
    `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}&page=${page}&pageSize=30&sort=default`,
    `https://www.goofish.com/open/api/search?q=${encodeURIComponent(keyword)}&pageNum=${page}&pageSize=30`,
    `https://open.goofish.com/api/search?keyword=${encodeURIComponent(keyword)}&page=${page}`,
  ];
  
  for (const url of urls) {
    try {
      const res = await httpGet(url, {
        'Referer': 'https://www.goofish.com/',
        'Origin': 'https://www.goofish.com',
        'Accept': 'application/json, */*',
      });
      
      if (res.status === 200 && res.body.length > 100) {
        const data = JSON.parse(res.body);
        const items = extractItemsFromResponse(data);
        if (items.length > 0) return { items };
      }
    } catch(e) {}
  }
  
  return { items: [] };
}

// 闲鱼市场搜索
async function fetchFromXianyu(keyword, page) {
  const urls = [
    `https://market.xianyu.com/api/search/item?q=${encodeURIComponent(keyword)}&page=${page}&pageSize=30`,
    `https://market.xianyu.com/api/search?q=${encodeURIComponent(keyword)}&page=${page}`,
    `https://xianyu.m.taobao.com/hsearch.do?q=${encodeURIComponent(keyword)}&page=${page}`,
  ];
  
  for (const url of urls) {
    try {
      const res = await httpGet(url, {
        'Referer': 'https://market.xianyu.com/',
        'Origin': 'https://market.xianyu.com',
        'X-Requested-With': 'XMLHttpRequest',
      });
      
      if (res.status === 200 && res.body.length > 100) {
        const data = JSON.parse(res.body);
        const items = extractItemsFromResponse(data);
        if (items.length > 0) return { items };
      }
    } catch(e) {}
  }
  
  return { items: [] };
}

// 抓取搜索页 HTML（SSR方式）
async function fetchFromSearchPage(keyword, page) {
  const urls = [
    `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}&page=${page}`,
    `https://market.xianyu.com/search?q=${encodeURIComponent(keyword)}&page=${page}`,
  ];
  
  for (const url of urls) {
    try {
      const res = await httpGet(url, {
        'Accept': 'text/html,application/xhtml+xml',
      });
      
      if (res.status === 200) {
        const items = parseItemsFromHTML(res.body);
        if (items.length > 0) return { items };
      }
    } catch(e) {}
  }
  
  return { items: [] };
}

// 从响应数据中提取商品
function extractItemsFromResponse(data) {
  const items = [];
  
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    
    // 匹配商品数据模式
    if (obj.itemId || obj.id) {
      const itemId = String(obj.itemId || obj.id || '');
      if (itemId.length >= 8) {
        items.push(normalizeItem(obj));
      }
    }
    
    // 尝试从常见字段提取
    const arrays = ['items', 'result', 'data', 'list', 'products', 'goods', 'auctions'];
    for (const key of arrays) {
      if (Array.isArray(obj[key])) {
        obj[key].forEach(item => {
          if (item && typeof item === 'object') {
            const itemId = String(item.itemId || item.id || item.item_id || '');
            if (itemId.length >= 8) {
              items.push(normalizeItem(item));
            } else {
              walk(item);
            }
          }
        });
      }
    }
    
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        obj[key].forEach(item => {
          if (item && typeof item === 'object') walk(item);
        });
      }
    }
  }
  
  walk(data);
  return items;
}

// 从 HTML 中提取商品
function parseItemsFromHTML(html) {
  const items = [];
  
  // 提取 script 标签中的 JSON 数据
  const scriptPatterns = [
    /window\.__INITIAL_STATE__\s*=\s*({.+?})\s*;?\s*<\/script>/s,
    /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
    /window\.__PRELOADED_STATE__\s*=\s*({.+?})\s*;?\s*<\/script>/s,
    /window\.__xx_SEARCH__\s*=\s*({.+?})\s*;?\s*<\/script>/s,
  ];
  
  for (const pattern of scriptPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        const data = JSON.parse(match[1]);
        const found = extractItemsFromResponse(data);
        if (found.length > 0) {
          items.push(...found);
          break;
        }
      } catch(e) {}
    }
  }
  
  // 正则匹配商品数据
  if (items.length === 0) {
    // 匹配 itemId + title + price 组合
    const itemBlockPattern = /"itemId"\s*[:=]\s*"?(\d{8,})"?[^}]{0,500}?"title"\s*[:=]\s*"([^"]{4,200})"/g;
    let match;
    while ((match = itemBlockPattern.exec(html)) !== null) {
      const block = html.substring(Math.max(0, match.index - 100), match.index + 500);
      
      const priceMatch = block.match(/"(price|currentPrice|curPrice|priceInfo)"\s*[:=]\s*"?([\d.]+)"?/);
      const locMatch = block.match(/"(location|city|region|addr)"\s*[:=]\s*"([^"]+)"/);
      const sellerMatch = block.match(/"(seller|nick|sellerName|userNick)"\s*[:=]\s*"([^"]+)"/);
      const picMatch = block.match(/"(picUrl|imageUrl|picture|mainPic)"\s*[:=]\s*"([^"]+)"/);
      
      items.push({
        itemId: match[1],
        title: decodeText(match[2]),
        price: priceMatch ? parseFloat(priceMatch[2]) : 0,
        location: locMatch ? locMatch[2] : '',
        seller: sellerMatch ? sellerMatch[2] : '',
        imageUrl: picMatch ? picMatch[2] : '',
        detailUrl: `https://www.goofish.com/item/${match[1]}`,
        isNew: true,
      });
    }
  }
  
  return items.filter(i => i.itemId && i.title);
}

// 标准化商品
function normalizeItem(raw) {
  const itemId = String(raw.itemId || raw.id || raw.item_id || '');
  
  // 提取价格
  let price = 0;
  if (typeof raw.price === 'number') price = raw.price;
  else if (typeof raw.price === 'string') price = parseFloat(raw.price);
  else if (raw.currentPrice) price = parseFloat(raw.currentPrice);
  else if (raw.curPrice) price = parseFloat(raw.curPrice);
  else if (raw.priceInfo) {
    const pi = raw.priceInfo;
    price = parseFloat(pi.price || pi.currentPrice || pi.salePrice || 0);
  }
  
  // 提取标题
  const title = raw.title || raw.itemTitle || raw.name || raw.subject || '';
  
  // 提取图片
  let imageUrl = raw.imageUrl || raw.picUrl || raw.mainPic || raw.picture || raw.imgUrl || '';
  if (imageUrl && !imageUrl.startsWith('http')) {
    imageUrl = 'https:' + imageUrl;
  }
  
  // 提取详情 URL
  let detailUrl = raw.detailUrl || raw.itemUrl || raw.auctionURL || raw.link || '';
  if (!detailUrl) {
    detailUrl = raw.itemId ? `https://www.goofish.com/item/${itemId}` : '';
  } else if (!detailUrl.startsWith('http')) {
    detailUrl = 'https://www.goofish.com' + detailUrl;
  }
  
  return {
    itemId,
    title: decodeText(title),
    price,
    location: raw.location || raw.city || raw.region || raw.province || '',
    seller: raw.seller || raw.nick || raw.userNick || raw.sellerName || raw.shopName || '',
    sellerCredit: raw.sellerCredit || raw.rateSum || '',
    imageUrl,
    detailUrl,
    isNew: true,
  };
}

function decodeText(str) {
  if (!str) return '';
  try {
    // 处理 JSON unicode 转义
    const withQuotes = '"' + str.replace(/"/g, '\\"') + '"';
    return JSON.parse(withQuotes);
  } catch(e) {
    try { return decodeURIComponent(str); } catch(e2) { return str; }
  }
}

// ==================== 自动扫描 ====================
let scanTimer = null;

async function runScan() {
  const keywords = db.keywords.filter(k => k.enabled);
  if (keywords.length === 0) return;
  
  for (const kw of keywords) {
    try {
      console.log(`[扫描] ${kw.keyword}...`);
      const result = await fetchItems(kw.keyword, 1);
      const items = result.items || [];
      
      console.log(`  -> 找到 ${items.length} 个商品 (${result.sources.join(',')})`);
      
      let newCount = 0;
      for (const item of items) {
        // 价格过滤
        if (item.price < kw.min_price || item.price > kw.max_price) continue;
        
        const existing = db.items.find(i => i.itemId === item.itemId);
        if (!existing) {
          db.items.push({
            id: nextId('items'),
            itemId: item.itemId,
            title: item.title,
            price: item.price,
            location: item.location,
            seller: item.seller,
            sellerCredit: item.sellerCredit,
            imageUrl: item.imageUrl,
            detailUrl: item.detailUrl,
            keywordId: kw.id,
            keyword: kw.keyword,
            firstSeen: new Date().toISOString(),
            lastCheck: new Date().toISOString(),
            isNew: true,
            isFavorited: false,
            isHidden: false,
          });
          newCount++;
        } else {
          existing.lastCheck = new Date().toISOString();
        }
      }
      
      db.scanLogs.push({
        id: nextId('scanLogs'),
        keywordId: kw.id,
        foundCount: items.length,
        newCount,
        sources: result.sources.join(','),
        scannedAt: new Date().toISOString(),
      });
      
      if (newCount > 0) console.log(`  -> 🆕 新增 ${newCount} 个商品!`);
      
      saveDB(db);
      await sleep(1500); // 避免请求过快
    } catch (err) {
      console.error(`[扫描错误] ${kw.keyword}:`, err.message);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  const interval = (parseInt(db.settings.scan_interval) || 30) * 1000;
  scanTimer = setInterval(runScan, interval);
  console.log(`✅ 自动扫描已启动，间隔 ${interval/1000}s`);
}

// 启动扫描
setTimeout(async () => {
  if (db.settings.auto_scan === 'true') {
    await runScan();
    startAutoScan();
  }
}, 2000);

// ==================== REST API ====================

// 手动触发扫描
app.post('/api/scan', verifyToken, async (req, res) => {
  try {
    await runScan();
    res.json({ success: true, message: '扫描完成' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 关键词 CRUD
app.get('/api/keywords', verifyToken, (req, res) => res.json(db.keywords));

app.post('/api/keywords', verifyToken, (req, res) => {
  const { keyword, min_price = 0, max_price = 999999 } = req.body;
  if (!keyword) return res.status(400).json({ error: '关键词不能为空' });
  const kw = {
    id: nextId('keywords'),
    keyword: keyword.trim(),
    min_price: parseInt(min_price),
    max_price: parseInt(max_price),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  db.keywords.push(kw);
  saveDB(db);
  res.json({ success: true, ...kw });
});

app.put('/api/keywords/:id', verifyToken, (req, res) => {
  const kw = db.keywords.find(k => k.id === parseInt(req.params.id));
  if (!kw) return res.status(404).json({ error: '未找到' });
  const { keyword, min_price, max_price, enabled } = req.body;
  if (keyword !== undefined) kw.keyword = keyword;
  if (min_price !== undefined) kw.min_price = min_price;
  if (max_price !== undefined) kw.max_price = max_price;
  if (enabled !== undefined) kw.enabled = enabled;
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/keywords/:id', verifyToken, (req, res) => {
  db.keywords = db.keywords.filter(k => k.id !== parseInt(req.params.id));
  saveDB(db);
  res.json({ success: true });
});

// 商品列表
app.get('/api/items', verifyToken, (req, res) => {
  const { keyword_id, is_new, page = 1, limit = 50 } = req.query;
  let items = db.items.filter(i => !i.isHidden);
  if (keyword_id) items = items.filter(i => i.keywordId === parseInt(keyword_id));
  if (is_new !== undefined) items = items.filter(i => i.isNew === (is_new === '1'));
  items = items.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
  const total = items.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  res.json({ items: items.slice(offset, offset + parseInt(limit)), total, page: parseInt(page), limit: parseInt(limit) });
});

// 商品操作
app.put('/api/items/:itemId/:action', verifyToken, (req, res) => {
  const item = db.items.find(i => i.itemId === req.params.itemId);
  if (!item) return res.status(404).json({ error: '未找到' });
  switch(req.params.action) {
    case 'read': item.isNew = false; break;
    case 'favorite': item.isFavorited = true; break;
    case 'unfavorite': item.isFavorited = false; break;
    case 'hide': item.isHidden = true; break;
    default: return res.status(400).json({ error: '未知操作' });
  }
  saveDB(db);
  res.json({ success: true });
});

// 收藏列表
app.get('/api/items/favorites', verifyToken, (req, res) => {
  res.json(db.items.filter(i => i.isFavorited && !i.isHidden).sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen)));
});

// 统计
app.get('/api/stats', verifyToken, (req, res) => {
  const totalItems = db.items.filter(i => !i.isHidden).length;
  const newItems = db.items.filter(i => i.isNew && !i.isHidden).length;
  const favorites = db.items.filter(i => i.isFavorited && !i.isHidden).length;
  const keywords = db.keywords.filter(k => k.enabled).length;
  const recentScans = db.scanLogs.slice(-10).reverse().map(log => ({
    ...log,
    keyword: db.keywords.find(k => k.id === log.keywordId)?.keyword || ''
  }));
  const today = new Date().toISOString().split('T')[0];
  const todayNew = db.items.filter(i => !i.isHidden && i.firstSeen.startsWith(today)).length;
  res.json({ totalItems, newItems, favorites, keywords, recentScans, todayNew });
});

// 设置
app.get('/api/settings', verifyToken, (req, res) => {
  const settings = { ...db.settings };
  if (settings.xianyu_cookies && settings.xianyu_cookies.length > 0) {
    settings.xianyu_cookies = '✅ 已设置 (' + settings.xianyu_cookies.length + ' 字符)';
  } else {
    settings.xianyu_cookies = '❌ 未设置';
  }
  res.json(settings);
});

// 保存 Cookie
app.post('/api/settings/cookies', verifyToken, (req, res) => {
  const { cookies } = req.body;
  db.settings.xianyu_cookies = cookies || '';
  saveDB(db);
  console.log(`[Cookie] 已保存 ${cookies ? cookies.length + ' 字符' : '（已清除）'}`);
  res.json({ success: true, message: cookies ? `✅ Cookie 已保存 (${cookies.length} 字符)` : '❌ Cookie 已清除' });
});

// 更新设置
app.put('/api/settings', verifyToken, (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    if (key !== 'xianyu_cookies') {
      db.settings[key] = value;
    }
  }
  saveDB(db);
  if (db.settings.auto_scan === 'true' && !scanTimer) startAutoScan();
  else if (db.settings.auto_scan === 'false' && scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  res.json({ success: true });
});

// 实时搜索（不保存）
app.get('/api/search', verifyToken, async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: '缺少搜索词' });
  try {
    const result = await fetchItems(q, parseInt(page));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试连接
app.get('/api/test-connection', verifyToken, async (req, res) => {
  try {
    const result = await fetchItems('iPhone', 1);
    res.json({
      success: result.items.length > 0,
      itemCount: result.items.length,
      sources: result.sources,
      sample: result.items[0] || null,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), hasCookies: !!db.settings.xianyu_cookies });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });
  const hash = sha256(password);
  const user = db.users.find(u => u.username === username && u.password === hash);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  currentSession = crypto.randomBytes(32).toString('hex');
  res.json({ success: true, token: currentSession, username: user.username });
});

app.post('/api/logout', (req, res) => {
  currentSession = null;
  res.json({ success: true });
});

app.get('/api/check', (req, res) => {
  const token = req.headers['x-token'];
  res.json({ loggedIn: token === currentSession && currentSession !== null });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🐟 闲鱼上新监控服务已启动');
  console.log(`  📡 地址: http://0.0.0.0:${PORT}`);
  console.log(`  🔐 默认账号: admin / admin123`);
  console.log(`  🍪 Cookie: ${db.settings.xianyu_cookies ? '✅ 已设置' : '❌ 未设置'}`);
  console.log(`  🔍 自动扫描: ${db.settings.auto_scan === 'true' ? '✅ 已启用' : '❌ 已禁用'}`);
  console.log('');
});
