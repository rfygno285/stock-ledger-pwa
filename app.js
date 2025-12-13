// StockLedger PWA (browser) - v1
// Data is stored locally per-device (localStorage).
const STORAGE_KEY = "stockledger_v1";

// Backup reminder (B plan)
const LAST_BACKUP_KEY = "stockledger_lastBackupAt_v1";
const BACKUP_REMIND_DAYS = 3; // remind if days since last export >= this


// Secondary backup storage (IndexedDB) to reduce accidental resets on some browsers.
const IDB_DB = "stockledger_db_v1";
const IDB_STORE = "kv";
function idbOpen(){
  return new Promise((resolve,reject)=>{
    try{
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(IDB_STORE)){
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }catch(err){ reject(err); }
  });
}
async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve,reject)=>{
    try{
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    }catch(err){ reject(err); }
  });
}
async function idbSet(key, value){
  const db = await idbOpen();
  return new Promise((resolve,reject)=>{
    try{
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    }catch(err){ reject(err); }
  });
}

function pad2(n){ return String(n).padStart(2,"0"); }
function formatDateYYYYMMDD(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function formatTimeHHMM(d){ return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function nowTS(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}


function backupFileNameForNow(){
  const d = new Date();
  const y = d.getFullYear();
  const m = pad2(d.getMonth()+1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  return `stock-ledger_${y}${m}${day}_${hh}${mm}.json`;
}
function formatBackupTimeLabel(ms){
  if(!Number.isFinite(ms) || ms<=0) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function toNumber(v, def=0){
  const n = Number(String(v??"").replace(/,/g,"").trim());
  return Number.isFinite(n) ? n : def;
}
function fmtInt(n){ return Math.round(toNumber(n,0)).toLocaleString("en-US"); }
function fmtNum(n, digits=2){
  const x = toNumber(n,0);
  return x.toLocaleString("en-US",{minimumFractionDigits:digits, maximumFractionDigits:digits});
}
function fmtMoney(n, currency){
  const x = toNumber(n,0);
  const sign = x<0 ? "-" : "";
  const abs = Math.abs(x);
  const s = abs.toLocaleString("en-US",{minimumFractionDigits:2, maximumFractionDigits:2});
  return `${sign}${s} ${currency||""}`.trim();
}
function normalizeMarket(m){
  const s = String(m||"").trim().toUpperCase();
  return (s==="TW"||s==="US") ? s : null;
}
function normalizeSymbol(m, s){
  const t = String(s||"").trim();
  return (m==="US") ? t.toUpperCase() : t;
}
function marketToCurrency(m){ return m==="TW" ? "TWD" : "USD"; }
function uuid(){
  return (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
function defaultLedger(){ return {version:1, lots:[]}; }

function loadLedger(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const obj = JSON.parse(raw);
      obj.lots = Array.isArray(obj.lots) ? obj.lots : [];
      return obj;
    }

    // scan legacy keys (same browser) to avoid "version changed → looks empty"
    let best = null;
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(!k) continue;
      if(k===STORAGE_KEY) continue;
      if(!/^stockledger/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if(!v) continue;
      try{
        const o = JSON.parse(v);
        const lots = Array.isArray(o?.lots) ? o.lots : [];
        if(lots.length>0 && (!best || lots.length>best.lots.length)){
          best = {k, obj:{...o, lots}};
        }
      }catch(_){}
    }
    if(best){
      // migrate once
      try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(best.obj)); }catch(_){}
      return best.obj;
    }

    return defaultLedger();
  }catch(_){
    return defaultLedger();
  }
}
function saveLedger(ledger){
  try{
    ledger.lastSaved = nowTS();
  }catch(_){}
  const raw = JSON.stringify(ledger);
  localStorage.setItem(STORAGE_KEY, raw);
  // fire-and-forget backup
  try{ idbSet(STORAGE_KEY, raw); }catch(_){}
}

function keyOf(market, symbol){ return `${market}|${symbol}`; }

function computeHoldings(ledger){
  // Aggregate per key using avg-cost rule
  const map = {};
  const lots = ledger.lots.slice().sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
  for(const r of lots){
    const market = r.market;
    const symbol = r.symbol;
    const key = keyOf(market,symbol);
    if(!map[key]) map[key] = {market, symbol, currency: marketToCurrency(market), qty:0, avg:0, realized:0};
    const pos = map[key];
    const q = toNumber(r.qty,0);
    const px = toNumber(r.price,0);
    const fee = toNumber(r.fee,0);
    if(r.type==="BUY"){
      const totalCost = pos.qty*pos.avg + q*px + fee;
      pos.qty += q;
      pos.avg = pos.qty>0 ? totalCost/pos.qty : 0;
    }else if(r.type==="SELL"){
      const proceeds = q*px - fee;
      const costBasis = q*pos.avg;
      pos.realized += (proceeds - costBasis);
      pos.qty -= q;
      if(pos.qty<=0){ pos.qty=0; pos.avg=0; }
    }
  }
  return Object.values(map).filter(p=>p.qty>0 || Math.abs(p.realized)>0.000001);
}

function buildLogForOne(ledger, market, symbol){
  const rows = ledger.lots
    .filter(x => x && x.market===market && x.symbol===symbol)
    .slice()
    .sort((a,b)=> String(a.timestamp).localeCompare(String(b.timestamp)));

  let holdingQty = 0;
  let avgCost = 0;
  let realizedPnl = 0;

  const timeline = [];
  for(const r of rows){
    const side = r.type;
    const q = toNumber(r.qty,0);
    const px = toNumber(r.price,0);
    const fee = toNumber(r.fee,0);
    if(side==="BUY"){
      const totalCost = holdingQty*avgCost + q*px + fee;
      holdingQty += q;
      avgCost = holdingQty>0 ? totalCost/holdingQty : 0;
    }else if(side==="SELL"){
      const proceeds = q*px - fee;
      const costBasis = q*avgCost;
      realizedPnl += (proceeds - costBasis);
      holdingQty -= q;
      if(holdingQty<=0){ holdingQty=0; avgCost=0; }
    }
    timeline.push({
      idx: timeline.length+1,
      id: r.id || null,
      ts: String(r.timestamp||""),
      side,
      q,
      px,
      avg: avgCost,
      afterQty: holdingQty,
      fee: fee
    });
  }
  return {currency: marketToCurrency(market), holdingQty, avgCost, realizedPnl, rows: timeline};
}

function buildChartData(log){
  const x = log.rows.map(r=>r.idx);
  const price = log.rows.map(r=>r.px);
  const avg = log.rows.map(r=>r.avg);
  const x2 = log.rows.map(r=>r.afterQty);
  const points = log.rows.map(r=>{
    const date = String(r.ts||"").slice(0,10);
    const side = r.side==="BUY" ? "B" : "S";
    const qtySigned = r.side==="BUY" ? `+${fmtInt(r.q)}` : `-${fmtInt(r.q)}`;
    const line2 = `${side} @${fmtNum(r.px,2)}｜${qtySigned}`;
    return {date, line2};
  });
  return {x, price, avg, x2, points};
}

function buildCsvForOne(log){
  const header = ["idx","date","side","qty","price","fee","afterQty","avgCostAfter"].join(",");
  const lines = log.rows.map(r => [
    r.idx,
    String(r.ts||"").replace(/,/g," "),
    r.side,
    r.q,
    r.px,
    (r.fee ?? 0),
    r.afterQty,
    r.avg
  ].join(","));
  return [header, ...lines].join("\n");
}

function downloadText(filename, text, mime="text/plain"){
  const blob = new Blob([text], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseTimestamp(dateStr, timeStr){
  const d = String(dateStr||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = String(timeStr||"").trim();
  const time = t ? ( /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : ( /^\d{2}:\d{2}:\d{2}$/.test(t) ? t : null) ) : "00:00:00";
  if(time===null) return null;
  return `${d} ${time}`;
}


// ---------------- CSV import (external trades) ----------------
// CSV columns (header-based) supported:
// market, symbol, side, date, time, qty, price, fee
// - time can be blank -> default 09:00 (per user)
// - fee can be blank
function detectCsvDelimiter(line){
  const candidates = [",",";","\t"];
  let best = ","; let bestCount = -1;
  for(const d of candidates){
    const c = (line.split(d).length-1);
    if(c>bestCount){ bestCount=c; best=d; }
  }
  return best;
}

// Robust-ish CSV parser (handles quotes)
function parseCsv(text){
  const s = String(text||"").replace(/\uFEFF/g,"");
  const lines = s.split(/\r?\n/).filter(l=>l.trim().length>0);
  if(lines.length===0) return {rows:[], header:null};
  const delim = detectCsvDelimiter(lines[0]);

  const rows = [];
  for(const line of lines){
    const out = [];
    let cur = "";
    let inQ = false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(inQ){
        if(ch === '"'){
          const next = line[i+1];
          if(next === '"'){ cur += '"'; i++; }
          else{ inQ = false; }
        }else{
          cur += ch;
        }
      }else{
        if(ch === '"'){ inQ = true; }
        else if(ch === delim){
          out.push(cur);
          cur = "";
        }else{
          cur += ch;
        }
      }
    }
    out.push(cur);
    rows.push(out.map(v=>String(v??"").trim()));
  }

  // detect header
  const hdr = rows[0].map(v=>String(v||"").trim());
  const hdrJoined = hdr.join("|").toLowerCase();
  const looksLikeHeader =
    /market|symbol|side|date|time|qty|price|fee/.test(hdrJoined) ||
    /市場|代號|股票|買|賣|日期|時間|數量|價格|手續費/.test(hdr.join("|"));

  if(looksLikeHeader) return {header: hdr, rows: rows.slice(1), delim};
  return {header: null, rows, delim};
}

function csvHeaderIndexMap(header){
  const map = {};
  if(!header) return map;
  const norm = header.map(h=>String(h||"").trim().toLowerCase());
  function idxOf(keys){
    for(const k of keys){
      const kk = String(k).toLowerCase();
      const i = norm.findIndex(x=>x===kk);
      if(i>=0) return i;
    }
    // allow partial match for Chinese headers
    for(let i=0;i<norm.length;i++){
      const h = norm[i];
      for(const k of keys){
        if(h.includes(String(k).toLowerCase())) return i;
      }
    }
    return -1;
  }
  map.market = idxOf(["market","市場"]);
  map.symbol = idxOf(["symbol","股票代號","代號","ticker"]);
  map.side   = idxOf(["side","買賣","買/賣","type"]);
  map.date   = idxOf(["date","日期"]);
  map.time   = idxOf(["time","時間"]);
  map.qty    = idxOf(["qty","quantity","數量","股數"]);
  map.price  = idxOf(["price","價格","單價"]);
  map.fee    = idxOf(["fee","手續費","commission"]);
  return map;
}

function normalizeCsvSide(v){
  const s = String(v||"").trim().toUpperCase();
  if(!s) return null;
  if(s==="BUY" || s==="B") return "BUY";
  if(s==="SELL" || s==="S") return "SELL";
  const zh = String(v||"").trim();
  if(zh.includes("買")) return "BUY";
  if(zh.includes("賣")) return "SELL";
  return null;
}

function normalizeCsvDate(v){
  let s = String(v||"").trim();
  if(!s) return null;
  // allow YYYY/MM/DD or YYYY.MM.DD or YYYYMMDD
  s = s.replace(/[\.\/]/g,"-");
  if(/^\d{8}$/.test(s)){
    s = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function normalizeCsvTime(v){
  let s = String(v||"").trim();
  if(!s) return "09:00";
  // allow H:MM or HH:MM or HH:MM:SS
  if(/^\d{1}:\d{2}$/.test(s)) s = "0"+s;
  if(/^\d{2}:\d{2}:\d{2}$/.test(s)) return s.slice(0,5);
  if(/^\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

function inferMarketFromSymbol(symbol){
  const s = String(symbol||"").trim();
  if(/^\d{4,6}$/.test(s)) return "TW";
  return "US";
}

function recDedupeKey(rec){
  // do NOT include id
  const fee = (rec.fee ?? 0);
  return [rec.market, rec.symbol, rec.type, rec.timestamp, rec.qty, rec.price, fee].join("|");
}

function ensureCsvImportUI(){
  // Create a CSV import control next to JSON import, without changing index.html
  const exportBtn = document.getElementById("btn_export_json");
  if(!exportBtn) return;

  const btnRow = exportBtn.parentElement;
  if(!btnRow) return;

  if(document.getElementById("file_import_csv")) return; // already added

  const label = document.createElement("label");
  label.className = "btn secondary";
  label.htmlFor = "file_import_csv";
  label.style.display = "inline-flex";
  label.style.alignItems = "center";
  label.style.gap = "8px";
  label.style.cursor = "pointer";
  label.textContent = "匯入 CSV";

  const input = document.createElement("input");
  input.id = "file_import_csv";
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.hidden = true;

  // insert before reset button if possible
  const resetBtn = document.getElementById("btn_reset");
  if(resetBtn && resetBtn.parentElement === btnRow){
    btnRow.insertBefore(label, resetBtn);
    btnRow.insertBefore(input, resetBtn);
  }else{
    btnRow.appendChild(label);
    btnRow.appendChild(input);
  }

  input.addEventListener("change", async (e)=>{
    const f = e.target.files?.[0];
    if(!f) return;
    try{
      const txt = await f.text();
      const result = importCsvIntoLedger(txt);
      alert(result.message);
      refreshHoldings();
      try{ updateHeaderStatus(); }catch(_){ }
    }catch(err){
      alert("匯入 CSV 失敗：" + (err?.message||err));
    }finally{
      e.target.value = "";
    }
  });

  // small hint line under the buttons (once)
  const hintId = "csvImportHint";
  if(!document.getElementById(hintId)){
    const p = document.createElement("div");
    p.id = hintId;
    p.style.marginTop = "10px";
    p.style.fontSize = "12px";
    p.style.color = "#666";
    p.style.lineHeight = "1.5";
    p.innerHTML = `CSV 欄位建議：market,symbol,side,date,time,qty,price,fee（time 可空白，預設 09:00；fee 可空白）`;
    // place in backup tab card if possible
    const tab = document.getElementById("tab-backup");
    const card = tab ? tab.querySelector(".card") : null;
    if(card) card.appendChild(p);
    else if(tab) tab.appendChild(p);
  }
}

function importCsvIntoLedger(csvText){
  const {header, rows} = parseCsv(csvText);
  const snapshot = JSON.stringify(ledger);
  if(rows.length===0) throw new Error("CSV 沒有資料列");

  const idxMap = csvHeaderIndexMap(header);
  const hasHeader = !!header;

  const existing = new Set((ledger?.lots||[]).map(recDedupeKey));
  let imported = 0, skipped = 0;
  const errors = [];

  function col(row, idx, fallbackIdx){
    if(idx>=0) return row[idx] ?? "";
    if(!hasHeader && Number.isFinite(fallbackIdx)) return row[fallbackIdx] ?? "";
    return "";
  }

  for(let r=0;r<rows.length;r++){
    const row = rows[r];
    if(row.every(v=>String(v||"").trim()==="")) continue;

    const marketRaw = col(row, idxMap.market, 0);
    const symbolRaw = col(row, idxMap.symbol, 1);
    const sideRaw   = col(row, idxMap.side,   2);
    const dateRaw   = col(row, idxMap.date,   3);
    const timeRaw   = col(row, idxMap.time,   4);
    const qtyRaw    = col(row, idxMap.qty,    5);
    const priceRaw  = col(row, idxMap.price,  6);
    const feeRaw    = col(row, idxMap.fee,    7);

    const symbol0 = String(symbolRaw||"").trim();
    if(!symbol0){ errors.push(`第 ${r+1} 列：缺少股票代號`); continue; }

    const market0 = String(marketRaw||"").trim() ? normalizeMarket(marketRaw) : inferMarketFromSymbol(symbol0);
    const symbol  = normalizeSymbol(market0, symbol0);

    const side = normalizeCsvSide(sideRaw);
    if(!side){ errors.push(`第 ${r+1} 列：買/賣(side) 需為 BUY/SELL 或含 買/賣`); continue; }

    const date = normalizeCsvDate(dateRaw);
    if(!date){ errors.push(`第 ${r+1} 列：日期(date) 格式需為 YYYY-MM-DD`); continue; }

    const time = normalizeCsvTime(timeRaw);
    if(time===null){ errors.push(`第 ${r+1} 列：時間(time) 格式需為 HH:mm，可空白`); continue; }

    const ts = parseTimestamp(date, time);
    if(!ts){ errors.push(`第 ${r+1} 列：日期/時間無法解析`); continue; }

    const qty = toNumber(qtyRaw, NaN);
    const price = toNumber(priceRaw, NaN);
    const fee = String(feeRaw||"").trim()==="" ? 0 : toNumber(feeRaw, NaN);

    if(!Number.isFinite(qty) || qty<=0){ errors.push(`第 ${r+1} 列：數量(qty)需為正數`); continue; }
    if(!Number.isFinite(price) || price<=0){ errors.push(`第 ${r+1} 列：價格(price)需為正數`); continue; }
    if(String(feeRaw||"").trim()!=="" && (!Number.isFinite(fee) || fee<0)){ errors.push(`第 ${r+1} 列：手續費(fee)需為 0 或正數`); continue; }

    const rec = {id:uuid(), timestamp:ts, market:market0, symbol, type:side, qty, price, fee: fee||0};

    const k = recDedupeKey(rec);
    if(existing.has(k)){ skipped++; continue; }

    // Validate SELL not exceeding stock at that time by simulating for this symbol:
    // We'll append now; global validation happens when rendering/logging as well,
    // but we prevent obvious errors by checking per-row sequence after full import.
    ledger.lots.push(rec);
    existing.add(k);
    imported++;
  }

  // After adding all, sort lots by timestamp to keep stable processing
  ledger.lots.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));

  // Validate per (market,symbol) that no SELL makes holdings negative
  const invalid = findNegativeHoldings(ledger);
  if(invalid){
    // rollback to pre-import snapshot to avoid partial/incorrect imports
    try{ ledger = JSON.parse(snapshot); }catch(_){ ledger = loadLedger(); }
    saveLedger(ledger);
    throw new Error(invalid);
  }

  saveLedger(ledger);

  const msgParts = [];
  msgParts.push(`CSV 匯入完成：新增 ${imported} 筆`);
  if(skipped>0) msgParts.push(`（略過重複 ${skipped} 筆）`);
  if(errors.length>0){
    msgParts.push(`\n\n以下 ${errors.length} 筆有問題未匯入：\n` + errors.slice(0,8).join("\n") + (errors.length>8?"\n…":""));
  }
  msgParts.push(`\n\n匯入的資料之後也可以在「交易序列」點買/賣欄位進行修改。`);
  return {imported, skipped, errors, message: msgParts.join("")};
}

// find first negative holdings issue; returns a short description string or null
function findNegativeHoldings(ledgerObj){
  try{
    const recs = Array.isArray(ledgerObj?.lots) ? ledgerObj.lots.slice() : [];
    recs.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
    const map = new Map(); // key -> qty
    for(const r of recs){
      const key = keyOf(r.market, r.symbol);
      const cur = map.get(key) ?? 0;
      const q = toNumber(r.qty, 0);
      const next = (r.type==="BUY") ? (cur + q) : (cur - q);
      if(next < -1e-9){
        return `資料不合法：${r.symbol} 在 ${r.timestamp} 賣出後庫存變成負數。請檢查 CSV 是否有少了買入或日期排序不正確。`;
      }
      map.set(key, next);
    }
  }catch(_){}
  return null;
}

// ---------------- UI wiring ----------------
let ledger = loadLedger();

async function hydrateFromIDBIfNeeded(){
  try{
    // If localStorage is empty, try restore from IndexedDB backup.
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) return false;

    const idbRaw = await idbGet(STORAGE_KEY);
    if(!idbRaw) return false;

    const obj = JSON.parse(idbRaw);
    if(!obj || !Array.isArray(obj.lots) || obj.lots.length===0) return false;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    ledger = obj;
    return true;
  }catch(_){
    return false;
  }
}

let chart = null;
let lastQueryLog = null;
let lastQueryMarket = null;
let lastQuerySymbol = null;

function $(id){ return document.getElementById(id); }

function setTab(name){
  for(const sec of ["add","query","holdings","backup","about"]){
    $("tab-"+sec).hidden = (sec!==name);
  }
  document.querySelectorAll("#tabs button").forEach(b=>{
    b.classList.toggle("active", b.dataset.tab===name);
  });
}

document.querySelectorAll("#tabs button").forEach(b=>{
  b.addEventListener("click", ()=> setTab(b.dataset.tab));
});

function seedExample(){
  $("f_market").value = "TW";
  $("f_side").value = "BUY";
  $("f_symbol").value = "2330";
  const today = new Date();
  $("f_date").value = formatDateYYYYMMDD(today);
  $("f_time").value = formatTimeHHMM(new Date());
  $("f_qty").value = "100";
  $("f_price").value = "586";
  $("f_fee").value = "20";
}

function addTrade(){
  const market = normalizeMarket($("f_market").value);
  const side = $("f_side").value;
  const symbol = normalizeSymbol(market, $("f_symbol").value);
  const ts = parseTimestamp($("f_date").value, $("f_time").value);
  const qty = toNumber($("f_qty").value, NaN);
  const price = toNumber($("f_price").value, NaN);
  const fee = toNumber($("f_fee").value||0, 0);

  if(!market){ alert("市場錯誤"); return; }
  if(!symbol){ alert("請輸入股票代號"); return; }
  if(!ts){ alert("日期格式請用 YYYY-MM-DD，時間可留空或用 HH:mm"); return; }
  if(!Number.isFinite(qty) || qty<=0){ alert("數量需為正數"); return; }
  if(!Number.isFinite(price) || price<=0){ alert("價格需為正數"); return; }

  // ✅ SELL 防呆：不能賣超過庫存
  if(side==="SELL"){
    const curLog = buildLogForOne(ledger, market, symbol);
    const curQty = toNumber(curLog?.holdingQty, 0);
    if(qty > curQty){
      alert(`庫存只有 ${fmtInt(curQty)} 股，不能賣出 ${fmtInt(qty)} 股`);
      return;
    }
  }

  const rec = {id:uuid(), timestamp:ts, market, symbol, type:side, qty, price, fee};
  ledger.lots.push(rec);
  saveLedger(ledger);

  // quick feedback: show holding after this symbol
  const log = buildLogForOne(ledger, market, symbol);
  const cur = log.currency;
  alert(`已新增：${symbol} ${side==="BUY"?"買":"賣"}\n` +
        `交易後庫存：${fmtInt(log.holdingQty)}\n` +
        `平均成本：${fmtMoney(log.avgCost, cur)}`);

  refreshHoldings();
  try{ updateHeaderStatus(); }catch(_){ }

  // convenience: after adding, set time to now
  try{ $("f_time").value = formatTimeHHMM(new Date()); }catch(_){ }
}

function renderHoldings(){
  const tbody = $("holdings_table").querySelector("tbody");
  tbody.innerHTML = "";
  const rows = computeHoldings(ledger).sort((a,b)=>a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));
  if(rows.length===0){
    const tr=document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="hint">目前沒有資料</td>`;
    tbody.appendChild(tr);
    return;
  }
  for(const p of rows){
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${p.market}</td>
      <td>${p.symbol}</td>
      <td>${fmtInt(p.qty)}</td>
      <td>${fmtMoney(p.avg, p.currency)}</td>
      <td>${fmtMoney(p.realized, p.currency)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderQuery(market, symbol){
  const log = buildLogForOne(ledger, market, symbol);
  lastQueryLog = log;
  lastQueryMarket = market;
  lastQuerySymbol = symbol;

  $("report_card").hidden = false;
  $("table_card").hidden = false;
  $("chart_card").hidden = false;

  const cur = log.currency;
  $("report_summary").innerHTML = `
    <div><b>${market}｜${symbol}</b></div>
    <div>目前庫存：<b>${fmtInt(log.holdingQty)}</b></div>
    <div>平均成本：<b>${fmtMoney(log.avgCost, cur)}</b></div>
    <div>已實現損益：<b>${fmtMoney(log.realizedPnl, cur)}</b></div>
  `;

  // table
  const tbody = $("log_table").querySelector("tbody");
  if(!tbody._delBound){
    tbody._delBound = true;
    tbody.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-del]");
      if(btn){
        deleteTradeById(btn.getAttribute("data-del"));
        return;
      }
      // 點「買/賣」欄位：顯示該筆原始輸入（含手續費），並可快速修改手續費
      const td = e.target.closest("td");
      const tr = e.target.closest("tr");
      if(!td || !tr) return;
      if(td.cellIndex === 2){ // 第3欄：買/賣
        const id = tr.dataset.id || "";
        if(id) showTradeDetails(id);
      }
    });
  }
  tbody.innerHTML = "";
  if(log.rows.length===0){
    const tr=document.createElement("tr");
    tr.innerHTML = `<td colspan="7" class="hint">找不到交易紀錄</td>`;
    tbody.appendChild(tr);
  }else{
    for(const r of log.rows){
      const tr=document.createElement("tr");
      if(r.id) tr.dataset.id = String(r.id);
      const pill = r.side==="BUY" ? `<span class="pill buy">買</span>` : `<span class="pill sell">賣</span>`;
      tr.innerHTML = `
        <td>${r.idx}</td>
        <td>${String(r.ts).slice(0,10)}</td>
        <td>${pill}</td>
        <td>${fmtInt(r.q)}</td>
        <td>${fmtNum(r.px,2)}</td>
        <td><b>${fmtInt(r.afterQty)}</b></td>
        <td>${fmtMoney(r.avg, cur)}<div style="margin-top:6px;"><button type="button" data-del="${r.id||""}" style="padding:6px 10px;border:1px solid #ff3b30;background:#fff;color:#ff3b30;border-radius:10px;font-size:12px;">刪除</button></div></td>
      `;
      tbody.appendChild(tr);
    }
  }

  // chart
  const cd = buildChartData(log);
  const ctx = document.getElementById("chart1").getContext("2d");
  if(chart){ chart.destroy(); }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: cd.x,
      datasets: [
        { label: "成交價", data: cd.price, tension: 0.25 },
        { label: "平均成本", data: cd.avg, tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items)=>{
              const i = items?.[0]?.dataIndex ?? 0;
              const p = cd.points[i] || {date:"", line2:""};
              return [`#${cd.x[i]}  ${p.date}`, p.line2, `庫存：${fmtInt(cd.x2[i]??0)}`];
            }
          }
        },
        legend: { display: true }
      },
      scales: {
        x: {
          ticks: {
            callback: (value, index) => {
              // two-line labels: idx + holding qty
              const idx = cd.x[index];
              const q = cd.x2[index] ?? 0;
              return [String(idx), `庫存 ${fmtInt(q)}`];
            }
          }
        }
      }
    }
  });
}

function refreshHoldings(){
  ledger = loadLedger();
  renderHoldings();
  try{ updateHeaderStatus(); }catch(_){ }
}


$("btn_seed").addEventListener("click", seedExample);
$("btn_add").addEventListener("click", addTrade);
$("btn_refresh_holdings").addEventListener("click", refreshHoldings);

$("btn_query").addEventListener("click", ()=>{
  const market = normalizeMarket($("q_market").value);
  const symbol = normalizeSymbol(market, $("q_symbol").value);
  if(!symbol){ alert("請輸入股票代號"); return; }
  renderQuery(market, symbol);
});

$("btn_export_csv").addEventListener("click", ()=>{
  if(!lastQueryLog){ alert("請先查詢"); return; }
  const csv = buildCsvForOne(lastQueryLog);
  const name = `stockledger_${$("q_market").value}_${$("q_symbol").value}_${nowTS().replace(/[: ]/g,"-")}.csv`;
  downloadText(name, csv, "text/csv;charset=utf-8");
});

$("btn_export_json").addEventListener("click", ()=>{
  const led = loadLedger();
  const name = backupFileNameForNow();
  downloadText(name, JSON.stringify(led, null, 2), "application/json");

  // mark last backup time (best-effort; iOS download is user-controlled)
  try{ localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); }catch(_){}
  try{ updateHeaderStatus(); }catch(_){}
  try{ renderBackupInfo(); }catch(_){}
});

$("file_import").addEventListener("change", async (e)=>{
  const f = e.target.files?.[0];
  if(!f) return;
  try{
    const txt = await f.text();
    const obj = JSON.parse(txt);
    if(!obj || !Array.isArray(obj.lots)) throw new Error("格式不正確");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({version:1, lots: obj.lots}));
    ledger = loadLedger();
    alert("匯入完成");
    refreshHoldings();
  }catch(err){
    alert("匯入失敗：" + (err?.message||err));
  }finally{
    e.target.value = "";
  }
});

$("btn_reset").addEventListener("click", ()=>{
  if(confirm("確定要清空全部資料嗎？這個動作無法復原。")){
    localStorage.removeItem(STORAGE_KEY);
    try{ localStorage.removeItem(LAST_BACKUP_KEY); }catch(_){ }
    ledger = loadLedger();
    lastQueryLog = null;
    alert("已清空");
    refreshHoldings();
  }
});

// init
seedExample();
refreshHoldings();


function setDefaultDateTime(){
  const d = new Date();
  const dateEl = $("f_date");
  const timeEl = $("f_time");
  if(dateEl && !String(dateEl.value||"").trim()) dateEl.value = formatDateYYYYMMDD(d);
  if(timeEl && !String(timeEl.value||"").trim()) timeEl.value = formatTimeHHMM(d);
}



function showTradeDetails(id){
  // Full editor (B): edit datetime/qty/price/fee without adding extra table columns.
  const tid = String(id||"").trim();
  if(!tid) return;

  const idx = ledger.lots.findIndex(x => x && String(x.id)===tid);
  if(idx<0){ alert("找不到這筆交易（可能已刪除或未同步）"); return; }

  const r = ledger.lots[idx];
  const ui = getOrCreateTradeEditor();

  // fill
  ui.meta.textContent = `${r.market||""} ${r.symbol||""}｜${r.type==="BUY"?"買進":"賣出"}`;
  const ts = String(r.timestamp||"");
  ui.date.value = ts.slice(0,10);
  ui.time.value = ts.length>=16 ? ts.slice(11,16) : "";
  ui.qty.value  = r.qty ?? "";
  ui.price.value= r.price ?? "";
  ui.fee.value  = (r.fee ?? 0);

  ui.hint.textContent = "提示：修改後會重新依時間排序計算；若造成某筆賣出超過當時庫存，將禁止儲存。";
  ui.open();

  // wire one-shot handlers
  ui.onCancel = ()=> ui.close();

  ui.onDelete = ()=>{
    ui.close();
    deleteTradeById(tid);
  };

  ui.onSave = ()=>{
    // read inputs
    const nextDate = String(ui.date.value||"").trim();
    const nextTime = String(ui.time.value||"").trim();
    const nextTs = parseTimestamp(nextDate, nextTime);
    const nextQty = toNumber(ui.qty.value, NaN);
    const nextPrice = toNumber(ui.price.value, NaN);
    const nextFee = String(ui.fee.value||"").trim()==="" ? 0 : toNumber(ui.fee.value, NaN);

    if(!nextTs){ alert("日期/時間格式不正確"); return; }
    if(!Number.isFinite(nextQty) || nextQty<=0){ alert("數量需為正數"); return; }
    if(!Number.isFinite(nextPrice) || nextPrice<=0){ alert("價格需為正數"); return; }
    if(Number.isNaN(nextFee) || nextFee<0){ alert("手續費需為 0 或正數"); return; }

    // apply to a clone first for validation
    const nextLedger = loadLedger(); // reload latest to avoid stale edits
    const j = nextLedger.lots.findIndex(x => x && String(x.id)===tid);
    if(j<0){ alert("儲存失敗：此筆交易已不存在"); return; }

    const rr = nextLedger.lots[j];
    rr.timestamp = nextTs;
    rr.qty = nextQty;
    rr.price = nextPrice;
    rr.fee = nextFee;
    nextLedger.lots[j] = rr;

    // validate: no sell beyond holdings for this key after resort
    const market = rr.market;
    const symbol = rr.symbol;
    const v = validateNoOversell(nextLedger, market, symbol);
    if(!v.ok){
      alert(v.msg || "修改後會造成庫存不合法（賣出超過當時庫存）。");
      return;
    }

    // commit
    ledger = nextLedger;
    saveLedger(ledger);

    ui.close();

    // refresh current view
    if(lastQueryMarket && lastQuerySymbol &&
       normalizeMarket(lastQueryMarket)===normalizeMarket(market) &&
       normalizeSymbol(market, lastQuerySymbol)===normalizeSymbol(market, symbol)){
      renderQuery(normalizeMarket(market), normalizeSymbol(market, symbol));
    }
    refreshHoldings();
    try{ updateHeaderStatus(); }catch(_){}
    alert("已更新這筆交易");
  };
}

// --- helpers for full editor ---
function validateNoOversell(ledger, market, symbol){
  const rows = ledger.lots
    .filter(x => x && x.market===market && x.symbol===symbol)
    .slice()
    .sort((a,b)=> String(a.timestamp).localeCompare(String(b.timestamp)));

  let holdingQty = 0;
  for(const r of rows){
    const side = r.type;
    const q = toNumber(r.qty, NaN);
    if(!Number.isFinite(q) || q<=0){
      return {ok:false, msg:`發現不合法的數量：${String(r.timestamp||"").slice(0,16)}`};
    }
    if(side==="BUY"){
      holdingQty += q;
    }else if(side==="SELL"){
      if(q > holdingQty + 1e-9){
        const ts = String(r.timestamp||"").slice(0,16);
        return {ok:false, msg:`修改後會造成賣出超過當時庫存。\n時間：${ts}\n要賣：${fmtInt(q)}\n當時庫存：${fmtInt(holdingQty)}\n\n請調整日期/時間/數量，或先補上更早的買入。`};
      }
      holdingQty -= q;
    }
  }
  return {ok:true};
}

let _tradeEditor = null;
function getOrCreateTradeEditor(){
  if(_tradeEditor) return _tradeEditor;

  // inject minimal modal styles
  const st = document.createElement("style");
  st.textContent = `
  .sl-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:flex-end;justify-content:center;padding:16px;z-index:9999;}
  .sl-modal{width:min(520px,100%);background:#fff;border-radius:18px;border:1px solid rgba(0,0,0,.08);box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden;}
  .sl-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 8px;}
  .sl-title{font-weight:700;font-size:16px;}
  .sl-x{border:0;background:transparent;font-size:20px;line-height:20px;padding:8px;border-radius:10px;}
  .sl-x:active{background:rgba(0,0,0,.06);}
  .sl-meta{padding:0 14px 10px;color:#666;font-size:13px;}
  .sl-body{padding:0 14px 12px;}
  .sl-field{margin-top:10px;}
  .sl-field label{display:block;font-size:13px;color:#666;margin-bottom:6px;}
  .sl-input{width:100%;height:50px;padding:10px 12px;font-size:17px;border-radius:14px;border:1px solid #e5e5ea;box-sizing:border-box;}
  .sl-actions{display:flex;gap:10px;align-items:center;padding:12px 14px 14px;border-top:1px solid #eee;}
  .sl-btn{border:1px solid #d0d0d0;background:#fff;color:#111;border-radius:14px;padding:12px 12px;font-size:16px;}
  .sl-btn.primary{background:#007aff;color:#fff;border-color:#007aff;}
  .sl-btn.danger{background:#ff3b30;color:#fff;border-color:#ff3b30;}
  .sl-spacer{flex:1;}
  .sl-hint{padding:0 14px 12px;color:#666;font-size:12px;line-height:1.5;}
  @media (min-width:520px){ .sl-backdrop{align-items:center;} }
  `;
  document.head.appendChild(st);

  const backdrop = document.createElement("div");
  backdrop.className = "sl-backdrop";
  backdrop.style.display = "none";
  backdrop.innerHTML = `
    <div class="sl-modal" role="dialog" aria-modal="true" aria-label="編輯交易">
      <div class="sl-hd">
        <div class="sl-title">編輯交易</div>
        <button class="sl-x" type="button" aria-label="關閉">✕</button>
      </div>
      <div class="sl-meta" id="sl_meta"></div>
      <div class="sl-body">
        <div class="sl-field">
          <label>日期</label>
          <div class="ios-wrap"><input id="sl_date" type="date" class="ios-native"></div>
        </div>
        <div class="sl-field">
          <label>時間</label>
          <div class="ios-wrap"><input id="sl_time" type="time" class="ios-native"></div>
        </div>
        <div class="sl-field">
          <label>數量</label>
          <input id="sl_qty" class="sl-input" inputmode="decimal" />
        </div>
        <div class="sl-field">
          <label>價格</label>
          <input id="sl_price" class="sl-input" inputmode="decimal" />
        </div>
        <div class="sl-field">
          <label>手續費</label>
          <input id="sl_fee" class="sl-input" inputmode="decimal" />
        </div>
      </div>
      <div class="sl-hint" id="sl_hint"></div>
      <div class="sl-actions">
        <button class="sl-btn danger" type="button" id="sl_delete">刪除此筆</button>
        <div class="sl-spacer"></div>
        <button class="sl-btn" type="button" id="sl_cancel">取消</button>
        <button class="sl-btn primary" type="button" id="sl_save">儲存</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const modal = backdrop.querySelector(".sl-modal");
  const btnX = backdrop.querySelector(".sl-x");
  const btnCancel = backdrop.querySelector("#sl_cancel");
  const btnSave = backdrop.querySelector("#sl_save");
  const btnDelete = backdrop.querySelector("#sl_delete");

  const ui = {
    backdrop,
    meta: backdrop.querySelector("#sl_meta"),
    hint: backdrop.querySelector("#sl_hint"),
    date: backdrop.querySelector("#sl_date"),
    time: backdrop.querySelector("#sl_time"),
    qty: backdrop.querySelector("#sl_qty"),
    price: backdrop.querySelector("#sl_price"),
    fee: backdrop.querySelector("#sl_fee"),
    onCancel: null,
    onSave: null,
    onDelete: null,
    open(){ this.backdrop.style.display = "flex"; },
    close(){ this.backdrop.style.display = "none"; },
  };

  function closeIfNeeded(){
    if(ui.onCancel) ui.onCancel();
    else ui.close();
  }

  btnX.addEventListener("click", closeIfNeeded);
  btnCancel.addEventListener("click", closeIfNeeded);
  backdrop.addEventListener("click", (e)=>{
    if(e.target===backdrop) closeIfNeeded();
  });
  btnSave.addEventListener("click", ()=>{ if(ui.onSave) ui.onSave(); });
  btnDelete.addEventListener("click", ()=>{ if(ui.onDelete) ui.onDelete(); });

  _tradeEditor = ui;
  return ui;
}
function deleteTradeById(id){
  const tid = String(id||"").trim();
  if(!tid){ alert("刪除失敗：找不到交易 ID"); return; }
  const idx = ledger.lots.findIndex(x => x && String(x.id)===tid);
  if(idx<0){ alert("刪除失敗：此筆交易可能已不存在"); return; }
  const r = ledger.lots[idx];
  const msg = `確定要刪除這筆交易？\n${r.market||""} ${r.symbol||""} ${r.type==="BUY"?"買":"賣"}\n${String(r.timestamp||"").slice(0,16)}  數量 ${fmtInt(r.qty)}  價格 ${fmtNum(r.price,2)}`;
  if(!confirm(msg)) return;

  ledger.lots.splice(idx, 1);
  saveLedger(ledger);

  // refresh current query view if matches
  try{
    const qm = normalizeMarket($("q_market").value);
    const qs = normalizeSymbol(qm, $("q_symbol").value);
    if(qm && qs){
      renderQuery(qm, qs);
    }
  }catch(_){}
  refreshHoldings();
}

function formatTsForLabel(ts){
  // ts: "YYYY-MM-DD HH:mm:ss" → display "YYYY-MM-DD HH:mm"
  const s = String(ts||"").trim();
  if(!s) return "";
  return s.length>=16 ? s.slice(0,16) : s;
}

function getLedgerSummary(led){
  const lots = Array.isArray(led?.lots) ? led.lots : [];
  const count = lots.length;
  let lastTs = "";
  for(const r of lots){
    const t = String(r?.timestamp||"").trim();
    if(t && (!lastTs || t > lastTs)) lastTs = t; // safe because timestamp is YYYY-MM-DD HH:mm:ss
  }
  return {count, lastTs};
}

function daysSince(ms){
  if(!Number.isFinite(ms) || ms<=0) return null;
  const diff = Date.now() - ms;
  if(diff < 0) return 0;
  return Math.floor(diff / 86400000);
}

function ensureBackupBanner(){
  let banner = document.getElementById("backupBanner");
  if(banner) return banner;

  const src = document.getElementById("ledgerSource");
  if(!src || !src.parentElement) return null;

  banner = document.createElement("div");
  banner.id = "backupBanner";
  banner.style.marginTop = "6px";
  banner.style.fontSize = "13px";
  banner.style.lineHeight = "1.5";
  banner.style.color = "#666";

  // insert after ledgerSource
  src.insertAdjacentElement("afterend", banner);
  return banner;
}


let __emptyLedgerPrompted = false;

function ensureEmptyLedgerPrompt(){
  let box = document.getElementById("emptyLedgerPrompt");
  if(box) return box;

  const tab = document.getElementById("tab-backup") || document.body;
  box = document.createElement("div");
  box.id = "emptyLedgerPrompt";
  box.style.margin = "12px 0";
  box.style.padding = "12px";
  box.style.border = "1px solid #f59e0b";
  box.style.borderRadius = "12px";
  box.style.background = "#fffbeb";
  box.style.color = "#92400e";
  box.style.fontSize = "14px";
  box.style.lineHeight = "1.5";
  box.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">提示：帳本目前是空的</div>
    <div style="margin-bottom:10px;">若你剛剛清除了 Safari「網站資料」，本機帳本會被清空。你可以用先前匯出的 JSON 備份匯入。</div>
    <button id="btn_import_from_empty" style="padding:10px 12px;border-radius:12px;border:1px solid #f59e0b;background:#fff;color:#92400e;font-size:15px;">選擇備份檔匯入</button>
  `;
  if(tab.firstElementChild) tab.insertBefore(box, tab.firstElementChild);
  else tab.appendChild(box);

  const b = box.querySelector("#btn_import_from_empty");
  if(b){
    b.onclick = ()=>{
      try{ setTab("backup"); }catch(_){}
      const file = document.getElementById("file_import");
      if(file) file.click();
    };
  }
  return box;
}

function maybeAutoImportOnEmpty(count){
  if(__emptyLedgerPrompted) return;
  if(count>0) return;
  __emptyLedgerPrompted = true;
  try{ setTab("backup"); }catch(_){}
  try{ ensureEmptyLedgerPrompt(); }catch(_){}
}

function updateHeaderStatus(opts={}){
  try{ ledger = loadLedger(); }catch(_){ }
  const ua = navigator.userAgent || "";
  const isChrome = ua.includes("CriOS");
  const el = document.getElementById("ledgerSource");
  if(!el) return;

  const {count, lastTs} = getLedgerSummary(ledger);
  const base = isChrome ? "帳本來源：Chrome 本機" : "帳本來源：Safari 本機";

  if(count<=0){
    el.textContent = base + "（帳本為空）";
    try{ maybeAutoImportOnEmpty(count); }catch(_){ }
  }else{
    el.textContent = base + `（${count}筆｜最後：${formatTsForLabel(lastTs)}）`;
  }

  // Backup reminder (B)
  const banner = ensureBackupBanner();
  if(!banner) return;

  const lastBackupAt = toNumber(localStorage.getItem(LAST_BACKUP_KEY), 0);
  const d = daysSince(lastBackupAt);

  const needRemind = (d===null) || (d >= BACKUP_REMIND_DAYS);
  const lastLabel = lastBackupAt ? `（${formatBackupTimeLabel(lastBackupAt)}）` : "";
  const backupText = (d===null) ? "從未備份" : `距上次備份 ${d} 天${lastLabel}`;

  const restoredNote = opts && opts.restored ? "已從備援恢復帳本。 " : "";
  const emptyNote = (count<=0) ? "提示：帳本目前是空的。 " : "";

  // Make a small action to open backup tab
  const action = `<span style="color:${needRemind ? "#b45309" : "#666"};">備份狀態：${backupText}</span>
    <button id="btn_go_backup" style="margin-left:8px;padding:6px 10px;border-radius:10px;border:1px solid ${needRemind ? "#f59e0b" : "#d1d5db"};background:#fff;color:${needRemind ? "#b45309" : "#374151"};font-size:13px;">前往備份/匯入</button>`;

  banner.innerHTML = restoredNote + emptyNote + action;

  const btn = document.getElementById("btn_go_backup");
  if(btn){
    btn.onclick = ()=>{
      try{ setTab("backup"); }catch(_){}
    };
  }
}



// Keep header status in sync after reload / back-forward cache / switching back to tab
try{
  window.addEventListener("pageshow", ()=>{ try{ updateHeaderStatus(); }catch(_){ } });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ try{ updateHeaderStatus(); }catch(_){ } } });
}catch(_){}

// init
(async ()=>{
  let restored = false;
  try{ restored = await hydrateFromIDBIfNeeded(); }catch(_){ }
  try{ setDefaultDateTime(); }catch(_){ }
  try{ refreshHoldings(); }catch(_){ }
  try{ updateHeaderStatus({restored}); }catch(_){ }
  try{ ensureCsvImportUI(); }catch(_){ }
  try{ renderBackupInfo(); }catch(_){ }
})();
