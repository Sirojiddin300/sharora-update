import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent shared state file so all browsers/accounts/visitors see identical admin settings & CRM data
const DATA_DIR = path.join(__dirname, '.data');
const SHARED_STATE_FILE = path.join(DATA_DIR, 'shared-state.json');

interface SharedAppState {
  settings?: any;
  documents?: any[];
  supabaseConfig?: { url: string; anonKey: string };
  updatedAt?: string;
}

function readSharedState(): SharedAppState {
  try {
    if (fs.existsSync(SHARED_STATE_FILE)) {
      const raw = fs.readFileSync(SHARED_STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('Could not read shared state file:', err);
  }
  return {};
}

function writeSharedState(partial: Partial<SharedAppState>): SharedAppState {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const current = readSharedState();
    const next: SharedAppState = {
      ...current,
      ...partial,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SHARED_STATE_FILE, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  } catch (err) {
    console.warn('Could not write shared state file:', err);
    return partial;
  }
}

// In-memory queue/store for incoming real-time CRM Webhook events
interface CrmWebhookEvent {
  id: string;
  receivedAt: string;
  payload: any;
}

const webhookEvents: CrmWebhookEvent[] = [];

function isBlockedInternalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '0.0.0.0' ||
    lower === '::1' ||
    lower === '169.254.169.254' ||
    lower.endsWith('.internal') ||
    lower.startsWith('10.') ||
    lower.startsWith('192.168.')
  ) {
    return true;
  }
  return false;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '15mb' }));

  // 0. Global Shared State API so all visitors/accounts/devices get the exact same Admin & CRM data
  // (strips supabaseConfig so credentials are never exposed in network inspection)
  app.get('/api/shared-state', (_req, res) => {
    const state = readSharedState();
    const { supabaseConfig: _hidden, ...publicState } = state;
    return res.json({ ok: true, ...publicState });
  });

  app.post('/api/shared-state', (req, res) => {
    try {
      const { settings, documents, supabaseConfig } = req.body || {};
      const patch: Partial<SharedAppState> = {};
      if (settings && typeof settings === 'object') {
        patch.settings = settings;
      }
      if (Array.isArray(documents)) {
        patch.documents = documents;
      }
      if (supabaseConfig && typeof supabaseConfig === 'object') {
        patch.supabaseConfig = supabaseConfig;
      }
      const saved = writeSharedState(patch);
      return res.json({ ok: true, updatedAt: saved.updatedAt });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || 'Failed to save shared state' });
    }
  });

  // 1. Server-side CORS-free proxy to fetch blocks, floors, and apartments from external CRM / Sales app
  app.post('/api/crm/proxy-fetch', async (req, res) => {
    try {
      const { apiUrl, apiKey } = req.body || {};
      if (!apiUrl || typeof apiUrl !== 'string') {
        return res.status(400).json({ error: 'Суроғаи API (apiUrl) ворид нашудааст.' });
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(apiUrl.trim());
      } catch {
        return res.status(400).json({ error: 'Формати суроғаи API нодуруст аст.' });
      }

      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return res.status(400).json({ error: 'Танҳо протоколҳои HTTP/HTTPS иҷозат дода шудаанд.' });
      }

      if (isBlockedInternalHost(parsedUrl.hostname)) {
        return res.status(403).json({ error: 'Пайвастшавӣ ба суроғаҳои дохилӣ манъ аст.' });
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };

      if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
        const cleanKey = apiKey.trim();
        headers['Authorization'] = cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`;
        headers['apikey'] = cleanKey;
        headers['x-api-key'] = cleanKey;
      }

      const response = await fetch(parsedUrl.toString(), {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return res.status(response.status).json({
          error: `Сервери берунӣ хатогӣ баргардонд (${response.status}): ${text.slice(0, 200)}`,
        });
      }

      const data = await response.json();
      return res.json({ ok: true, data });
    } catch (err: any) {
      return res.status(500).json({
        error: `Хатогии пайвастшавӣ ба барномаи берунӣ: ${err?.message || 'Номаълум'}`,
      });
    }
  });

  // 2. Incoming Webhook endpoint so external Sales/CRM app can push sales, installments, blocks, floors, or apartments
  app.post('/api/crm/webhook', (req, res) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Payload must be a JSON object or array' });
      }

      const evt: CrmWebhookEvent = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: new Date().toISOString(),
        payload,
      };
      webhookEvents.push(evt);
      if (webhookEvents.length > 50) {
        webhookEvents.shift();
      }

      return res.json({
        ok: true,
        eventId: evt.id,
        receivedAt: evt.receivedAt,
        message: 'Маълумоти фурӯш / рассрочка / шахматка қабул шуд.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Webhook error' });
    }
  });

  // 3. Poll incoming webhook events from frontend
  app.get('/api/crm/webhook-events', (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : '';
    const events = since
      ? webhookEvents.filter((e) => e.receivedAt > since)
      : webhookEvents;
    return res.json({ ok: true, events });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
