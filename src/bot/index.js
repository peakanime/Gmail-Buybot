import { Telegraf, session, Markup } from 'telegraf';
import crypto from 'crypto';
import { query, withTransaction } from '../db/index.js';
import { getSetting } from '../services/settingsService.js';
import { getUserWallet } from '../services/accounting.js';
import { requestWithdrawal } from '../services/withdrawalService.js';
import { isValidEthereumAddress, isValidLitecoinAddress, sanitizeInput } from '../utils/validators.js';
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

    // Middleware: User Registration, Activity Tracking & Ban Enforcement
    bot.use(async (ctx, next) => {
        if (!ctx.from) return next();
        const { id, username, first_name, last_name } = ctx.from;

        let res = await query('SELECT * FROM users WHERE telegram_id = $1', [id]);
        if (res.rows.length === 0) {
            let referrerId = null;
            if (ctx.message?.text?.startsWith('/start ref_')) {
                const refNum = parseInt(ctx.message.text.split('ref_')[1], 10);
                if (!isNaN(refNum) && refNum !== id) referrerId = refNum;
            }

            await query(`
                INSERT INTO users (telegram_id, username, first_name, last_name, referrer_id)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (telegram_id) DO UPDATE 
                SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, updated_at = CURRENT_TIMESTAMP
            `, [id, username || null, first_name || null, last_name || null, referrerId]);

            await query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
        } else {
            const user = res.rows[0];
            if (user.account_status === 'BANNED') {
                return ctx.reply('⛔ <b>Access Denied:</b> Your account has been banned by the buyer.', { parse_mode: 'HTML' });
            }
            await query('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $1', [id]);
        }
        return next();
    });

    bot.start(async (ctx) => {
        const welcomeText = `👋 <b>Welcome to the Account Submission Platform!</b>\n\nSubmit accounts directly to the buyer, track hold balances, and withdraw earnings securely.`;
        await ctx.replyWithHTML(welcomeText, mainMenuKeyboard);
    });

    bot.hears('➕ Sell Account', async (ctx) => {
        const userRes = await query('SELECT selling_restricted, account_status FROM users WHERE telegram_id = $1', [ctx.from.id]);
        if (userRes.rows[0]?.selling_restricted || userRes.rows[0]?.account_status === 'SUSPENDED') {
            return ctx.reply('⚠️ Account submission is temporarily restricted on your account.');
        }
        await ctx.reply('Select submission type:', sellSubMenuKeyboard);
    });

    bot.hears('💰 Balance', async (ctx) => {
        const w = await getUserWallet(ctx.from.id);
        const msg = `💰 <b>Balance</b>\n\n` +
                    `Available: $${w.available.toFixed(2)}\n` +
                    `🔒 Hold: $${w.hold.toFixed(2)}\n` +
                    `⏳ Withdrawal Pending: $${w.pending.toFixed(2)}\n\n` +
                    `<b>Total: $${w.total.toFixed(2)}</b>`;
        await ctx.replyWithHTML(msg);
    });

    bot.hears('💸 Withdraw', async (ctx) => {
        const w = await getUserWallet(ctx.from.id);
        const minWd = await getSetting('min_withdrawal', 0.15);

        const msg = `💸 <b>Withdraw</b>\n\n` +
                    `Available Balance: $${w.available.toFixed(2)}\n` +
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
        if (res.rows.length === 0) return ctx.reply('📜 No transaction history found.');

        let text = '📜 <b>Transaction History:</b>\n\n';
        for (const tx of res.rows) {
            const sign = parseFloat(tx.amount) >= 0 ? '+' : '';
            text += `📋 <b>${tx.transaction_id}</b>\n` +
                    `Type: ${tx.type}\n` +
                    `Amount: ${sign}$${parseFloat(tx.amount).toFixed(2)} (${tx.balance_type})\n` +
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
        await ctx.replyWithHTML(`⚙️ <b>User Profile & Settings</b>\n\nTelegram ID: <code>${ctx.from.id}</code>\nUsername: @${ctx.from.username || 'None'}`);
    });

    bot.hears('❓ Help', async (ctx) => {
        const guide = await getSetting('how_to_create_guide', 'Follow the registration information provided in your task exactly.');
        await ctx.replyWithHTML(`❓ <b>Help & FAQ</b>\n\n${guide}`);
    });

    // Submenu Actions
    bot.action('menu_main', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply('Main Menu', mainMenuKeyboard);
    });

    bot.action('sell_menu', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageText('Select submission type:', sellSubMenuKeyboard);
    });

    // OLD ACCOUNT FLOW
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
                           `user82626@gmail.com\n` +
                           `Pass173551\n\n` +
                           `⚠️  DO NOT Add Any OTP, recovery codes, or 2FA codes.`;

        await ctx.editMessageText(promptText);
    });

    // STRICT ADMIN-POOL CREATE NEW TASK FLOW
    bot.action('sell_create_new', async (ctx) => {
        await ctx.answerCbQuery();

        // 1. Fetch exactly 1 task from pool atomically with lock
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

        // 2. If NO tasks in admin pool, DO NOT AUTO GENERATE!
        if (!poolTask) {
            return ctx.editMessageText(
                `❌ <b>No Account Creation Tasks Available</b>\n\n` +
                `The buyer has not added new tasks right now. Please check back later or choose 🟢 <b>Old Account</b> to submit existing accounts.`,
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
        if (taskRes.rows.length === 0) return;
        const task = taskRes.rows[0];

        if (task.status !== 'CREATED') return ctx.reply(`Task is already ${task.status}.`);

        await query(`
            UPDATE tasks 
            SET status = 'SUBMITTED', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE task_id = $1
        `, [taskId]);

        await ctx.editMessageText(
            `⏳ Your Gmail account creation task has been submitted for review.\n\nPlease wait for confirmation.`
        );
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

    // WITHDRAWAL CALLBACKS
    bot.action(/wd_method_(.+)/, async (ctx) => {
        const method = ctx.match[1];
        await ctx.answerCbQuery();

        ctx.session = ctx.session || {};
        ctx.session.wd_method = method;
        ctx.session.step = 'AWAITING_WD_ADDRESS';

        const label = method === 'USDT_ERC20' ? '🪙 USDT — ERC-20' : '🪙 LTC — Litecoin Network';
        await ctx.editMessageText(`${label}\n\nPlease enter your wallet address:`);
    });

    bot.action('wd_back_to_methods', async (ctx) => {
        await ctx.answerCbQuery();
        const w = await getUserWallet(ctx.from.id);
        const minWd = await getSetting('min_withdrawal', 0.15);

        const msg = `💸 <b>Withdraw</b>\n\n` +
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

    // TEXT HANDLER
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        ctx.session = ctx.session || {};

        if (ctx.session.step === 'AWAITING_OLD_ACCOUNT_DATA') {
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) {
                return ctx.reply(
                    `⚠️ Invalid Format!\nPlease send both email and password on separate lines:\n\n` +
                    `user82626@gmail.com\n` +
                    `Pass173551\n\n` +
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
            await ctx.reply(
                `⏳ Your account submission is under review.\n\nPlease wait for confirmation.\n\nTask ID: ${taskId}`,
                mainMenuKeyboard
            );
            return;
        }

        if (ctx.session.step === 'AWAITING_WD_ADDRESS') {
            const method = ctx.session.wd_method;
            if (method === 'USDT_ERC20' && !isValidEthereumAddress(text)) {
                return ctx.reply('⚠️ Invalid ERC-20 address format. Please re-enter:');
            }
            if (method === 'LTC' && !isValidLitecoinAddress(text)) {
                return ctx.reply('⚠️ Invalid Litecoin address format. Please re-enter:');
            }

            ctx.session.wd_address = text;
            ctx.session.step = 'AWAITING_WD_CONFIRM';

            const w = await getUserWallet(ctx.from.id);
            const label = method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';

            const confText = `💸 <b>Withdrawal Confirmation</b>\n\n` +
                             `Amount: $${w.available.toFixed(2)}\n` +
                             `Method: ${label}\n` +
                             `Address: <code>${text}</code>\n\n` +
                             `⚠️ Make sure the network and address are correct before confirming.`;

            await ctx.replyWithHTML(confText, getWithdrawConfirmKeyboard(method));
            return;
        }
    });

    return bot;
}
