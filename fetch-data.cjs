const fs = require('fs');

const protocols = [
  { name: 'Hyperliquid', slug: 'hyperliquid', token: true, logo: 'https://icons.llamao.fi/icons/protocols/hyperliquid?w=128&h=128' },
  { name: 'Aster', slug: 'aster', token: true, logo: 'https://icons.llamao.fi/icons/protocols/aster?w=128&h=128' },
  { name: 'Lighter', slug: 'lighter', token: true, logo: 'https://icons.llamao.fi/icons/protocols/lighter?w=128&h=128' },
  { name: 'Avantis', slug: 'avantis', token: true, logo: 'https://icons.llamao.fi/icons/protocols/avantis?w=128&h=128' },
  { name: 'GMX', slug: 'gmx', token: true, logo: 'https://icons.llamao.fi/icons/protocols/gmx?w=128&h=128' },
  { name: 'dYdX', slug: 'dydx', token: true, logo: 'https://icons.llamao.fi/icons/protocols/dydx?w=128&h=128' },
  { name: 'Paradex', slug: 'paradex', token: true, logo: 'https://icons.llamao.fi/icons/protocols/paradex?w=128&h=128' },
  { name: 'Variational', slug: 'variational', token: false, logo: 'https://icons.llamao.fi/icons/protocols/variational?w=128&h=128' },
  { name: 'edgeX', slug: 'edgex', token: false, logo: 'https://icons.llamao.fi/icons/protocols/edgex?w=128&h=128' },
  { name: 'Pacifica', slug: 'pacifica', token: false, logo: 'https://icons.llamao.fi/icons/protocols/pacifica?w=128&h=128' },
  { name: 'Extended', slug: 'extended', token: false, logo: 'https://icons.llamao.fi/icons/protocols/extended?w=128&h=128' },
  { name: 'StandX', slug: 'standx', token: false, logo: 'https://icons.llamao.fi/icons/protocols/standx?w=128&h=128' },
  { name: '01 Exchange', slug: '01-exchange', token: false, logo: 'https://icons.llamao.fi/icons/protocols/01-exchange?w=128&h=128' },
  { name: 'Reya', slug: 'reya', token: false, logo: 'https://icons.llamao.fi/icons/protocols/reya?w=128&h=128' },
  { name: 'Nado', slug: 'nado', token: false, logo: 'https://icons.llamao.fi/icons/protocols/nado?w=128&h=128' }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flattenValue(obj) {
  if (typeof obj === 'number') return obj;
  if (!obj || typeof obj !== 'object') return 0;
  let sum = 0;
  for (const k of Object.keys(obj)) sum += flattenValue(obj[k]);
  return sum;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return res.json();
}

async function getJsonWithRetry(url, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await getJson(url);
    } catch (e) {
      lastErr = e;
      // Free API can rate-limit aggressively; back off before retry.
      await sleep(1800 + i * 1200);
    }
  }
  throw lastErr;
}

function extractLast7Average(arr) {
  if (!Array.isArray(arr)) return null;
  const vals = arr
    .map((p) => {
      if (!Array.isArray(p) || p.length < 2) return null;
      return flattenValue(p[1]);
    })
    .filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < 3) return null;
  const last7 = vals.slice(-7);
  return last7.reduce((a, b) => a + b, 0) / last7.length;
}

async function run() {
  const out = [];
  for (const p of protocols) {
    const row = { ...p, fdv: null, avgVolume7d: null, avgOi7d: null, ratio: null, notes: [] };

    try {
      const vol = await getJsonWithRetry(`https://api.llama.fi/summary/derivatives/${p.slug}?dataType=dailyVolume`);
      row.avgVolume7d = extractLast7Average(vol.totalDataChart || vol.totalDataChartBreakdown || []);
    } catch (e) {
      row.notes.push(`volume:${e.message}`);
    }

    await sleep(1200);

    try {
      const oi = await getJsonWithRetry(`https://api.llama.fi/summary/derivatives/${p.slug}?dataType=openInterest`);
      row.avgOi7d = extractLast7Average(oi.totalDataChart || oi.totalDataChartBreakdown || []);
    } catch (e) {
      row.notes.push(`oi:${e.message}`);
    }

    await sleep(1200);

    try {
      const proto = await getJsonWithRetry(`https://api.llama.fi/protocol/${p.slug}`);
      row.fdv = Number(proto.fdv) || null;
    } catch (e) {
      row.notes.push(`fdv:${e.message}`);
    }

    out.push(row);
    await sleep(1200);
  }

  const released = out.filter((r) => r.token && Number.isFinite(r.fdv) && Number.isFinite(r.avgVolume7d) && Number.isFinite(r.avgOi7d));
  for (const r of released) r.ratio = (r.avgVolume7d + r.avgOi7d) / r.fdv;

  const ratios = released.map((r) => r.ratio).sort((a, b) => a - b);
  const medianRatio = ratios.length
    ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2)
    : null;

  for (const r of out) {
    if (!r.token && Number.isFinite(r.avgVolume7d) && Number.isFinite(r.avgOi7d) && Number.isFinite(medianRatio) && medianRatio > 0) {
      r.fdv = (r.avgVolume7d + r.avgOi7d) / medianRatio;
      r.ratio = medianRatio;
      r.notes.push('fdv-estimated-from-median-ratio');
    }
  }

  const payload = {
    asOf: new Date().toISOString(),
    method: 'ratio = (avg perp volume over last 7d + avg open interest over last 7d) / FDV',
    medianRatio,
    projects: out
  };

  fs.writeFileSync('data.json', JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ medianRatio, count: out.length }, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
