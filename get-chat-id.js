import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("❌ Error: No TELEGRAM_BOT_TOKEN found in .env file.");
  process.exit(1);
}

console.log("🤖 Starting bot...");
console.log("⏳ Listening for messages...");
console.log("👉 PLEASE GO TO TELEGRAM AND SEND A MESSAGE IN YOUR GROUP NOW 👈");

const bot = new TelegramBot(token, { polling: true });

bot.on('message', (msg) => {
  console.log("\n✅ MESSAGE RECEIVED!");
  console.log("====================================");
  console.log(`Chat Name : ${msg.chat.title || 'Private Message'}`);
  console.log(`Chat Type : ${msg.chat.type}`);
  console.log(`CHAT ID   : ${msg.chat.id}`);
  console.log("====================================\n");
  console.log("🎉 Copy the CHAT ID above (including the minus sign if it has one)");
  console.log("and paste it into your .env file as TELEGRAM_CHAT_ID.");
  process.exit(0);
});