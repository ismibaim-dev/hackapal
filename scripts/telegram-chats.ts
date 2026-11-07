// Lists the Telegram chats one of our seller-ping bots can see, with their chat ids, so you can
// fill TELEGRAM_SHOP_CHATS on Render without pasting a bot token anywhere.
//
//   npm run telegram-chats                                  (the default bot)
//   npm run telegram-chats -- --shop kampung-fresh-mart     (that shop's own bot)
//
// Each run reads one token from your environment or .env (never committed):
// TELEGRAM_BOT_TOKEN, or TELEGRAM_BOT_TOKEN_<SHOP> with the shop id in capitals and "_" for "-"
// (TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART). A bot only sees its own chats, so run it once per
// bot. Add the bot to the shop's group first, then send /start in the group. Telegram keeps
// updates for 24 hours. Prints chat ids and titles only; never the token.
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../src/config.js';

const { values } = parseArgs({ options: { shop: { type: 'string' } } });

type Chat = { id: number; type: string; title?: string; username?: string; first_name?: string };
type Update = {
  message?: { chat: Chat; migrate_to_chat_id?: number };
  channel_post?: { chat: Chat };
  my_chat_member?: { chat: Chat; new_chat_member?: { status?: string } };
};

async function main(): Promise<void> {
  loadDotEnv();
  const shop = values.shop?.trim();
  if (shop && !/^[a-z0-9-]{1,64}$/.test(shop)) throw new Error(`"${shop}" is not a shop id (lowercase letters, digits and hyphens)`);
  const varName = shop ? `TELEGRAM_BOT_TOKEN_${shop.toUpperCase().replaceAll('-', '_')}` : 'TELEGRAM_BOT_TOKEN';
  const token = process.env[varName]?.trim();
  if (!token) throw new Error(`${varName} is not set: put that bot's token (from BotFather) in your local .env as ${varName}=...`);

  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?allowed_updates=${encodeURIComponent('["message","channel_post","my_chat_member"]')}`);
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: Update[] };
  if (res.status === 401) throw new Error('Telegram refused the bot token');
  if (!body.ok) throw new Error(`Telegram said: ${body.description ?? `HTTP ${res.status}`}`);

  const chats = new Map<number, { chat: Chat; note?: string }>();
  for (const update of body.result ?? []) {
    const chat = update.message?.chat ?? update.channel_post?.chat ?? update.my_chat_member?.chat;
    if (!chat) continue;
    const migrated = update.message?.migrate_to_chat_id;
    const left = update.my_chat_member?.new_chat_member?.status;
    chats.set(chat.id, {
      chat,
      ...(migrated ? { note: `upgraded to supergroup: use ${migrated}` } : {}),
      ...(left === 'left' || left === 'kicked' ? { note: 'the bot was removed from this chat' } : {}),
    });
  }

  if (chats.size === 0) {
    console.log('No chats yet. Add the bot to each shop group, send /start in the group, then run this again.');
    return;
  }
  console.log('Chats the bot has seen in the last 24 hours:\n');
  for (const { chat, note } of chats.values()) {
    const name = chat.title ?? (chat.username ? `@${chat.username}` : chat.first_name ?? '(no name)');
    console.log(`  ${String(chat.id).padEnd(16)} ${chat.type.padEnd(11)} ${name}${note ? `  (${note})` : ''}`);
  }
  console.log(`\nChat ids for ${shop ? `the ${shop} bot` : 'the default bot'}. Put the right one in Render's TELEGRAM_SHOP_CHATS (shop-id=chat-id, comma separated).`);
}

main().catch((err: unknown) => {
  // Never print the request URL: it carries the bot token.
  console.error(`telegram-chats failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
