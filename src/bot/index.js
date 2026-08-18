import { Telegraf, session, Markup } from 'telegraf';
import crypto from 'crypto';
import { query, withTransaction } from '../db/index.js';
import { getSetting } from '../services/settingsService.js';
import { getUserWallet } from '../services/accounting.js';
import { requestWithdrawal } from '../services/withdrawalService.js';
import { normalizeAndValidateEthereum, normalizeAndValidateLitecoin, sanitizeInput } from '../utils/validators.js';
import {
    mainMenuKeyboard,
    sellSubMenuKeyboard,
    oldAccountSubmitKeyboard,
    getCreateTaskKeyboard,
    getWithdrawMethodsKeyboard,
    getWithdrawConfirmKeyboard
} from './keyboards.js';

export function createTelegramBot(token) {
    const bot = new Telegraf(token);
    bot.use(session());

    // ---------------------------------------------------------
    // MIDDLEWARE: User Registration, Activity & Ban Enforcement
    // ---------------------------------------------------------
    bot.use(async (ctx, next) => {
        if (!ctx.from) return next();
        const { id, username, first_name, last_name, language_code, is_premium } = ctx.from;

        const metadata = {
            username: username || null,
            first_name: first_name || null,
            last_name: last_name || null,
            language_code: language_code || 'en',
            is_premium: is_premium || false,
            last_seen: new Date().toISOString()
        };

        let res = await query('SELECT * FROM users WHERE telegram_id = $1', [id]);
        if (res.rows.length === 0) {
            let referrerId = null;
            if (ctx.message?.text?.startsWith('/start ref_')) {
                const refNum = parseInt(ctx.message.text.split('ref_')[1], 10);
                if (!isNaN(refNum) && refNum !== id) referrerId = refNum;
            }

            await query(`
                INSERT INTO users (telegram_id, username, first_name, last_name, language_code, referrer_id, user_metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (telegram_id) DO UPDATE 
                SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, user_metadata = EXCLUDED.user_metadata, updated_at = CURRENT_TIMESTAMP
            `, [id, username || null, first_name || null, last_name || null, language_code || 'en', referrerId, JSON.stringify(metadata)]);

            await query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
        } else {
            const user = res.rows[0];
            if (user.account_status === 'BANNED') {
                return ctx.reply('⛔ <b>Access Denied:</b> Your account has been permanently suspended by the buyer.', { parse_mode: 'HTML' });
            }
            await query(`
                UPDATE users 
                SET username = $1, first_name = $2, last_name = $3, user_metadata = $4, updated_at = CURRENT_TIMESTAMP 
                WHERE telegram_id = $5
            `, [username || null, first_name || null, last_name || null, JSON.stringify(metadata), id]);
        }
        return next();
    });

    // ---------------------------------------------------------
    // 👑 TELEGRAM ADMIN COMMAND: /backup
    // ---------------------------------------------------------
    bot.command('backup', async (ctx) => {
        const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
        if (ctx.from.id !== adminId) {
            return ctx.reply('⛔ You do not have administrator permissions to run this command.');
        }

        const statusMsg = await ctx.reply('🔄 <b>Generating full database backup...</b>', { parse_mode: 'HTML' });

        try {
            const [users, wallets, transactions, tasks, pool, withdrawals, holds, settings, auditLogs] = await Promise.all([
                query('SELECT * FROM users ORDER BY id ASC'),
                query('SELECT * FROM wallets ORDER BY id ASC'),
                query('SELECT * FROM wallet_transactions ORDER BY id ASC'),
                query('SELECT * FROM tasks ORDER BY id ASC'),
                query('SELECT * FROM admin_task_pool ORDER BY id ASC'),
                query('SELECT * FROM withdrawals ORDER BY id ASC'),
                query('SELECT * FROM holds ORDER BY id ASC'),
                query('SELECT * FROM settings'),
                query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500')
            ]);

            const backupData = {
                export_date: new Date().toISOString(),
                environment: process.env.NODE_ENV || 'production',
                summary: {
                    total_users: users.rows.length,
                    total_wallets: wallets.rows.length,
                    total_transactions: transactions.rows.length,
                    total_tasks: tasks.rows.length,
                    total_pool_tasks: pool.rows.length,
                    total_withdrawals: withdrawals.rows.length,
                    total_holds: holds.rows.length
                },
                database: {
                    users: users.rows,
                    wallets: wallets.rows,
                    wallet_transactions: transactions.rows,
                    tasks: tasks.rows,
                    admin_task_pool: pool.rows,
                    withdrawals: withdrawals.rows,
                    holds: holds.rows,
                    settings: settings.rows,
                    audit_logs: auditLogs.rows
                }
            };

            const jsonBuffer = Buffer.from(JSON.stringify(backupData, null, 2), 'utf-8');
            const fileName = `Velrix_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

            await ctx.deleteMessage(statusMsg.message_id).catch(() => {});

            await ctx.replyWithDocument(
                { source: jsonBuffer, filename: fileName },
                {
                    caption: `📦 <b>Full Database Backup Export Complete!</b>\n\n` +
                             `👥 Users: <code>${users.rows.length}</code>\n` +
                             `📋 Tasks: <code>${tasks.rows.length}</code>\n` +
                             `🏊 Pool Tasks: <code>${pool.rows.length}</code>\n` +
                             `💳 Ledger TXs: <code>${transactions.rows.length}</code>\n` +
                             `💸 Withdrawals: <code>${withdrawals.rows.length}</code>\n` +
                             `📅 Export Date: <code>${new Date().toUTCString()}</code>`,
                    parse_mode: 'HTML'
                }
            );
        } catch (err) {
            console.error('Backup command error:', err);
            await ctx.reply(`⚠️ Backup export failed: ${err.message}`);
        }
    });

    // ---------------------------------------------------------
    // 1. /start (WITH OPTIONAL PROFILE VERIFICATION CONTACT SHARE)
    // ---------------------------------------------------------
    bot.start(async (ctx) => {
        const userRes = await query('SELECT is_verified, phone_number FROM users WHERE telegram_id = $1', [ctx.from.id]);
        const user = userRes.rows[0];

        const welcomeText = `👋 <b>Welcome to the Account Submission Platform!</b>\n\nSubmit accounts directly to the buyer, manage your earnings, and withdraw securely.`;

        // If user hasn't shared contact, show the verification contact button
        if (!user?.is_verified && !user?.phone_number) {
            const verifyKeyboard = Markup.keyboard([
                [Markup.button.contactRequest('📲 Verify Profile (Share Contact)')],
                ['➕ Sell Account', '💰 Balance'],
                ['💸 Withdraw', '📋 My Tasks'],
                ['📜 Transaction History', '👥 Referral'],
                ['⚙️ Settings', '❓ Help']
            ]).resize();

            return await ctx.replyWithHTML(
                `${welcomeText}\n\n💡 <i>Tip: Tap <b>📲 Verify Profile</b> below to link your account for priority submission reviews and payouts.</i>`,
                verifyKeyboard
            );
        }

        await ctx.replyWithHTML(welcomeText, mainMenuKeyboard);
    });

    // Handle Contact Submission
    bot.on('contact', async (ctx) => {
        const contact = ctx.message.contact;
        if (!contact || contact.user_id !== ctx.from.id) {
            return ctx.reply('⚠️ Please share your own contact using the verification button.', mainMenuKeyboard);
        }

        await query(`
            UPDATE users 
            SET phone_number = $1, is_verified = TRUE, updated_at = CURRENT_TIMESTAMP 
            WHERE telegram_id = $2
        `, [contact.phone_number, ctx.from.id]);

        await ctx.reply(
            `✅ <b>Profile Verified!</b>\n\nYour contact number (<code>${contact.phone_number}</code>) has been securely stored on your buyer account.`,
            { parse_mode: 'HTML', ...mainMenuKeyboard }
        );
    });

    // ---------------------------------------------------------
    // 2. MAIN USER MENU
    // ---------------------------------------------------------
    bot.hears('➕ Sell Account', async (ctx) => {
        const userRes = await query('SELECT selling_restricted, account_status FROM users WHERE telegram_id = $1', [ctx.from.id]);
        if (userRes.rows[0]?.selling_restricted || userRes.rows[0]?.account_status === 'SUSPENDED') {
            return ctx.reply('⚠️ Account submission is temporarily restricted on your account. Please contact support.');
        }
        await ctx.reply('Select submission type:', sellSubMenuKeyboard);
    });

    bot.hears('💰 Balance', async (ctx) => {
        const w = await getUserWallet(ctx.from.id);
        const msg = `💰 <b>Balance Overview</b>\n\n` +
                    `Available: <b>$${w.available.toFixed(2)}</b>\n` +
                    `🔒 Hold: $${w.hold.toFixed(2)}\n` +
                    `⏳ Withdrawal Pending: $${w.pending.toFixed(2)}\n\n` +
                    `<b>Total Balance: $${w.total.toFixed(2)}</b>`;
        await ctx.replyWithHTML(msg);
    });

    bot.hears('💸 Withdraw', async (ctx) => {
        const w = await getUserWallet(ctx.from.id);
        const minWd = await getSetting('min_withdrawal', 0.15);

        const msg = `💸 <b>Withdraw Funds</b>\n\n` +
                    `Available Balance: <b>$${w.available.toFixed(2)}</b>\n` +
                    `🔒 Hold Balance: $${w.hold.toFixed(2)}\n\n` +
                    `Minimum Withdrawal: $${parseFloat(minWd).toFixed(2)}\n\n` +
                    `Select Payment Method:`;
        await ctx.replyWithHTML(msg, getWithdrawMethodsKeyboard());
    });

    bot.hears('📋 My Tasks', async (ctx) => {
        const res = await query(
            'SELECT task_id, task_type, status, reward_amount, created_at FROM tasks WHERE user_id = $1 ORDER BY id DESC LIMIT 10',
            [ctx.from.id]
        );
        if (res.rows.length === 0) return ctx.reply('📋 You have no submitted tasks yet.');
        
        let text = '📋 <b>Your Recent Tasks:</b>\n\n';
        for (const t of res.rows) {
            text += `• <b>${t.task_id}</b> (${t.task_type})\n  Status: <code>${t.status}</code> | Reward: $${parseFloat(t.reward_amount).toFixed(2)}\n\n`;
        }
        await ctx.replyWithHTML(text);
    });

    bot.hears('📜 Transaction History', async (ctx) => {
        const res = await query(
            'SELECT transaction_id, type, amount, balance_type, reference_id, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 10',
            [ctx.from.id]
        );
        if (res.rows.length === 0) return ctx.reply('📜 No transaction records found.');

        let text = '📜 <b>Transaction History:</b>\n\n';
        for (const tx of res.rows) {
            const sign = parseFloat(tx.amount) >= 0 ? '+' : '';
            text += `📋 <b>${tx.transaction_id}</b>\n` +
                    `Type: ${tx.type}\n` +
                    `Amount: <b>${sign}$${parseFloat(tx.amount).toFixed(2)}</b> (${tx.balance_type})\n` +
                    `Date: ${new Date(tx.created_at).toLocaleDateString('en-GB')}\n\n`;
        }
        await ctx.replyWithHTML(text);
    });

    bot.hears('👥 Referral', async (ctx) => {
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
        
        const countRes = await query('SELECT COUNT(*) FROM users WHERE referrer_id = $1', [ctx.from.id]);
        const totalRef = parseInt(countRes.rows[0].count, 10);

        const rewardsRes = await query('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS qualified FROM referral_rewards WHERE referrer_id = $1', [ctx.from.id]);
        const earnings = parseFloat(rewardsRes.rows[0].total);
        const qualified = parseInt(rewardsRes.rows[0].qualified, 10);

        const msg = `👥 <b>Referral Program</b>\n\n` +
                    `Share your referral link with sellers to earn rewards.\n\n` +
                    `<b>Your Link:</b>\n<code>${refLink}</code>\n\n` +
                    `Total Referrals: ${totalRef}\n` +
                    `Qualified Referrals: ${qualified}\n` +
                    `Referral Earnings: $${earnings.toFixed(2)}`;
        await ctx.replyWithHTML(msg);
    });

    bot.hears('⚙️ Settings', async (ctx) => {
        const userRes = await query('SELECT phone_number, is_verified FROM users WHERE telegram_id = $1', [ctx.from.id]);
        const u = userRes.rows[0];
        await ctx.replyWithHTML(
            `⚙️ <b>Profile Information</b>\n\n` +
            `Telegram ID: <code>${ctx.from.id}</code>\n` +
            `Username: @${ctx.from.username || 'None'}\n` +
            `Phone: <code>${u?.phone_number || 'Not Linked'}</code>\n` +
            `Verification Status: ${u?.is_verified ? '🟢 Verified' : '⚪ Unverified'}`
        );
    });

    bot.hears('❓ Help', async (ctx) => {
        const guide = await getSetting('how_to_create_guide', 'Follow the registration information provided in your task exactly.');
        await ctx.replyWithHTML(`❓ <b>Help & FAQ</b>\n\n${guide}`);
    });

    // ---------------------------------------------------------
    // 3. INLINE SUBMENUS & CALLBACKS
    // ---------------------------------------------------------
    bot.action('menu_main', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply('Main Menu', mainMenuKeyboard);
    });

    bot.action('sell_menu', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageText('Select submission type:', sellSubMenuKeyboard);
    });

    // OLD ACCOUNT FLOW (PRO FORMAT)
    bot.action('sell_old_account', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `Old Account Submission\n\nSubmit your existing account information for buyer review.`;
        await ctx.editMessageText(text, oldAccountSubmitKeyboard);
    });

    bot.action('old_account_continue', async (ctx) => {
        await ctx.answerCbQuery();
        ctx.session = ctx.session || {};
        ctx.session.step = 'AWAITING_OLD_ACCOUNT_DATA';

        const promptText = `Please send the account email address & password Like this format (pro text)\n\n` +
                           `<code>user82626@gmail.com</code>\n` +
                           `<code>Pass173551</code>\n\n` +
                           `⚠️  DO NOT Add Any OTP, recovery codes, or 2FA codes.`;

        await ctx.editMessageText(promptText, { parse_mode: 'HTML' });
    });

    // CREATE NEW ACCOUNT FLOW (STRICT ADMIN POOL ONLY)
    bot.action('sell_create_new', async (ctx) => {
        await ctx.answerCbQuery();

        let poolTask = null;
        await withTransaction(async (client) => {
            const poolRes = await client.query(`
                SELECT * FROM admin_task_pool 
                WHERE status = 'AVAILABLE' 
                ORDER BY id ASC LIMIT 1 
                FOR UPDATE SKIP LOCKED
            `);

            if (poolRes.rows.length > 0) {
                const item = poolRes.rows[0];
                const taskId = `TASK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

                await client.query(`
                    UPDATE admin_task_pool 
                    SET status = 'ASSIGNED', assigned_to_user_id = $1, assigned_task_id = $2 
                    WHERE id = $3
                `, [ctx.from.id, taskId, item.id]);

                await client.query(`
                    INSERT INTO tasks (task_id, user_id, task_type, status, first_name, last_name, email, dob_year, password_placeholder, reward_amount)
                    VALUES ($1, $2, 'CREATE_NEW', 'CREATED', $3, $4, $5, $6, $7, $8)
                `, [taskId, ctx.from.id, item.first_name, item.last_name, item.email, item.dob_year, item.password_placeholder, item.reward_amount]);

                poolTask = {
                    taskId,
                    firstName: item.first_name,
                    lastName: item.last_name,
                    email: item.email,
                    password: item.password_placeholder,
                    dobYear: item.dob_year,
                    reward: parseFloat(item.reward_amount)
                };
            }
        });

        // If no tasks in admin pool, DO NOT AUTO GENERATE!
        if (!poolTask) {
            return ctx.editMessageText(
                `❌ <b>No Account Creation Tasks Available</b>\n\n` +
                `The buyer has not added new creation tasks right now. Please check back later or choose 🟢 <b>Old Account</b> to submit existing accounts.`,
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'sell_menu')]]) }
            );
        }

        const text = `Register Gmail account using the specified data and get from $${poolTask.reward.toFixed(2)}\n\n` +
                     `First name: ${poolTask.firstName}\n` +
                     `Name: ${poolTask.lastName}\n` +
                     `Email: ${poolTask.email}\n` +
                     `Password: ${poolTask.password}\n` +
                     `Year of birth: ${poolTask.dobYear}\n\n` +
                     `🔐 Be sure to use the specified data, otherwise the account will not be paid.`;

        const sentMsg = await ctx.editMessageText(text, getCreateTaskKeyboard(poolTask.taskId, false, false));
        await query('UPDATE tasks SET telegram_message_id = $1 WHERE task_id = $2', [sentMsg.message_id, poolTask.taskId]);
    });

    // DONE -> CONFIRM
    bot.action(/task_done_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(getCreateTaskKeyboard(taskId, true, false).reply_markup);
    });

    // CONFIRM SUBMISSION
    bot.action(/task_confirm_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();

        const taskRes = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
        if (taskRes.rows.length === 0 || taskRes.rows[0].status !== 'CREATED') return;

        await query(`
            UPDATE tasks 
            SET status = 'SUBMITTED', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE task_id = $1
        `, [taskId]);

        await ctx.editMessageText(`⏳ Your Gmail account creation task (${taskId}) has been submitted for review.\n\nPlease wait for confirmation.`);
    });

    // CANCEL FLOW
    bot.action(/task_cancel_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(getCreateTaskKeyboard(taskId, false, true).reply_markup);
    });

    bot.action(/task_cancel_yes_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();

        const res = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
        if (res.rows.length === 0) return;
        const task = res.rows[0];

        await query("UPDATE tasks SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE task_id = $1", [taskId]);
        await query("UPDATE admin_task_pool SET status = 'AVAILABLE', assigned_to_user_id = NULL, assigned_task_id = NULL WHERE assigned_task_id = $1", [taskId]);

        const text = `Register Gmail account using the specified data and get from $${parseFloat(task.reward_amount).toFixed(2)}\n\n` +
                     `First name: ${task.first_name}\n` +
                     `Name: ${task.last_name || '✖️'}\n` +
                     `Email: ${task.email}\n` +
                     `Password: ${task.password_placeholder}\n` +
                     `Year of birth: ${task.dob_year}\n\n` +
                     `🔐 Be sure to use the specified data, otherwise the account will not be paid.\n\n` +
                     `⛔ Registration cancelled`;

        await ctx.editMessageText(text);
    });

    bot.action(/task_guide_(.+)/, async (ctx) => {
        await ctx.answerCbQuery();
        const guide = await getSetting('how_to_create_guide', 'Follow the registration information provided in your task exactly.');
        await ctx.reply(guide);
    });

    // ---------------------------------------------------------
    // 4. WITHDRAWAL HANDLERS
    // ---------------------------------------------------------
    bot.action(/wd_method_(.+)/, async (ctx) => {
        const method = ctx.match[1]; // 'USDT_ERC20' or 'LTC'
        await ctx.answerCbQuery();

        ctx.session = ctx.session || {};
        ctx.session.wd_method = method;
        ctx.session.step = 'AWAITING_WD_ADDRESS';

        if (method === 'USDT_ERC20') {
            await ctx.editMessageText(
                `🪙 <b>USDT — Ethereum (ERC-20)</b>\n\n` +
                `Please enter your ERC-20 wallet address:\n` +
                `<i>Example: 0x71C... (42 characters)</i>`,
                { parse_mode: 'HTML' }
            );
        } else {
            await ctx.editMessageText(
                `🪙 <b>Litecoin (LTC)</b>\n\n` +
                `Please enter your Litecoin wallet address:\n` +
                `<i>Supports: L..., M..., or Native Segwit (ltc1...)</i>`,
                { parse_mode: 'HTML' }
            );
        }
    });

    bot.action('wd_back_to_methods', async (ctx) => {
        await ctx.answerCbQuery();
        const w = await getUserWallet(ctx.from.id);
        const minWd = await getSetting('min_withdrawal', 0.15);

        const msg = `💸 <b>Withdraw Funds</b>\n\n` +
                    `Available Balance: $${w.available.toFixed(2)}\n` +
                    `🔒 Hold Balance: $${w.hold.toFixed(2)}\n\n` +
                    `Minimum Withdrawal: $${parseFloat(minWd).toFixed(2)}\n\n` +
                    `Select Payment Method:`;
        await ctx.editMessageText(msg, { parse_mode: 'HTML', ...getWithdrawMethodsKeyboard() });
    });

    bot.action('wd_confirm_submit', async (ctx) => {
        await ctx.answerCbQuery();
        ctx.session = ctx.session || {};
        const { wd_method, wd_address } = ctx.session;

        if (!wd_method || !wd_address) {
            return ctx.reply('⚠️ Withdrawal session timed out. Please tap 💸 Withdraw again.');
        }

        try {
            const res = await requestWithdrawal(ctx.from.id, wd_method, wd_address);
            ctx.session = {};

            const label = wd_method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';
            await ctx.editMessageText(
                `✅ <b>Withdrawal Submitted</b>\n\n` +
                `Amount: $${res.amount.toFixed(2)}\n` +
                `Method: ${label}\n` +
                `Address: <code>${res.address}</code>\n` +
                `Status: ⏳ Pending\n` +
                `Withdrawal ID: <code>${res.withdrawal_id}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            await ctx.reply(`⚠️ ${err.message}`);
        }
    });

    // ---------------------------------------------------------
    // 5. TEXT INPUT HANDLER (Old Account & Withdrawal Address)
    // ---------------------------------------------------------
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        ctx.session = ctx.session || {};

        // A. Old Account Submission Format
        if (ctx.session.step === 'AWAITING_OLD_ACCOUNT_DATA') {
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) {
                return ctx.replyWithHTML(
                    `⚠️ <b>Invalid Format!</b>\nPlease send both email and password on separate lines:\n\n` +
                    `<code>user82626@gmail.com</code>\n` +
                    `<code>Pass173551</code>\n\n` +
                    `⚠️  DO NOT Add Any OTP, recovery codes, or 2FA codes.`
                );
            }

            const submittedEmail = sanitizeInput(lines[0]);
            const submittedPassword = sanitizeInput(lines[1]);
            const taskId = `TASK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const reward = await getSetting('old_account_payment', 0.20);

            await query(`
                INSERT INTO tasks (task_id, user_id, task_type, status, submitted_email, submitted_password, reward_amount, submitted_at)
                VALUES ($1, $2, 'OLD_ACCOUNT', 'SUBMITTED', $3, $4, $5, CURRENT_TIMESTAMP)
            `, [taskId, ctx.from.id, submittedEmail, submittedPassword, parseFloat(reward)]);

            ctx.session.step = null;
            await ctx.replyWithHTML(
                `⏳ Your account submission is under review.\n\nPlease wait for confirmation.\n\nTask ID: <code>${taskId}</code>`,
                mainMenuKeyboard
            );
            return;
        }

        // B. Withdrawal Address Input
        if (ctx.session.step === 'AWAITING_WD_ADDRESS') {
            const method = ctx.session.wd_method;

            if (method === 'USDT_ERC20') {
                const validAddress = normalizeAndValidateEthereum(text);
                if (!validAddress) {
                    return ctx.replyWithHTML(
                        `⚠️ <b>Invalid ERC-20 Address!</b>\n\n` +
                        `Please enter a valid Ethereum ERC-20 address (starts with <code>0x</code> and has 42 characters).\n\n` +
                        `Please re-enter your USDT address:`
                    );
                }
                ctx.session.wd_address = validAddress;
            } else if (method === 'LTC') {
                const validAddress = normalizeAndValidateLitecoin(text);
                if (!validAddress) {
                    return ctx.replyWithHTML(
                        `⚠️ <b>Invalid Litecoin Address!</b>\n\n` +
                        `Please enter a valid Litecoin address (starts with <code>L</code>, <code>M</code>, <code>3</code>, or <code>ltc1</code>).\n\n` +
                        `Please re-enter your LTC address:`
                    );
                }
                ctx.session.wd_address = validAddress;
            }

            ctx.session.step = 'AWAITING_WD_CONFIRM';
            const w = await getUserWallet(ctx.from.id);
            const label = method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';

            const confText = `💸 <b>Withdrawal Confirmation</b>\n\n` +
                             `Amount: $${w.available.toFixed(2)}\n` +
                             `Method: ${label}\n` +
                             `Address: <code>${ctx.session.wd_address}</code>\n\n` +
                             `⚠️ Make sure the network and address are correct before confirming.`;

            await ctx.replyWithHTML(confText, getWithdrawConfirmKeyboard(method));
            return;
        }
    });

    return bot;
}
