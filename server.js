const express = require('express');
const app = express();

app.use(express.json());

// ===== CONFIG =====
const SB_URL = process.env.SB_URL || 'https://esfnjnxhbfenziudrhqj.supabase.co';
const SB_KEY = process.env.SB_KEY || '';
const PORT = process.env.PORT || 3000;

// ===== VALIDATION CACHE (evita consumir crédito a cada ativação) =====
const validationCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function getCached(apiKey) {
  const entry = validationCache.get(apiKey);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    validationCache.delete(apiKey);
    return null;
  }
  return entry.result;
}

function setCache(apiKey, result) {
  validationCache.set(apiKey, { result, time: Date.now() });
  // Limpar entradas antigas (máx 1000)
  if (validationCache.size > 1000) {
    const oldest = validationCache.keys().next().value;
    validationCache.delete(oldest);
  }
}

// ===== CORS =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nexus-auth-proxy' });
});

// ===== HELPER: Chamar Edge Function =====
async function callEdgeFunction(path, body) {
  const response = await fetch(SB_URL + '/functions/v1/' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || 'Resposta inválida' }; }

  return { statusCode: response.status, data, ok: response.ok };
}

// ===== AUTH PROXY =====
app.post('/webhook/nexus-auth-proxy', async (req, res) => {
  const { action, api_key, amount } = req.body || {};

  if (!action) {
    return res.status(400).json({ statusCode: 400, data: { error: 'Missing action' }, ok: false });
  }
  if (!api_key) {
    return res.status(400).json({ statusCode: 400, data: { error: 'Missing api_key' }, ok: false });
  }

  try {
    // ===== VALIDATE LICENSE (sem consumir créditos se possível) =====
    if (action === 'validate_license') {
      // 1. Checar cache primeiro
      const cached = getCached(api_key);
      if (cached) {
        return res.status(cached.statusCode).json(cached);
      }

      // 2. Tentar Edge Function validate-key (read-only, ideal)
      try {
        const valResult = await callEdgeFunction('validate-key', { api_key });
        if (valResult.statusCode !== 404) {
          // validate-key existe e respondeu
          setCache(api_key, valResult);
          return res.status(valResult.statusCode).json(valResult);
        }
      } catch { /* validate-key ainda não existe, fallback */ }

      // 3. Fallback: use-credits com amount=0 (NOTA: a edge function atual consome 1 crédito)
      const result = await callEdgeFunction('use-credits', { api_key, amount: 0 });
      setCache(api_key, result);
      return res.status(result.statusCode).json(result);
    }

    // ===== USE CREDITS =====
    if (action === 'use_credits') {
      const creditAmount = parseFloat(amount) || 0;
      if (creditAmount <= 0) {
        return res.status(400).json({ statusCode: 400, data: { error: 'Amount deve ser > 0' }, ok: false });
      }
      const result = await callEdgeFunction('use-credits', { api_key, amount: creditAmount });

      // Atualizar cache com novos créditos
      if (result.ok) {
        setCache(api_key, { statusCode: 200, data: { success: true, remaining: result.data.remaining }, ok: true });
      }

      return res.status(result.statusCode).json(result);
    }

    return res.status(400).json({ statusCode: 400, data: { error: 'Invalid action' }, ok: false });
  } catch (err) {
    console.error('[nexus-auth-proxy] Error:', err.message);
    return res.status(502).json({ statusCode: 502, data: { error: 'Erro de conexão com Supabase' }, ok: false });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[nexus-auth-proxy] Running on port ${PORT}`);
});
