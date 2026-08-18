import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';
import { authenticateAdmin } from './middleware.js';
import { approveTaskPaymentToHold } from '../services/accounting.js';
import { processAdminWithdrawal } from '../services/withdrawalService.js';
import { processReferralRewardIfQualified } from '../services/referralService.js';
import { getAllSettings, setSetting } from '../services/settingsService.js';
import { notifyUser } from '../services/notificationService.js';

export function createAdminRouter(botInstance) {
    const router = express.Router();

    // 1. Admin Login
    router.post('/login', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const adminRes = await query('SELECT * FROM admin_users WHERE username = $1', [username]);
        if (adminRes.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });

        const admin = adminRes.rows[0];
        const match = await bcrypt.compare(password, admin.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

        const token = jwt.sign(
            { id: admin.id, username: admin.username, role: admin.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, username: admin.username, role: admin.role });
    });

    // 2. Statistics & Dashboard Analytics
    router.get('/dashboard', authenticateAdmin, async (req, res) => {
        try {
            const userCount = await query('SELECT COUNT(*) FROM users');
            const activeUsers = await query("SELECT COUNT(*) FROM users WHERE account_status = 'ACTIVE'");
            const totalTasks = await query('SELECT COUNT(*) FROM tasks');
            const submittedTasks = await query("SELECT COUNT(*) FROM tasks WHERE status IN ('SUBMITTED', 'UNDER_REVIEW')");
            const approvedTasks = await query("SELECT COUNT(*) FROM tasks WHERE status = 'APPROVED'");
            const rejectedTasks = await query("SELECT COUNT(*) FROM tasks WHERE status = 'REJECTED'");

            const walletTotals = await query(`
                SELECT 
                    COALESCE(SUM(available_balance), 0) AS total_available,
                    COALESCE(SUM(hold_balance), 0) AS total_hold,
                    COALESCE(SUM(pending_withdrawal), 0) AS total_pending
                FROM wallets
            `);

            const completedWd = await query("SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'COMPLETED'");
            const pendingWdCount = await query("SELECT COUNT(*) FROM withdrawals WHERE status = 'PENDING'");

            res.json({
                users: {
                    total: parseInt(userCount.rows[0].count, 10),
                    active: parseInt(activeUsers.rows[0].count, 10),
                },
                tasks: {
                    total: parseInt(totalTasks.rows[0].count, 10),
                    pending: parseInt(submittedTasks.rows[0].count, 10),
                    approved: parseInt(approvedTasks.rows[0].count, 10),
                    rejected: parseInt(rejectedTasks.rows[0].count, 10),
                },
                financials: {
                    availableUserBalance: parseFloat(walletTotals.rows[0].total_available),
                    totalHeld: parseFloat(walletTotals.rows[0].total_hold),
                    pendingWithdrawal: parseFloat(walletTotals.rows[0].total_pending),
                    totalWithdrawnCompleted: parseFloat(completedWd.rows[0].total),
                    pendingWithdrawalsCount: parseInt(pendingWdCount.rows[0].count, 10)
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 3. Submissions / Task Reviews
    router.get('/tasks', authenticateAdmin, async (req, res) => {
        const { status } = req.query;
        let sql = 'SELECT * FROM tasks';
        const params = [];
        if (status) {
            sql += ' WHERE status = $1';
            params.push(status);
        }
        sql += ' ORDER BY id DESC LIMIT 100';
        const tasks = await query(sql, params);
        res.json(tasks.rows);
    });

    router.post('/tasks/:taskId/review', authenticateAdmin, async (req, res) => {
        const { taskId } = req.params;
        const { action, reason } = req.body; // 'APPROVE', 'REJECT', 'HOLD_REVIEW'

        try {
            if (action === 'APPROVE') {
                const result = await approveTaskPaymentToHold(taskId, req.admin.username);
                // Trigger referral reward check if applicable
                await processReferralRewardIfQualified(result.user_id, taskId);

                // Notify User
                const notifyMsg = `✅ <b>Submission Approved</b>\n\nTask ID: <code>${taskId}</code>\nPayment: $${result.amount.toFixed(2)}\n🔒 Amount added to Hold Balance (${result.holdDays} days).`;
                await notifyUser(botInstance, result.user_id, notifyMsg);

                return res.json({ success: true, message: 'Task approved and hold created.', result });
            }

            if (action === 'REJECT') {
                const taskRes = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
                if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
                const task = taskRes.rows[0];

                await query(`
                    UPDATE tasks 
                    SET status = 'REJECTED', rejection_reason = $1, reviewed_at = CURRENT_TIMESTAMP 
                    WHERE task_id = $2
                `, [reason || 'Did not meet requirements', taskId]);

                await query(`
                    INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
                    VALUES ($1, 'TASK_REJECTED', 'TASK', $2, $3)
                `, [req.admin.username, taskId, JSON.stringify({ reason })]);

                const notifyMsg = `❌ <b>Submission Rejected</b>\n\nTask ID: <code>${taskId}</code>\nReason: ${reason || 'Details did not match specified registration criteria.'}`;
                await notifyUser(botInstance, task.user_id, notifyMsg);

                return res.json({ success: true, message: 'Task rejected.' });
            }

            if (action === 'HOLD_REVIEW') {
                await query("UPDATE tasks SET status = 'UNDER_REVIEW' WHERE task_id = $1", [taskId]);
                return res.json({ success: true, message: 'Task placed under review.' });
            }

            res.status(400).json({ error: 'Invalid action.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 4. Withdrawal Management
    router.get('/withdrawals', authenticateAdmin, async (req, res) => {
        const resWd = await query('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 100');
        res.json(resWd.rows);
    });

    router.post('/withdrawals/:withdrawalId/process', authenticateAdmin, async (req, res) => {
        const { withdrawalId } = req.params;
        const { action, txHash, reason } = req.body; // 'PROCESSING', 'COMPLETE', 'REJECT'

        try {
            const result = await processAdminWithdrawal(withdrawalId, action, req.admin.username, txHash, reason);
            const wd = result.withdrawal;

            if (action === 'COMPLETE') {
                const label = wd.method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';
                const msg = `✅ <b>Withdrawal Completed</b>\n\n` +
                            `Amount: $${parseFloat(wd.amount).toFixed(2)}\n` +
                            `Method: ${label}\n` +
                            `Transaction ID: <code>${withdrawalId}</code>\n` +
                            `TX Hash: <code>${txHash || 'Confirmed on-chain'}</code>`;
                await notifyUser(botInstance, wd.user_id, msg);
            } else if (action === 'REJECT') {
                const msg = `❌ <b>Withdrawal Rejected</b>\n\n` +
                            `Reason: ${reason || 'Declined'}\n` +
                            `$${parseFloat(wd.amount).toFixed(2)} has been returned to your Available Balance.`;
                await notifyUser(botInstance, wd.user_id, msg);
            }

            res.json({ success: true, result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 5. User Management & Audited Balance Adjustments
    router.get('/users', authenticateAdmin, async (req, res) => {
        const users = await query(`
            SELECT u.*, w.available_balance, w.hold_balance, w.pending_withdrawal 
            FROM users u 
            LEFT JOIN wallets w ON u.telegram_id = w.user_id 
            ORDER BY u.id DESC LIMIT 100
        `);
        res.json(users.rows);
    });

    router.post('/users/:telegramId/status', authenticateAdmin, async (req, res) => {
        const { telegramId } = req.params;
        const { status, selling_restricted, withdrawal_restricted } = req.body;

        await query(`
            UPDATE users 
            SET account_status = COALESCE($1, account_status),
                selling_restricted = COALESCE($2, selling_restricted),
                withdrawal_restricted = COALESCE($3, withdrawal_restricted),
                updated_at = CURRENT_TIMESTAMP
            WHERE telegram_id = $4
        `, [status, selling_restricted, withdrawal_restricted, telegramId]);

        await query(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES ($1, 'USER_STATUS_UPDATE', 'USER', $2, $3)
        `, [req.admin.username, telegramId, JSON.stringify(req.body)]);

        res.json({ success: true });
    });

    // 6. Platform Settings
    router.get('/settings', authenticateAdmin, async (req, res) => {
        const settings = await getAllSettings();
        res.json(settings);
    });

    router.post('/settings', authenticateAdmin, async (req, res) => {
        const updates = req.body;
        for (const [k, v] of Object.entries(updates)) {
            await setSetting(k, v);
        }
        await query(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES ($1, 'SETTINGS_UPDATE', 'SYSTEM', 'GLOBAL', $2)
        `, [req.admin.username, JSON.stringify(updates)]);

        res.json({ success: true });
    });

    // 7. Broadcast System with Telegram API rate-limit protection
    router.post('/broadcast', authenticateAdmin, async (req, res) => {
        const { message, target } = req.body; // 'ALL', 'ACTIVE', 'WITH_BALANCE'
        if (!message) return res.status(400).json({ error: 'Message cannot be empty.' });

        let sql = 'SELECT telegram_id FROM users';
        if (target === 'ACTIVE') sql += " WHERE account_status = 'ACTIVE'";
        if (target === 'WITH_BALANCE') {
            sql = 'SELECT u.telegram_id FROM users u JOIN wallets w ON u.telegram_id = w.user_id WHERE w.available_balance > 0 OR w.hold_balance > 0';
        }

        const recipients = await query(sql);
        let delivered = 0;
        let failed = 0;

        res.json({ success: true, message: `Broadcasting started to ${recipients.rows.length} users.` });

        (async () => {
            for (const r of recipients.rows) {
                try {
                    await botInstance.telegram.sendMessage(r.telegram_id, message, { parse_mode: 'HTML' });
                    delivered++;
                } catch {
                    failed++;
                }
                // Delay 40ms to respect Telegram 30 msg/sec broadcast limit
                await new Promise(res => setTimeout(res, 40));
            }
            console.log(`📢 Broadcast complete: ${delivered} delivered, ${failed} failed.`);
        })();
    });

    // 8. Audit Logs
    router.get('/audit-logs', authenticateAdmin, async (req, res) => {
        const logs = await query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');
        res.json(logs.rows);
    });

    return router;
}