import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Markup } from 'telegraf';
import { query, withTransaction } from '../db/index.js';
import { authenticateAdmin } from './middleware.js';
import { approveTaskPaymentToHold } from '../services/accounting.js';
import { processAdminWithdrawal } from '../services/withdrawalService.js';
import { processReferralRewardIfQualified } from '../services/referralService.js';
import { getAllSettings, setSetting } from '../services/settingsService.js';
import { notifyUser } from '../services/notificationService.js';

export function createAdminRouter(botInstance) {
    const router = express.Router();

    // 1. Login
    router.post('/login', async (req, res) => {
        const { username, password } = req.body;
        const adminRes = await query('SELECT * FROM admin_users WHERE username = $1', [username]);
        if (adminRes.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const admin = adminRes.rows[0];
        const match = await bcrypt.compare(password, admin.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign(
            { id: admin.id, username: admin.username, role: admin.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        res.json({ token, username: admin.username, role: admin.role });
    });

    // 2. Stats
    router.get('/dashboard', authenticateAdmin, async (req, res) => {
        try {
            const [users, active, tasks, pendingTasks, wallets, completedWd, pendingWd, poolCount] = await Promise.all([
                query('SELECT COUNT(*) FROM users'),
                query("SELECT COUNT(*) FROM users WHERE account_status = 'ACTIVE'"),
                query('SELECT COUNT(*) FROM tasks'),
                query("SELECT COUNT(*) FROM tasks WHERE status IN ('SUBMITTED', 'UNDER_REVIEW')"),
                query('SELECT COALESCE(SUM(available_balance),0) AS avail, COALESCE(SUM(hold_balance),0) AS hold, COALESCE(SUM(pending_withdrawal),0) AS pending FROM wallets'),
                query("SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'COMPLETED'"),
                query("SELECT COUNT(*) FROM withdrawals WHERE status = 'PENDING'"),
                query("SELECT COUNT(*) FROM admin_task_pool WHERE status = 'AVAILABLE'")
            ]);

            res.json({
                users: { total: +users.rows[0].count, active: +active.rows[0].count },
                tasks: { total: +tasks.rows[0].count, pending: +pendingTasks.rows[0].count },
                poolAvailable: +poolCount.rows[0].count,
                financials: {
                    availableUserBalance: +wallets.rows[0].avail,
                    totalHeld: +wallets.rows[0].hold,
                    pendingWithdrawalsCount: +pendingWd.rows[0].count,
                    totalWithdrawnCompleted: +completedWd.rows[0].total
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 3. Admin Task Pool
    router.get('/tasks/pool', authenticateAdmin, async (req, res) => {
        const result = await query('SELECT * FROM admin_task_pool ORDER BY id DESC LIMIT 200');
        res.json(result.rows);
    });

    router.post('/tasks/pool/create', authenticateAdmin, async (req, res) => {
        const { firstName, lastName, email, password, dobYear, rewardAmount } = req.body;
        if (!firstName || !email || !password) {
            return res.status(400).json({ error: 'First Name, Email, and Password are required.' });
        }

        const poolId = `POOL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        await query(`
            INSERT INTO admin_task_pool (pool_id, first_name, last_name, email, password_placeholder, dob_year, reward_amount)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [poolId, firstName, lastName || '✖️', email, password, parseInt(dobYear, 10) || 2000, parseFloat(rewardAmount) || 0.23]);

        await query(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES ($1, 'ADMIN_TASK_CREATED', 'TASK_POOL', $2, $3)
        `, [req.admin.username, poolId, JSON.stringify(req.body)]);

        res.json({ success: true });
    });

    router.delete('/tasks/pool/:id', authenticateAdmin, async (req, res) => {
        await query('DELETE FROM admin_task_pool WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    });

    // 4. Submissions Review
    router.get('/tasks', authenticateAdmin, async (req, res) => {
        const tasks = await query('SELECT * FROM tasks ORDER BY id DESC LIMIT 150');
        res.json(tasks.rows);
    });

    router.post('/tasks/:taskId/review', authenticateAdmin, async (req, res) => {
        const { taskId } = req.params;
        const { action, reason } = req.body;

        try {
            if (action === 'APPROVE') {
                const result = await approveTaskPaymentToHold(taskId, req.admin.username);
                await processReferralRewardIfQualified(result.user_id, taskId);

                const msg = `✅ <b>Submission Approved</b>\n\nTask ID: <code>${taskId}</code>\nPayment: $${result.amount.toFixed(2)}\n🔒 Amount added to Hold Balance (${result.holdDays} days).`;
                await notifyUser(botInstance, result.user_id, msg);
                return res.json({ success: true });
            }

            if (action === 'REJECT') {
                const taskRes = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
                if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

                await query("UPDATE tasks SET status = 'REJECTED', rejection_reason = $1, reviewed_at = CURRENT_TIMESTAMP WHERE task_id = $2", [reason || 'Did not match required specifications', taskId]);
                await query("INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1, 'TASK_REJECTED', 'TASK', $2, $3)", [req.admin.username, taskId, JSON.stringify({ reason })]);

                const msg = `❌ <b>Submission Rejected</b>\n\nTask ID: <code>${taskId}</code>\nReason: ${reason || 'Details did not match specified criteria.'}`;
                await notifyUser(botInstance, taskRes.rows[0].user_id, msg);
                return res.json({ success: true });
            }
            res.status(400).json({ error: 'Invalid action' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 5. User Master Collector
    router.get('/users/detailed', authenticateAdmin, async (req, res) => {
        const users = await query(`
            SELECT 
                u.id,
                u.telegram_id,
                u.username,
                u.first_name,
                u.last_name,
                u.account_status,
                u.selling_restricted,
                u.withdrawal_restricted,
                u.referrer_id,
                u.created_at,
                u.updated_at,
                COALESCE(w.available_balance, 0) AS available_balance,
                COALESCE(w.hold_balance, 0) AS hold_balance,
                COALESCE(w.pending_withdrawal, 0) AS pending_withdrawal,
                (SELECT COUNT(*) FROM tasks WHERE user_id = u.telegram_id) AS total_tasks,
                (SELECT COUNT(*) FROM tasks WHERE user_id = u.telegram_id AND status = 'APPROVED') AS approved_tasks,
                (SELECT COUNT(*) FROM tasks WHERE user_id = u.telegram_id AND status = 'REJECTED') AS rejected_tasks,
                (SELECT COUNT(*) FROM withdrawals WHERE user_id = u.telegram_id) AS total_withdrawals
            FROM users u
            LEFT JOIN wallets w ON u.telegram_id = w.user_id
            ORDER BY u.id DESC
        `);
        res.json(users.rows);
    });

    // 6. FIXED Balance Adjustment
    router.post('/users/:telegramId/balance-adjust', authenticateAdmin, async (req, res) => {
        const { telegramId } = req.params;
        const { actionType, amount, balanceType, reason } = req.body;

        const numAmount = parseFloat(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ error: 'Valid positive amount required.' });
        }

        try {
            await withTransaction(async (client) => {
                await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [telegramId]);
                
                const col = balanceType === 'HOLD' ? 'hold_balance' : 'available_balance';
                const delta = actionType === 'ADD' ? numAmount : -numAmount;

                if (actionType === 'DEDUCT') {
                    const currentWallet = await client.query('SELECT * FROM wallets WHERE user_id = $1', [telegramId]);
                    if (parseFloat(currentWallet.rows[0][col]) < numAmount) {
                        throw new Error(`Cannot deduct more than user current ${balanceType} balance.`);
                    }
                }

                await client.query(`
                    UPDATE wallets 
                    SET ${col} = ${col} + $1, updated_at = CURRENT_TIMESTAMP 
                    WHERE user_id = $2
                `, [delta, telegramId]);

                const txId = `ADJ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                // Uses 'ADJUSTMENT_ADD' or 'ADJUSTMENT_DEDUCT'
                const txType = actionType === 'ADD' ? 'ADJUSTMENT_ADD' : 'ADJUSTMENT_DEDUCT';

                await client.query(`
                    INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, description)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [txId, telegramId, txType, delta, balanceType, reason || `Manual Admin ${actionType}`]);

                await client.query(`
                    INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
                    VALUES ($1, 'MANUAL_BALANCE_ADJUSTMENT', 'USER', $2, $3)
                `, [req.admin.username, telegramId, JSON.stringify({ actionType, amount: numAmount, balanceType, reason })]);
            });

            // Notify user
            const notifyMsg = actionType === 'ADD'
                ? `💰 <b>Balance Credited!</b>\n\nAn administrator added <b>+$${numAmount.toFixed(2)}</b> to your ${balanceType} balance.\nReason: ${reason || 'Adjustment'}`
                : `⚠️ <b>Balance Deducted!</b>\n\nAn administrator deducted <b>-$${numAmount.toFixed(2)}</b> from your ${balanceType} balance.\nReason: ${reason || 'Adjustment'}`;
            
            await notifyUser(botInstance, telegramId, notifyMsg);

            res.json({ success: true, message: 'Balance adjusted successfully.' });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // 7. Ban / Unban
    router.post('/users/:telegramId/status-action', authenticateAdmin, async (req, res) => {
        const { telegramId } = req.params;
        const { action } = req.body;

        let updateSql = '';
        if (action === 'BAN') {
            updateSql = "account_status = 'BANNED', selling_restricted = true, withdrawal_restricted = true";
        } else if (action === 'UNBAN') {
            updateSql = "account_status = 'ACTIVE', selling_restricted = false, withdrawal_restricted = false";
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }

        await query(`UPDATE users SET ${updateSql}, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $1`, [telegramId]);
        await query(`INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1, 'USER_STATUS_CHANGE', 'USER', $2, $3)`, [req.admin.username, telegramId, JSON.stringify({ action })]);

        if (action === 'BAN') {
            await notifyUser(botInstance, telegramId, '⛔ <b>Account Banned:</b> Your account has been suspended by the buyer.');
        } else {
            await notifyUser(botInstance, telegramId, '🟢 <b>Account Restored:</b> Your account has been reactivated.');
        }

        res.json({ success: true });
    });

    // 8. Rich Alerts & Broadcast with Live Buttons + Images
    router.post('/messages/send-alert', authenticateAdmin, async (req, res) => {
        const { targetType, targetIds, messageText, imageUrl, buttons } = req.body;
        if (!messageText) return res.status(400).json({ error: 'Message text is required.' });

        let recipientIds = [];
        if (targetType === 'CUSTOM') {
            recipientIds = Array.isArray(targetIds) ? targetIds : [targetIds];
        } else if (targetType === 'ACTIVE') {
            const r = await query("SELECT telegram_id FROM users WHERE account_status = 'ACTIVE'");
            recipientIds = r.rows.map(x => x.telegram_id);
        } else {
            const r = await query("SELECT telegram_id FROM users");
            recipientIds = r.rows.map(x => x.telegram_id);
        }

        let inlineMarkup = null;
        if (Array.isArray(buttons) && buttons.length > 0) {
            const validButtons = buttons
                .filter(b => b.text && b.url && b.url.startsWith('http'))
                .map(b => [Markup.button.url(b.text, b.url)]);
            if (validButtons.length > 0) {
                inlineMarkup = Markup.inlineKeyboard(validButtons);
            }
        }

        res.json({ success: true, message: `Broadcasting to ${recipientIds.length} users.` });

        (async () => {
            for (const uid of recipientIds) {
                try {
                    const extra = { parse_mode: 'HTML', ...(inlineMarkup ? inlineMarkup : {}) };
                    if (imageUrl && imageUrl.startsWith('http')) {
                        await botInstance.telegram.sendPhoto(uid, imageUrl, { caption: messageText, ...extra });
                    } else {
                        await botInstance.telegram.sendMessage(uid, messageText, extra);
                    }
                } catch (e) {
                    console.warn(`Could not deliver to ${uid}:`, e.message);
                }
                await new Promise(r => setTimeout(r, 45));
            }
        })();
    });

    // 9. Withdrawals
    router.get('/withdrawals', authenticateAdmin, async (req, res) => {
        const wds = await query('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 100');
        res.json(wds.rows);
    });

    router.post('/withdrawals/:withdrawalId/process', authenticateAdmin, async (req, res) => {
        const { withdrawalId } = req.params;
        const { action, txHash, reason } = req.body;
        const result = await processAdminWithdrawal(withdrawalId, action, req.admin.username, txHash, reason);
        const wd = result.withdrawal;

        if (action === 'COMPLETE') {
            const label = wd.method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';
            await notifyUser(botInstance, wd.user_id, `✅ <b>Withdrawal Completed</b>\n\nAmount: $${parseFloat(wd.amount).toFixed(2)}\nMethod: ${label}\nTX Hash: <code>${txHash || 'Confirmed'}</code>`);
        } else if (action === 'REJECT') {
            await notifyUser(botInstance, wd.user_id, `❌ <b>Withdrawal Rejected</b>\n\nReason: ${reason || 'Declined'}\n$${parseFloat(wd.amount).toFixed(2)} refunded to your Available Balance.`);
        }
        res.json({ success: true, result });
    });

    // 10. Settings
    router.get('/settings', authenticateAdmin, async (req, res) => res.json(await getAllSettings()));
    router.post('/settings', authenticateAdmin, async (req, res) => {
        for (const [k, v] of Object.entries(req.body)) await setSetting(k, v);
        res.json({ success: true });
    });

    return router;
}
