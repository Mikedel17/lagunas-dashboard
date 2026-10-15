/* ── Peso real · Liquidaciones ─────────────────────────────────────────────
   Complementa el dashboard de cosecha (index.html) con la pestaña
   Liquidaciones: peso neto real, kg por jaba, precio e ingreso.
   Depende de globals de index.html: RAW, isCompare, activeCamp, dayNum,
   fmt, TOOLTIP_STYLE, Chart.
   ───────────────────────────────────────────────────────────────────────── */
const LIQ_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQEll-BW_UewDrwyXnwNbl5qiyXSOAs5TSbs82yJltOzMy2qA_iSsMEhlVsfecD2hLzARX5SNCFcGA8/pub?gid=505628585&single=true&output=csv';
const LIQ_TOL_DAYS = 7;   // holgura al cruzar el periodo liquidado con la campaña

let LIQ = null, liqError = null, liqChart = null;

const esc  = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num  = v => { const n = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const fmt1 = n => n.toLocaleString('es-PE', {minimumFractionDigits: 1, maximumFractionDigits: 1});
const fmt2 = n => n.toLocaleString('es-PE', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtK = n => fmt(Math.round(n));

// CSV con comillas (los nombres de cliente pueden traer comas)
function csvRows(txt) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) {
      if (ch === '"') { if (txt[i+1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseLiq(txt) {
  const rows = csvRows(txt.trim());
  const head = rows[0].map(h => h.trim());
  const ix = k => head.indexOf(k);
  const need = ['Periodo', 'Fecha', 'Num Cajas', 'Peso Bruto', 'Peso Neto', 'Total Dia'];
  const missing = need.filter(k => ix(k) < 0);
  if (missing.length) throw new Error(`Liquidaciones sin columnas: ${missing.join(', ')}`);
  const get = (r, k) => ix(k) < 0 ? '' : (r[ix(k)] || '').trim();

  const recs = rows.slice(1)
    .map(r => ({
      periodo: get(r, 'Periodo'), fecha: get(r, 'Fecha'),
      cajas: num(get(r, 'Num Cajas')), bruto: num(get(r, 'Peso Bruto')),
      neto: num(get(r, 'Peso Neto')), total: num(get(r, 'Total Dia')),
      ha: num(get(r, 'Hectareas'))
    }))
    .filter(x => x.periodo && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x.fecha) && x.neto > 0)
    .map(x => ({...x, day: dayNum(x.fecha)}));

  const groups = new Map();
  recs.forEach(x => { if (!groups.has(x.periodo)) groups.set(x.periodo, []); groups.get(x.periodo).push(x); });
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const periods = [...groups.entries()].map(([label, rs]) => ({
    label, rows: rs,
    start: Math.min(...rs.map(r => r.day)), end: Math.max(...rs.map(r => r.day)),
    days: new Set(rs.map(r => r.day)).size,
    cajas: sum(rs, 'cajas'), bruto: sum(rs, 'bruto'), neto: sum(rs, 'neto'), total: sum(rs, 'total'),
    ha: Math.max(...rs.map(r => r.ha))
  })).sort((a, b) => a.start - b.start);
  return {periods};
}

async function loadLiq() {
  try {
    const res = await fetch(LIQ_URL, {cache: 'no-store'});
    if (!res.ok) throw new Error(`Liquidaciones HTTP ${res.status}`);
    LIQ = parseLiq(await res.text());
    liqError = null;
  } catch (e) {
    LIQ = null;
    liqError = e.message;
  }
  if (RAW) renderLiq();
}

/* ── cruce campaña ↔ periodo liquidado ───── */
function campEnd(c) { return dayNum(c.dates[c.dates.length - 1]); }

function matchPeriod(c) {
  if (!LIQ) return null;
  return LIQ.periods.find(p => p.start <= campEnd(c) + LIQ_TOL_DAYS && p.end >= c.start - LIQ_TOL_DAYS) || null;
}

function campJabasByDay(c) {
  const m = new Map();
  c.dates.forEach(d => m.set(dayNum(d), RAW.sorted.reduce((a, s) => a + (RAW.mat[s][d] || 0), 0)));
  return m;
}

// Rendimiento real por día = peso neto ÷ cajas liquidadas (cajas de entrega ≈ jabas).
// No depende de que la fecha de cosecha y la de entrega coincidan.
function liqByDay(p) {
  const m = new Map();
  p.rows.forEach(r => {
    const x = m.get(r.day) || {neto: 0, cajas: 0};
    m.set(r.day, {neto: x.neto + r.neto, cajas: x.cajas + r.cajas});
  });
  return m;
}

// factor kg/jaba que usa el Sheet (KG Aprox ÷ Jabas)
const sheetFactor = () => RAW.hasKg && RAW.grand ? RAW.grandK / RAW.grand : null;

/* ── render ──────────────────────────────── */
function liqKpi(label, val, sub, cls = 'nu', color = '') {
  return `<div class="kpi"><div class="kpi-label">${label}</div>
    <div class="kpi-val ${cls}"${color ? ` style="color:${color}"` : ''}>${val}</div>
    <div class="kpi-sub nu">${sub}</div></div>`;
}

function destroyLiqChart() { if (liqChart) { liqChart.destroy(); liqChart = null; } }

function renderLiq() {
  const body = document.getElementById('liqBody');
  if (!body) return;
  if (!LIQ) {
    destroyLiqChart();
    body.innerHTML = liqError ? `<p class="liq-msg">⚠ ${esc(liqError)}</p>` : `<p class="liq-msg">cargando liquidaciones…</p>`;
    return;
  }
  if (isCompare()) return renderLiqTable(body);
  const c = activeCamp(), p = matchPeriod(c);
  return p ? renderLiqCamp(body, c, p) : renderLiqProjection(body, c);
}

function renderLiqCamp(body, c, p) {
  const est = sheetFactor();
  const kgJ = p.cajas ? p.neto / p.cajas : null;
  const usdKg = p.total / p.neto;
  const prices = p.rows.map(r => r.total / r.neto);
  const diff = kgJ && est ? Math.round((est / kgJ - 1) * 100) : null;
  const taraPct = p.bruto ? Math.round((1 - p.neto / p.bruto) * 100) : 0;
  const jabas = [...campJabasByDay(c).values()].reduce((a, b) => a + b, 0);
  const gap = p.cajas - jabas;

  body.innerHTML = `
    <div class="kpi-grid">
      ${liqKpi('Peso neto liquidado', fmtK(p.neto), `kg · bruto ${fmtK(p.bruto)} · tara ${taraPct}%`, '', 'var(--teal)')}
      ${liqKpi('Kg neto por jaba', kgJ ? fmt1(kgJ) : '—',
        est && diff !== null ? `el Sheet estima ${fmt1(est)} → ${diff >= 0 ? 'sobreestima' : 'subestima'} ${Math.abs(diff)}%` : 'peso neto ÷ cajas',
        diff !== null && Math.abs(diff) > 5 ? 'dn' : 'nu')}
      ${liqKpi('Precio promedio', `$${fmt2(usdKg)}`, `USD/kg neto · rango $${fmt2(Math.min(...prices))}–$${fmt2(Math.max(...prices))}`)}
      ${liqKpi('Ingreso', `$${fmtK(p.total)}`, `USD · ${p.days} días de entrega${p.ha ? ` · ${fmtK(p.neto / p.ha)} kg/ha` : ''}`)}
    </div>
    <div class="chart-card" style="margin-top:14px">
      <div class="chart-name">Peso neto por día · kg neto por caja</div>
      <div class="chart-box"><canvas id="liqChart" role="img" aria-label="Peso neto liquidado por día y kg neto por caja"></canvas></div>
    </div>
    <p class="liq-note">periodo liquidado: ${esc(p.label)} · cajas liquidadas ${fmt(p.cajas)} vs jabas registradas ${fmt(jabas)}${gap ? ` (${gap > 0 ? '+' : ''}${fmt(gap)} ${gap > 0 ? 'sin registrar en cosecha' : 'sin liquidar'})` : ''}</p>`;

  buildLiqChart(liqByDay(p), est);
}

function buildLiqChart(byDay, est) {
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const label = d => { const dt = new Date(d * 86400000); return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; };
  const kgJ = days.map(d => { const x = byDay.get(d); return x.cajas ? +(x.neto / x.cajas).toFixed(2) : null; });
  const tick = '#67785d', grid = 'rgba(214,235,185,0.055)';
  const mono = {size: 11, family: "'Spline Sans Mono', monospace"};

  const datasets = [
    {type: 'bar', label: 'Peso neto', data: days.map(d => Math.round(byDay.get(d).neto)), yAxisID: 'y',
      backgroundColor: 'rgba(79,209,197,.55)', borderRadius: 3, order: 3},
    {type: 'line', label: 'Kg neto/caja', data: kgJ, yAxisID: 'y1', borderColor: '#a7e163', backgroundColor: '#a7e163',
      borderWidth: 2, pointRadius: 2.5, tension: 0.3, spanGaps: true, order: 1}
  ];
  if (est) datasets.push({type: 'line', label: 'Estimado Sheet', data: days.map(() => +est.toFixed(2)), yAxisID: 'y1',
    borderColor: '#f5c33b', borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, order: 2});

  destroyLiqChart();
  liqChart = new Chart(document.getElementById('liqChart'), {
    data: {labels: days.map(label), datasets},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: {mode: 'index', intersect: false},
      plugins: {
        legend: {display: true, labels: {color: '#a7b89a', font: mono, boxWidth: 12}},
        tooltip: {...TOOLTIP_STYLE, filter: i => i.parsed.y !== null,
          callbacks: {label: ctx => ` ${ctx.dataset.label}: ${ctx.dataset.yAxisID === 'y1' ? fmt1(ctx.parsed.y) + ' kg/caja' : fmt(ctx.parsed.y) + ' kg'}`}}
      },
      scales: {
        x:  {ticks: {color: tick, font: mono, maxTicksLimit: 12}, grid: {display: false}},
        y:  {position: 'left', beginAtZero: true, ticks: {color: tick, font: mono}, grid: {color: grid}, border: {display: false}},
        y1: {position: 'right', suggestedMin: 8, suggestedMax: 16, ticks: {color: '#a7e163', font: mono}, grid: {display: false}, border: {display: false}}
      }
    }
  });
}

// Campaña aún sin liquidar: proyecta con el rendimiento real más reciente
function renderLiqProjection(body, c) {
  destroyLiqChart();
  const prev = LIQ.periods.filter(p => p.start < c.start);
  const ref = prev[prev.length - 1];
  if (!ref) { body.innerHTML = `<p class="liq-msg">Aún no hay liquidaciones de ${esc(c.label)} ni campañas anteriores para proyectar.</p>`; return; }

  const kgJ = ref.neto / ref.cajas;
  const usdKg = ref.total / ref.neto;
  const jabas = [...campJabasByDay(c).values()].reduce((a, b) => a + b, 0);
  const neto = jabas * kgJ, ingreso = neto * usdKg;
  const est = sheetFactor();

  body.innerHTML = `
    <div class="kpi-grid">
      ${liqKpi('Kg neto estimado', fmtK(neto), `kg · ${fmt(jabas)} jabas × ${fmt1(kgJ)} kg reales`, '', 'var(--teal)')}
      ${liqKpi('Ingreso estimado', `$${fmtK(ingreso)}`, `USD a $${fmt2(usdKg)}/kg (precio anterior)`)}
      ${liqKpi('Kg neto por jaba', fmt1(kgJ), `real de ${esc(ref.label)}${est ? ` · Sheet usa ${fmt1(est)}` : ''}`)}
      ${liqKpi('Liquidaciones', '—', `${esc(c.label)} aún sin liquidar`)}
    </div>
    <p class="liq-note">estimación: cosecha registrada × rendimiento y precio reales de la última campaña liquidada</p>`;
}

// Modo Comparar: histórico de todas las campañas liquidadas
function renderLiqTable(body) {
  destroyLiqChart();
  const ps = LIQ.periods;
  const kgCaja = p => p.cajas ? p.neto / p.cajas : 0;
  const usdKg  = p => p.neto ? p.total / p.neto : 0;
  const kgHa   = p => p.ha ? p.neto / p.ha : 0;
  const best = fn => Math.max(...ps.map(fn));
  const b = {kc: best(kgCaja), uk: best(usdKg), kh: best(kgHa), t: best(p => p.total)};
  const hi = (v, m) => v === m ? ' class="up"' : '';

  body.innerHTML = `
    <div class="table-card" style="margin-top:0">
      <table>
        <thead><tr><th style="width:4px"></th><th>Periodo liquidado</th><th>Días</th><th>Cajas</th><th>Neto kg</th>
          <th>Kg/caja</th><th>USD/kg</th><th>Ingreso USD</th><th>Ha</th><th>Kg/ha</th></tr></thead>
        <tbody>${ps.map(p => `<tr style="cursor:default">
          <td></td><td class="sec-name">${esc(p.label)}</td>
          <td>${p.days}</td><td>${fmt(p.cajas)}</td><td>${fmtK(p.neto)}</td>
          <td${hi(kgCaja(p), b.kc)}>${fmt1(kgCaja(p))}</td>
          <td${hi(usdKg(p), b.uk)}>$${fmt2(usdKg(p))}</td>
          <td${hi(p.total, b.t)} style="font-weight:700">$${fmtK(p.total)}</td>
          <td>${p.ha ? fmt1(p.ha) : '—'}</td>
          <td${hi(kgHa(p), b.kh)}>${p.ha ? fmtK(kgHa(p)) : '—'}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="liq-note">todas las campañas liquidadas · verde = mejor valor · cajas de entrega ≈ jabas de campo</p>`;
}
