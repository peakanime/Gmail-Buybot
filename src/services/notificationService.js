export async function notifyUser(bot, telegramId, htmlMessage) {
    if (!bot || !telegramId) return;
    try {
        await bot.telegram.sendMessage(telegramId, htmlMessage, { parse_mode: 'HTML' });
    } catch (err) {
        console.warn(`Failed to deliver notification to ${telegramId}:`, err.message);
    }
}