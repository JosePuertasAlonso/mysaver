// ── Cotizaciones de mercado (Yahoo Finance) ───────────────────────────────────
// Yahoo no tiene API oficial: todo pasa por aquí para poder cambiar de fuente sin
// tocar el resto. Los precios se guardan en caché en Postgres (son comunes a todos
// los usuarios) para no llamar a Yahoo en cada visita y seguir mostrando el último
// precio conocido si la fuente falla.

const YAHOO_CHART  = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH = 'https://query2.finance.yahoo.com/v1/finance/search';
const QUOTE_TTL_MS   = 15 * 60 * 1000;     // precio actual: refresco cada 15 min
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // histórico diario: refresco cada 6 h
const FETCH_TIMEOUT_MS = 8000;
const MAX_PARALLEL = 4;
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,32}$/;
const DAY_S = 86400;

const isValidSymbol = (s) => typeof s === 'string' && SYMBOL_RE.test(s);
// Yahoo envía floats de 32 bits (25.530000686645508 = 25.53): solo ~7 cifras son significativas
const roundPrice = (v) => Number(v.toPrecision(7));

// Yahoo cotiza Londres en peniques (GBp): lo pasamos a libras
function normalizeCurrency(currency) {
  if (currency === 'GBp' || currency === 'GBX') return { currency: 'GBP', factor: 0.01 };
  return { currency: currency || 'EUR', factor: 1 };
}

async function yahooJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Yahoo respondió ${res.status}`);
  return res.json();
}

async function fetchChart(symbol, params) {
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`;
  const data = await yahooJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || `Sin datos para ${symbol}`);
  return result;
}

// Ejecuta fn sobre items con un máximo de llamadas simultáneas
async function mapLimited(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += MAX_PARALLEL) {
    out.push(...await Promise.all(items.slice(i, i + MAX_PARALLEL).map(fn)));
  }
  return out;
}

function createMarket(q) {
  async function initSchema() {
    await q(`
      CREATE TABLE IF NOT EXISTS market_quotes (
        symbol      TEXT PRIMARY KEY,
        name        TEXT,
        currency    TEXT,
        exchange    TEXT,
        price       NUMERIC,
        prev_close  NUMERIC,
        market_time TIMESTAMPTZ,
        fetched_at  TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS market_history (
        symbol TEXT NOT NULL,
        fecha  DATE NOT NULL,
        close  NUMERIC NOT NULL,
        PRIMARY KEY (symbol, fecha)
      );
      CREATE TABLE IF NOT EXISTS market_history_meta (
        symbol     TEXT PRIMARY KEY,
        from_date  DATE NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL
      );
    `);
  }

  const rowToQuote = (r, stale) => r && ({
    symbol: r.symbol, name: r.name, currency: r.currency, exchange: r.exchange,
    price: r.price, prevClose: r.prev_close, marketTime: r.market_time, fetchedAt: r.fetched_at, stale,
  });

  async function refreshQuote(symbol) {
    const res = await fetchChart(symbol, { range: '5d', interval: '1d' });
    const m = res.meta;
    const { currency, factor } = normalizeCurrency(m.currency);
    const price = m.regularMarketPrice != null ? roundPrice(m.regularMarketPrice * factor) : null;
    if (price == null) throw new Error(`Sin precio para ${symbol}`);
    const prev = m.chartPreviousClose ?? m.previousClose;
    const { rows: [r] } = await q(`
      INSERT INTO market_quotes (symbol,name,currency,exchange,price,prev_close,market_time,fetched_at)
      VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),now())
      ON CONFLICT (symbol) DO UPDATE SET name=EXCLUDED.name, currency=EXCLUDED.currency, exchange=EXCLUDED.exchange,
        price=EXCLUDED.price, prev_close=EXCLUDED.prev_close, market_time=EXCLUDED.market_time, fetched_at=now()
      RETURNING *`,
      [symbol, m.longName || m.shortName || symbol, currency, m.fullExchangeName || m.exchangeName || null,
       price, prev != null ? roundPrice(prev * factor) : null, m.regularMarketTime || null]);
    return r;
  }

  // Precio actual de varios símbolos. Si Yahoo falla, devuelve el último guardado con stale=true.
  async function getQuotes(symbols) {
    const list = [...new Set(symbols.filter(isValidSymbol))];
    if (!list.length) return {};
    const { rows } = await q('SELECT * FROM market_quotes WHERE symbol = ANY($1)', [list]);
    const cached = Object.fromEntries(rows.map(r => [r.symbol, r]));
    const now = Date.now();
    const toRefresh = list.filter(s => !cached[s] || now - new Date(cached[s].fetched_at).getTime() > QUOTE_TTL_MS);

    const out = {};
    for (const s of list) if (cached[s]) out[s] = rowToQuote(cached[s], false);
    await mapLimited(toRefresh, async (s) => {
      try { out[s] = rowToQuote(await refreshQuote(s), false); }
      catch (e) {
        if (cached[s]) out[s] = rowToQuote(cached[s], true);
        else out[s] = { symbol: s, error: e.message };
      }
    });
    return out;
  }

  // Precios + tipos de cambio a EUR de las monedas que aparezcan (USDEUR=X, GBPEUR=X…)
  async function getQuotesWithFx(symbols) {
    const quotes = await getQuotes(symbols);
    const currencies = [...new Set(Object.values(quotes).map(x => x.currency).filter(c => c && c !== 'EUR'))];
    const fxQuotes = await getQuotes(currencies.map(c => `${c}EUR=X`));
    const fx = { EUR: 1 };
    for (const c of currencies) fx[c] = fxQuotes[`${c}EUR=X`]?.price ?? null;
    return { quotes, fx };
  }

  async function storeHistory(symbol, result) {
    const { factor } = normalizeCurrency(result.meta.currency);
    const offset = result.meta.gmtoffset || 0;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const fechas = [], valores = [];
    (result.timestamp || []).forEach((t, i) => {
      if (closes[i] == null) return;
      fechas.push(new Date((t + offset) * 1000).toISOString().slice(0, 10));
      valores.push(roundPrice(closes[i] * factor));
    });
    if (!fechas.length) return;
    await q(`
      INSERT INTO market_history (symbol, fecha, close)
      SELECT $1, f, c FROM unnest($2::date[], $3::numeric[]) AS t(f, c)
      ON CONFLICT (symbol, fecha) DO UPDATE SET close = EXCLUDED.close`,
      [symbol, fechas, valores]);
  }

  // Cierres diarios desde `desde` (YYYY-MM-DD). Descarga lo que falte y reutiliza el resto.
  async function getHistory(symbol, desde) {
    const { rows: [meta] } = await q(
      'SELECT from_date::text AS from_date, fetched_at FROM market_history_meta WHERE symbol=$1', [symbol]);
    let fetchFrom = null;
    if (!meta || desde < meta.from_date) fetchFrom = desde;
    else if (Date.now() - new Date(meta.fetched_at).getTime() > HISTORY_TTL_MS) {
      const { rows: [last] } = await q('SELECT max(fecha)::text AS f FROM market_history WHERE symbol=$1', [symbol]);
      fetchFrom = last.f || desde;
    }

    let stale = false;
    if (fetchFrom) {
      try {
        const period1 = Math.floor(Date.parse(`${fetchFrom}T00:00:00Z`) / 1000) - 7 * DAY_S;
        const result = await fetchChart(symbol, { period1, period2: Math.floor(Date.now() / 1000), interval: '1d' });
        await storeHistory(symbol, result);
        const from = meta && meta.from_date < desde ? meta.from_date : desde;
        await q(`
          INSERT INTO market_history_meta (symbol, from_date, fetched_at) VALUES ($1, $2, now())
          ON CONFLICT (symbol) DO UPDATE SET from_date = LEAST(market_history_meta.from_date, EXCLUDED.from_date), fetched_at = now()`,
          [symbol, from]);
      } catch (e) {
        if (!meta) throw e;
        stale = true;
      }
    }
    const { rows } = await q(
      'SELECT fecha::text AS fecha, close FROM market_history WHERE symbol=$1 AND fecha >= $2 ORDER BY fecha',
      [symbol, desde]);
    return { symbol, stale, points: rows };
  }

  async function search(query) {
    const url = `${YAHOO_SEARCH}?${new URLSearchParams({ q: query, quotesCount: '8', newsCount: '0' })}`;
    const data = await yahooJson(url);
    return (data.quotes || [])
      .filter(x => x.symbol && isValidSymbol(x.symbol))
      .map(x => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.typeDisp || x.quoteType || '',
      }));
  }

  return { initSchema, getQuotesWithFx, getHistory, search };
}

module.exports = { createMarket, isValidSymbol };
