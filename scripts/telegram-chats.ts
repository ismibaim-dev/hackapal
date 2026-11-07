// Lists the Telegram chats our seller-ping bot can see, with their chat ids, so you can fill
// TELEGRAM_SHOP_CHATS on Render without pasting the bot token anywhere.
//
//   npm run telegram-chats
//
// Needs TELEGRAM_BOT_TOKEN in your environment or in .env (never committed). Add the bot to
// each shop's group first, then send /start in the group. Telegram keeps updates for 24 hours.
// Prints chat ids and titles only; never the token.
import { loadDotEnv } from '../src/config.js';

type Chat = { id: number; type: string; title?: string; username?: string; first_name?: string };
type Update = {
  message?: { chat: Chat; migrate_to_chat_id?: number };
  channel_post?: { chat: Chat };
  my_chat_member?: { chat: Chat; new_chat_member?: { status?: string } };
};

async function main(): Promise<void> {
  loadDotEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set: copy it from Render > hackapal > Environment into your local .env');

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
  console.log('\nThen set on Render: TELEGRAM_SHOP_CHATS=kampung-fresh-mart=<id>,kilat-home-cleaning=<id>');
}

main().catch((err: unknown) => {
  // Never print the request URL: it carries the bot token.
  console.error(`telegram-chats failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
