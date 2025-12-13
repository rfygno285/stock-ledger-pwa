// StockLedger PWA (browser) - v1
// Data is stored locally per-device (localStorage).
const STORAGE_KEY = "stockledger_v1";

function pad2(n){ return String(n).padStart(2,"0"); }
function nowTS(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
    if(!raw) return defaultLedger();
    const obj = JSON.parse(raw);
    obj.lots = Array.isArray(obj.lots) ? obj.lots : [];
    return obj;
  }catch(_){
    return defaultLedger();
  }
}
function saveLedger(ledger){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
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
      ts: String(r.timestamp||""),
      side,
      q,
      px,
      avg: avgCost,
      afterQty: holdingQty
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
  const header = ["idx","date","side","qty","price","afterQty","avgCostAfter"].join(",");
  const lines = log.rows.map(r => [
    r.idx,
    String(r.ts||"").replace(/,/g," "),
    r.side,
    r.q,
    r.px,
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

// ---------------- UI wiring ----------------
let ledger = loadLedger();
let chart = null;
let lastQueryLog = null;

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
  const d = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}`;
  $("f_date").value = d;
  $("f_time").value = "09:30";
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
  tbody.innerHTML = "";
  if(log.rows.length===0){
    const tr=document.createElement("tr");
    tr.innerHTML = `<td colspan="7" class="hint">找不到交易紀錄</td>`;
    tbody.appendChild(tr);
  }else{
    for(const r of log.rows){
      const tr=document.createElement("tr");
      const pill = r.side==="BUY" ? `<span class="pill buy">買</span>` : `<span class="pill sell">賣</span>`;
      tr.innerHTML = `
        <td>${r.idx}</td>
        <td>${String(r.ts).slice(0,10)}</td>
        <td>${pill}</td>
        <td>${fmtInt(r.q)}</td>
        <td>${fmtNum(r.px,2)}</td>
        <td><b>${fmtInt(r.afterQty)}</b></td>
        <td>${fmtMoney(r.avg, cur)}</td>
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
  updateMeta();
  fillResetSelect();
}


function updateMeta(){
  const meta = $("holdings_meta");
  if(meta){
    const n = (ledger && Array.isArray(ledger.lots)) ? ledger.lots.length : 0;
    meta.textContent = `交易筆數：${n}（本機）`;
  }
}

function fillResetSelect(){
  const sel = $("reset_key");
  if(!sel) return;
  const keys = {};
  (ledger.lots||[]).forEach(r=>{
    if(!r || !r.market || !r.symbol) return;
    keys[`${r.market}::${r.symbol}`] = true;
  });
  const arr = Object.keys(keys).sort((a,b)=>a.localeCompare(b));
  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = arr.length ? "請選擇股票…" : "（目前沒有資料）";
  sel.appendChild(opt0);
  for(const k of arr){
    const [m,s] = k.split("::");
    const o = document.createElement("option");
    o.value = k;
    o.textContent = `${m} - ${s}`;
    sel.appendChild(o);
  }
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
  const name = `stockledger_backup_${nowTS().replace(/[: ]/g,"-")}.json`;
  downloadText(name, JSON.stringify(led, null, 2), "application/json");
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
    ledger = loadLedger();
    lastQueryLog = null;
    alert("已清空");
    refreshHoldings();
  }
});

$("btn_reset_one").addEventListener("click", ()=>{
  const sel = $("reset_key");
  if(!sel || !sel.value){ alert("請先選擇要清空的股票"); return; }
  const [market, symbol] = sel.value.split("::");
  if(!market || !symbol){ alert("選擇有誤"); return; }

  if(!confirm(`確定要清空 ${market} - ${symbol} 的所有交易紀錄？\n（買進/賣出都會刪除，其他股票不受影響）`)) return;

  ledger = loadLedger();
  const before = (ledger.lots||[]).length;
  ledger.lots = (ledger.lots||[]).filter(r => !(r && r.market===market && r.symbol===symbol));
  const after = ledger.lots.length;
  saveLedger(ledger);

  // If current query is this symbol, clear view
  try{
    if(lastQueryLog && lastQueryLog.market===market && lastQueryLog.symbol===symbol){
      lastQueryLog = null;
      const box = $("query_result"); if(box) box.innerHTML = "";
      if(chart){ chart.destroy(); chart = null; }
      const canvas = $("chart1"); if(canvas){ const ctx = canvas.getContext("2d"); ctx.clearRect(0,0,canvas.width,canvas.height); }
    }
  }catch(_){}

  refreshHoldings();
  alert(`已清空 ${market} - ${symbol}：刪除 ${before-after} 筆交易`);
});


// init
seedExample();
refreshHoldings();
