import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createTelegramBot } from './bot/index.js';
import { initBackgroundWorker } from './worker/scheduler.js';
import { createAdminRouter } from './admin/routes.js';
import { pool } from './db/index.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Admin Dashboard Static Assets
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));

// 1. Health Endpoint (Velrix monitoring requirement)
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// 2. Initialize Bot
const bot = createTelegramBot(process.env.BOT_TOKEN);

// 3. Admin API Router
app.use('/api/admin', createAdminRouter(bot));

// 4. Background Worker Initialization
initBackgroundWorker(bot);

// 5. Telegram Webhook / Polling Handler
const WEBHOOK_PATH = `/telegram/webhook/${process.env.WEBHOOK_SECRET || 'secret'}`;

if (process.env.NODE_ENV === 'production' && process.env.APP_URL) {
    app.use(bot.webhookCallback(WEBHOOK_PATH));
    bot.telegram.setWebhook(`${process.env.APP_URL}${WEBHOOK_PATH}`)
        .then(() => console.log(`🚀 Telegram Webhook configured at: ${process.env.APP_URL}${WEBHOOK_PATH}`))
        .catch((err) => console.error('Webhook set error:', err));
} else {
    bot.launch({ dropPendingUpdates: true })
        .then(() => console.log('🤖 Bot launched in long-polling mode (Development).'))
        .catch((err) => console.error('Bot launch error:', err));
}

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', {
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack
    });
    res.status(500).json({ error: '⚠️ An unexpected internal error occurred.' });
});

app.listen(PORT, () => {
    console.log(`🌐 Velrix Platform Server running on port ${PORT}`);
    console.log(`📊 Admin Panel accessible at: http://localhost:${PORT}/admin`);
});