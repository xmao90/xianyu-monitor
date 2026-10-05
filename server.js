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

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== JSON 数据库 ====================
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch(e) { console.error('DB load error:', e); }
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

let db = loadDB();

// ==================== 认证 ====================
let currentSession = null;

function verifyToken(req, res, next) {
  const token = req.headers['x-token'];
  if (!token || token !== currentSession) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
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

// ==================== HTTP 工具（支持代理） ====================
function httpGet(url, headers = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;
    
    // 解析 URL
    const parsedUrl = new URL(url);
    const proxyUrl = db.settings.proxy_enabled === 'true' ? db.settings.proxy_url : null;
    
    let targetUrl = url;
    let options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers
      },
      timeout,
    };
    
    // 如果有闲鱼 cookies，添加到 headers
    if (db.settings.xianyu_cookies) {
      options.headers['Cookie'] = db.settings.xianyu_cookies;
    }
    
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 处理重定向
          resolve(httpGet(res.headers.location, headers, timeout));
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ==================== 闲鱼 API 核心 ====================

// 闲鱼搜索 API - 多种尝试
async function fetchXianyuSearch(keyword, page = 1) {
  const searchResults = [];
  
  // 方法1: 闲鱼网页搜索 (market.xianyu.com)
  try {
    const result = await fetchFromXianyuWeb(keyword, page);
    if (result.items.length > 0) {
      return { items: result.items, source: 'web', method: 'xianyu_web' };
    }
  } catch(e) {
    console.log('Xianyu web failed:', e.message);
  }
  
  // 方法2: 淘宝/天猫二手市场 API
  try {
    const result = await fetchFromTaobao(keyword, page);
    if (result.items.length > 0) {
      return { items: result.items, source: 'taobao', method: 'taobao_api' };
    }
  } catch(e) {
    console.log('Taobao failed:', e.message);
  }
  
  // 方法3: 直接抓取闲鱼搜索页 HTML
  try {
    const result = await fetchFromXianyuHTML(keyword, page);
    if (result.items.length > 0) {
      return { items: result.items, source: 'html', method: 'xianyu_html' };
    }
  } catch(e) {
    console.log('Xianyu HTML failed:', e.message);
  }
  
  return { items: searchResults, source: 'none', method: 'none' };
}

// 方法1: 闲鱼网页 API
async function fetchFromXianyuWeb(keyword, page) {
  const url = `https://market.xianyu.com/api/search?q=${encodeURIComponent(keyword)}&page=${page}&pageSize=30`;
  const res = await httpGet(url, {
    'Referer': 'https://market.xianyu.com/',
    'Origin': 'https://market.xianyu.com',
    'X-Requested-With': 'XMLHttpRequest',
  });
  
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  
  try {
    const data = JSON.parse(res.body);
    const items = data.result?.items || data.data?.items || [];
    return { items: items.map(normalizeItem).filter(i => i.itemId) };
  } catch(e) {
    throw new Error('JSON parse failed');
  }
}

// 方法2: 淘宝二手 API
async function fetchFromTaobao(keyword, page) {
  // 淘宝二手市场搜索
  const url = `https://s.m.taobao.com/search?q=${encodeURIComponent(keyword)}&type=1&page=${page}&m=api4search`;
  const res = await httpGet(url, {
    'Referer': 'https://2.taobao.com/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  
  try {
    const data = JSON.parse(res.body);
    const items = data.result || data.list || [];
    return { items: items.map(normalizeTaobaoItem).filter(i => i.itemId) };
  } catch(e) {
    throw new Error('JSON parse failed');
  }
}

// 方法3: 直接解析闲鱼 HTML 页面
async function fetchFromXianyuHTML(keyword, page) {
  const url = `https://market.xianyu.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
  const res = await httpGet(url, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  });
  
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  
  const items = [];
  const html = res.body;
  
  // 尝试从 script 中提取 JSON 数据
  const patterns = [
    // window.__INITIAL_STATE__
    /window\.__INITIAL_STATE__\s*=\s*({.*?})\s*;?\s*<\/script>/s,
    // window.__NEXT_DATA__
    /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
    // script[type="application/json"]
    /<script type="application\/json"[^>]*>(.*?)<\/script>/gs,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const jsonStr = Array.isArray(match) ? match[1] : match[1];
        if (jsonStr) {
          const data = JSON.parse(jsonStr);
          const found = extractItemsFromData(data);
          if (found.length > 0) {
            items.push(...found);
            break;
          }
        }
      } catch(e) {}
    }
  }
  
  // 如果还是没找到，尝试正则匹配商品数据
  if (items.length === 0) {
    const itemPatterns = [
      /"itemId"\s*:\s*"?(\d+)"?/g,
      /data-itemid=["']?(\d+)["']?/g,
      /"id"\s*:\s*"(\d{10,})"/g,
    ];
    
    for (const pattern of itemPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const itemId = match[1];
        // 尝试提取周围的商品信息
        const start = Math.max(0, match.index - 500);
        const end = Math.min(html.length, match.index + 500);
        const context = html.slice(start, end);
        
        const titleMatch = context.match(/"title"\s*:\s*"([^"]{5,200})"/);
        const priceMatch = context.match(/"price"\s*:\s*"?([\d.]+)"?/);
        const locationMatch = context.match(/"location"\s*:\s*"([^"]+)"/);
        const sellerMatch = context.match(/"nick"\s*:\s*"([^"]+)"/);
        const picMatch = context.match(/"picUrl"\s*:\s*"([^"]+)"/);
        
        if (titleMatch) {
          items.push({
            itemId,
            title: decode(titleMatch[1]),
            price: priceMatch ? parseFloat(priceMatch[1]) : 0,
            location: locationMatch ? locationMatch[1] : '',
            seller: sellerMatch ? sellerMatch[1] : '',
            imageUrl: picMatch ? picMatch[1] : '',
            detailUrl: `https://market.xianyu.com/item.htm?id=${itemId}`,
          });
        }
      }
      if (items.length > 0) break;
    }
  }
  
  return { items: items.filter(i => i.itemId && i.title) };
}

function extractItemsFromData(data) {
  const items = [];
  
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    
    // 检查是否是商品数据
    if (obj.itemId || obj.id) {
      const itemId = String(obj.itemId || obj.id || '');
      if (itemId.length >= 8) {
        items.push(normalizeItem(obj));
      }
    }
    
    // 递归遍历
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (Array.isArray(val)) {
        val.forEach(item => {
          if (item && typeof item === 'object') walk(item);
        });
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  }
  
  walk(data);
  return items;
}

// 标准化商品数据
function normalizeItem(raw) {
  const itemId = String(raw.itemId || raw.id || raw.item_id || '');
  return {
    itemId,
    title: raw.title || raw.itemName || raw.itemTitle || '',
    price: parseFloat(raw.price || raw.currentPrice || raw.s_price || raw.promoPrice || 0),
    location: raw.location || raw.city || raw.region || '',
    seller: raw.seller || raw.nick || raw.userNick || raw.sellerName || '',
    sellerCredit: raw.sellerCredit || raw.userCredit || '',
    imageUrl: raw.imageUrl || raw.picUrl || raw.mainPic || raw.picture || '',
    detailUrl: raw.detailUrl || raw.itemUrl || `https://market.xianyu.com/item.htm?id=${itemId}`,
    isNew: true,
  };
}

function normalizeTaobaoItem(raw) {
  const itemId = String(raw.itemId || raw.auctionId || raw.id || '');
  return {
    itemId,
    title: raw.title || raw.name || '',
    price: parseFloat(raw.price || raw.currentPrice || 0),
    location: raw.location || raw.city || raw.provience || '',
    seller: raw.nick || raw.seller || '',
    sellerCredit: raw.rateSum || '',
    imageUrl: raw.picPath || raw.img || '',
    detailUrl: raw.detailUrl || raw.auctionURL || `https://item.taobao.com/item.htm?id=${itemId}`,
    isNew: true,
  };
}

function decode(str) {
  if (!str) return '';
  try {
    // 处理 JSON unicode 转义
    return decodeURIComponent(JSON.parse(`"${str.replace(/"/g, '\\"')}"`));
  } catch(e) {
    try { return decodeURIComponent(str); } catch(e2) { return str; }
  }
}

// ==================== 扫描核心 ====================
let scanTimer = null;

async function runScan() {
  const keywords = db.keywords.filter(k => k.enabled);
  
  for (const kw of keywords) {
    try {
      console.log(`[扫描] ${kw.keyword}...`);
      const result = await fetchXianyuSearch(kw.keyword, 1);
      const items = result.items || [];
      
      console.log(`  -> 找到 ${items.length} 个商品 (${result.source})`);
      
      let newCount = 0;
      for (const item of items) {
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
        source: result.source,
        scannedAt: new Date().toISOString(),
      });
      
      if (newCount > 0) {
        console.log(`  -> 新增 ${newCount} 个商品!`);
      }
      
      // 保存
      saveDB(db);
      
      // 避免请求过快
      await sleep(1000);
    } catch (err) {
      console.error(`[扫描错误] ${kw.keyword}:`, err.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  const interval = (parseInt(db.settings.scan_interval) || 30) * 1000;
  scanTimer = setInterval(runScan, interval);
  console.log(`✅ 自动扫描已启动，间隔 ${interval/1000} 秒`);
}

// 启动时执行
setTimeout(async () => {
  if (db.settings.auto_scan === 'true') {
    await runScan();
    startAutoScan();
  }
}, 1500);

// ==================== REST API ====================

app.post('/api/scan', verifyToken, async (req, res) => {
  try {
    await runScan();
    res.json({ success: true, message: '扫描完成' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 关键词 CRUD
app.get('/api/keywords', verifyToken, (req, res) => {
  res.json(db.keywords);
});

app.post('/api/keywords', verifyToken, (req, res) => {
  const { keyword, min_price = 0, max_price = 999999, interval_sec = 30 } = req.body;
  if (!keyword) return res.status(400).json({ error: '关键词不能为空' });
  
  const kw = {
    id: nextId('keywords'),
    keyword: keyword.trim(),
    min_price: parseInt(min_price),
    max_price: parseInt(max_price),
    interval_sec: parseInt(interval_sec),
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
  const { keyword, min_price, max_price, enabled, interval_sec } = req.body;
  if (keyword !== undefined) kw.keyword = keyword;
  if (min_price !== undefined) kw.min_price = min_price;
  if (max_price !== undefined) kw.max_price = max_price;
  if (enabled !== undefined) kw.enabled = enabled;
  if (interval_sec !== undefined) kw.interval_sec = interval_sec;
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
  const paged = items.slice(offset, offset + parseInt(limit));
  
  res.json({ items: paged, total, page: parseInt(page), limit: parseInt(limit) });
});

// 商品操作
app.put('/api/items/:itemId/:action', verifyToken, (req, res) => {
  const { itemId, action } = req.params;
  const item = db.items.find(i => i.itemId === itemId);
  if (!item) return res.status(404).json({ error: '未找到' });
  
  switch(action) {
    case 'read': item.isNew = false; break;
    case 'favorite': item.isFavorited = true; break;
    case 'unfavorite': item.isFavorited = false; break;
    case 'hide': item.isHidden = true; break;
    default: return res.status(400).json({ error: '未知操作' });
  }
  saveDB(db);
  res.json({ success: true });
});

// 收藏
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
  // 不返回完整 cookies
  const settings = { ...db.settings };
  if (settings.xianyu_cookies && settings.xianyu_cookies.length > 0) {
    settings.xianyu_cookies = '****** (已设置)';
  }
  res.json(settings);
});

// 设置闲鱼 Cookies（登录凭证）
app.post('/api/settings/cookies', verifyToken, (req, res) => {
  const { cookies } = req.body;
  db.settings.xianyu_cookies = cookies || '';
  saveDB(db);
  res.json({ success: true, message: cookies ? 'Cookies 已更新' : 'Cookies 已清除' });
});

// 更新其他设置
app.put('/api/settings', verifyToken, (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    if (key !== 'xianyu_cookies') {
      db.settings[key] = value;
    }
  }
  saveDB(db);
  
  if (db.settings.auto_scan === 'true' && !scanTimer) {
    startAutoScan();
  } else if (db.settings.auto_scan === 'false' && scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  
  res.json({ success: true });
});

// 即时搜索（实时查询闲鱼）
app.get('/api/search', verifyToken, async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: '缺少搜索词' });
  try {
    const result = await fetchXianyuSearch(q, parseInt(page));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试闲鱼连接
app.get('/api/test-connection', verifyToken, async (req, res) => {
  try {
    const result = await fetchXianyuSearch('iPhone', 1);
    res.json({
      success: result.items.length > 0,
      itemCount: result.items.length,
      source: result.source,
      method: result.method,
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
  console.log('');
  console.log(`  🍪 闲鱼 Cookies: ${db.settings.xianyu_cookies ? '已设置' : '未设置'}`);
  console.log(`  🔍 自动扫描: ${db.settings.auto_scan === 'true' ? '已启用' : '已禁用'}`);
  console.log('');
});
