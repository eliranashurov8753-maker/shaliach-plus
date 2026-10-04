/*
 * שליח + — שרת האפליקציה
 * - מגיש את האפליקציה מהתיקייה public
 * - שומר הזמנות, פרופילים וחנות בקובץ db.json
 * - השליח מקבל רק את הרווח שלו (courierEarn) — מחיר המשלוח המלא לא נשלח אליו
 * ללא ספריות חיצוניות: Node.js בלבד.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// האפליקציה נמצאת בתיקייה public. אם התיקייה לא הועלתה ו-index.html נמצא ליד server.js — משתמשים בו משם.
function findPublic() {
  const cands = [path.join(__dirname, 'public'), __dirname, path.join(__dirname, 'shaliach-plus', 'public')];
  for (const d of cands) if (fs.existsSync(path.join(d, 'index.html'))) return d;
  return path.join(__dirname, 'public');
}
const PUBLIC = findPublic();
const SAFE_EXT = ['.html', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webmanifest', '.css'];
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

/* ---------- מסד נתונים (קובץ JSON) ---------- */
let db = { orders: [], states: {}, store: null, seq: 1000 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* קובץ חדש */ }
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 200);
}

/* ---------- מודל עמלות לפי מקור ההזמנה ---------- */
// app = דרך האפליקציה מעסק עם חנות | biz = עסק שלח / דרך קישור העסק | any = שליח לכל מטרה
const r1 = x => Math.round(x * 10) / 10;
function goodsOf(o) { return (o.items || []).reduce((s, it) => s + (Number(it.p) || 0) * (Number(it.q) || 1), 0); }
function split(o) {
  const goods = goodsOf(o), fee = Number(o.fee) || 0, src = o.src || (o.type === 'free' ? 'any' : 'app');
  if (src === 'biz') return { src, platform: r1(fee * 0.11), business: r1(goods + fee * 0.05), bizReward: r1(fee * 0.05), courier: r1(fee * 0.84) };
  if (src === 'any') return { src, platform: r1(fee * 0.16), business: 0, bizReward: 0, courier: r1(fee * 0.84) };
  return { src, platform: r1(goods * 0.05 + fee * 0.16), business: r1(goods * 0.95), bizReward: 0, courier: r1(fee * 0.84) };
}

/* מה השליח רואה: בלי מחיר משלוח, בלי עמלות — רק הרווח שלו וסכום לגבייה במזומן */
function forCourier(o) {
  if (!o) return o;
  const c = Object.assign({}, o);
  c.courierEarn = r1((Number(o.fee) || 0) * 0.84);
  c.collect = o.pay === 'cash' ? goodsOf(o) + (Number(o.fee) || 0) : 0;
  delete c.fee; delete c.surcharge; delete c.split; delete c.src;
  return c;
}
function view(o, role) { return role === 'courier' ? forCourier(o) : o; }

/* ---------- עזרי HTTP ---------- */
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (PUBLIC === __dirname && !SAFE_EXT.includes(path.extname(file).toLowerCase())) p = '/index.html'; // לא חושפים את קבצי השרת
  const target = (p === '/index.html') ? path.join(PUBLIC, 'index.html') : file;
  fs.readFile(target, (err, data) => {
    if (err) {
      // כתובות כמו /s/erez-bakery — מחזירים את האפליקציה
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<div dir="rtl" style="font-family:sans-serif;padding:30px;font-size:18px">השרת עובד ✓ אבל הקובץ <b>index.html</b> לא נמצא.<br>צריך להעלות ל-GitHub את התיקייה <b>public</b> (ובתוכה index.html) — או את index.html ליד server.js.</div>');
        }
        res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

/* ---------- סטטוסים ---------- */
// 0 התקבלה · 1 אושרה · 2 בהכנה · 3 מוכנה/מחכה לשליח · 4 שליח בדרך לאיסוף · 6 נאסף · 7 נמסר
const ACTIONS = { approve: 1, prep: 2, ready: 3, accept: 4, pickup: 6, deliver: 7, cancel: 3 };

/* ---------- ניתוב ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, q = url.searchParams;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, orders: db.orders.length });

    // פרופיל / כתובות / ארנק של משתמש
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, db.states[q.get('userId') || ''] || null);
    if (p === '/api/state' && req.method === 'POST') {
      const b = await readBody(req); if (!b.userId) return send(res, 400, { error: 'userId' });
      db.states[b.userId] = b.state || {}; save(); return send(res, 200, { ok: true });
    }

    // החנות של העסק
    if (p === '/api/store' && req.method === 'GET') return send(res, 200, db.store || {});
    if (p === '/api/store' && req.method === 'POST') { const b = await readBody(req); db.store = b.store || null; save(); return send(res, 200, { ok: true }); }

    // הזמנות
    if (p === '/api/orders' && req.method === 'GET') {
      const role = q.get('role'), uid = q.get('userId'), bid = q.get('businessId');
      let list = db.orders.slice().reverse();
      if (role === 'customer') list = list.filter(o => o.customerId === uid);
      else if (role === 'business') list = list.filter(o => o.businessId && o.businessId === bid);
      else if (role === 'courier') list = list.filter(o => (o.courierId === uid) || (o.status >= 3 && o.status < 7 && !o.courierId));
      return send(res, 200, list.slice(0, 100).map(o => view(o, role)));
    }
    if (p === '/api/orders' && req.method === 'POST') {
      const b = await readBody(req);
      const role = b.role || q.get('role'); delete b.role;
      const o = Object.assign({}, b);
      o.id = String(++db.seq);
      o.createdAt = new Date().toISOString();
      o.status = typeof b.status === 'number' ? b.status : (o.type === 'store' && o.src !== 'biz' ? 0 : 3);
      o.courier = null; o.courierId = null;
      o.src = o.src || (o.type === 'free' ? 'any' : 'app');
      o.split = split(o);
      db.orders.push(o); save();
      return send(res, 200, view(o, role));
    }
    const m = p.match(/^\/api\/orders\/([^/]+)\/advance$/);
    if (m && req.method === 'POST') {
      const b = await readBody(req), role = b.role || q.get('role');
      const o = db.orders.find(x => x.id === m[1]);
      if (!o) return send(res, 404, { error: 'not found' });
      const a = b.action;
      if (!(a in ACTIONS)) return send(res, 400, { error: 'action' });
      if (a === 'accept') {
        if (o.courierId && o.courierId !== b.actorId) return send(res, 409, { error: 'already taken' });
        o.courierId = b.actorId || b.userId || 'courier'; o.courier = b.actorName || 'שליח';
      }
      if (a === 'cancel') { o.courierId = null; o.courier = null; }
      if (a === 'prep' && b.prep) o.prep = b.prep;
      o.status = ACTIONS[a];
      o.updatedAt = new Date().toISOString();
      if (a === 'deliver') o.deliveredAt = o.updatedAt;
      save();
      return send(res, 200, view(o, role));
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });

    serveStatic(req, res, p);
  } catch (e) {
    console.error(e); send(res, 500, { error: 'server error' });
  }
});
server.listen(PORT, () => console.log('שליח + פועל על פורט ' + PORT + ' · אפליקציה מ: ' + PUBLIC + (fs.existsSync(path.join(PUBLIC,'index.html')) ? ' ✓' : ' ✗ index.html חסר!')));
