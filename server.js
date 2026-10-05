const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = 3000;
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

// ==================== 登录 ====================
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

// ==================== 闲鱼数据获取 ====================
async function fetchXianyuItems(keyword, page = 1) {
  const fetch = require('node-fetch');
  
  try {
    const url = `https://market.xianyu.com/search?q=${encodeURIComponent(keyword)}&page=${page}&pageSize=30`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    
    const response = await fetch(url, { headers, timeout: 10000, redirect: 'follow' });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const html = await response.text();
    const items = parseSearchHtml(html);
    
    if (items.length > 0) return { success: true, items, source: 'web' };
  } catch(err) {
    console.log('Web fetch failed, using demo:', err.message);
  }
  
  // 演示数据
  return { success: false, items: getDemoItems(keyword), source: 'demo' };
}

function parseSearchHtml(html) {
  const items = [];
  
  // 尝试提取 __NEXT_DATA__
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      const listings = data.props?.pageProps?.searchResult?.items || 
                       data.props?.pageProps?.result?.items || [];
      for (const item of listings) {
        if (item.itemId || item.id) {
          items.push({
            itemId: String(item.itemId || item.id),
            title: item.title || item.itemName || '',
            price: parseFloat(item.price || item.currentPrice || 0),
            location: item.location || item.city || '',
            seller: item.seller || item.nick || item.userNick || '',
            sellerCredit: item.sellerCredit || item.userCredit || '',
            imageUrl: item.imageUrl || item.picUrl || item.mainPic || '',
            detailUrl: `https://market.xianyu.com/item.htm?id=${item.itemId || item.id}`,
          });
        }
      }
    } catch(e) {}
  }
  
  // 备用：直接从HTML提取
  if (items.length === 0) {
    const itemIdRegex = /"itemId"\s*[:=]\s*"?(\d+)"?/g;
    const titleRegex = /"title"\s*:\s*"([^"]{5,100})"/g;
    const priceRegex = /"price"\s*:\s*"?([\d.]+)"?/g;
    const locationRegex = /"location"\s*:\s*"([^"]+)"/g;
    const sellerRegex = /"nick"\s*:\s*"([^"]+)"/g;
    
    let m;
    while ((m = itemIdRegex.exec(html)) !== null) {
      const itemId = m[1];
      titleRegex.lastIndex = m.index;
      priceRegex.lastIndex = m.index;
      locationRegex.lastIndex = m.index;
      sellerRegex.lastIndex = m.index;
      
      const titleMatch = titleRegex.exec(html);
      const priceMatch = priceRegex.exec(html);
      const locationMatch = locationRegex.exec(html);
      const sellerMatch = sellerRegex.exec(html);
      
      if (titleMatch && titleMatch[1].length > 5) {
        items.push({
          itemId,
          title: decode(titleMatch[1]),
          price: priceMatch ? parseFloat(priceMatch[1]) : 0,
          location: locationMatch ? locationMatch[1] : '',
          seller: sellerMatch ? sellerMatch[1] : '',
          imageUrl: '',
          detailUrl: `https://market.xianyu.com/item.htm?id=${itemId}`,
        });
      }
    }
  }
  
  return items;
}

function decode(str) {
  try { return decodeURIComponent(JSON.parse(`"${str}"`)); } catch(e) { return str; }
}

function getDemoItems(keyword) {
  return [
    {
      itemId: '7' + Date.now(),
      title: `【精选】${keyword} DJI Osmo Pocket 3 标准版 全新未拆封 国行`,
      price: 2199,
      location: '上海',
      seller: '数码精选店',
      sellerCredit: 'good',
      imageUrl: '',
      detailUrl: '#',
      isNew: true,
    },
    {
      itemId: '8' + Date.now(),
      title: `${keyword} 大疆 Action 4 运动相机 准新 带全套配件 箱说全`,
      price: 1588,
      location: '北京',
      seller: '运动相机玩家',
      sellerCredit: 'excellent',
      imageUrl: '',
      detailUrl: '#',
      isNew: true,
    },
    {
      itemId: '9' + Date.now(),
      title: `二手 ${keyword} Osmo Pocket 3 口袋云台相机 99新 带手柄`,
      price: 1850,
      location: '深圳',
      seller: '摄影师阿杰',
      sellerCredit: 'good',
      imageUrl: '',
      detailUrl: '#',
      isNew: true,
    },
  ];
}

// ==================== 扫描核心 ====================
let scanTimer = null;

async function runScan() {
  const keywords = db.keywords.filter(k => k.enabled);
  
  for (const kw of keywords) {
    try {
      const result = await fetchXianyuItems(kw.keyword, 1);
      const items = result.items || [];
      
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
        scannedAt: new Date().toISOString(),
      });
      
      if (newCount > 0) {
        console.log(`[扫描] ${kw.keyword}: 发现 ${newCount} 个新商品`);
      }
    } catch (err) {
      console.error(`[扫描错误] ${kw.keyword}:`, err.message);
    }
  }
  
  saveDB(db);
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

// 关键词
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
  
  // 排序
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
  res.json(db.settings);
});

app.put('/api/settings', verifyToken, (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    db.settings[key] = value;
  }
  saveDB(db);
  
  // 更新扫描
  if (db.settings.auto_scan === 'true' && !scanTimer) {
    startAutoScan();
  } else if (db.settings.auto_scan === 'false' && scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  
  res.json({ success: true });
});

// 即时搜索
app.get('/api/search', verifyToken, async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: '缺少搜索词' });
  try {
    const result = await fetchXianyuItems(q, parseInt(page));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
  if (db.settings.auto_scan === 'true') {
    console.log('  ✅ 自动扫描已启用');
  }
});
