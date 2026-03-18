import "dotenv/config";
import process from "node:process";

interface TelegramBotUser {
  id: number;
  username: string;
}

interface TelegramSendMessageResult {
  message_id: number;
}

interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
  description?: string;
}

interface TelegramApiFailure {
  ok: false;
  description?: string;
}

type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

const token = String(process.env.BOT_TOKEN || "").trim();
const expectedUsername = String(process.env.TELEGRAM_EXPECTED_USERNAME || "")
  .trim()
  .replace(/^@/, "");
const smokeChatId = String(process.env.TELEGRAM_SMOKE_CHAT_ID || "").trim();

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!token) {
  fail("Missing BOT_TOKEN.");
}

const getMeResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const getMePayload =
  (await getMeResponse.json()) as TelegramApiResponse<TelegramBotUser>;

if (!getMeResponse.ok || !getMePayload?.ok) {
  fail(
    `Telegram getMe failed: ${getMePayload?.description || getMeResponse.status}`
  );
}

const botUser = getMePayload.result;
console.log(`Bot username: @${botUser.username}`);
console.log(`Bot id: ${botUser.id}`);

if (expectedUsername && botUser.username !== expectedUsername) {
  fail(`Expected @${expectedUsername}, got @${botUser.username}`);
}

if (smokeChatId) {
  const message = `codex-telegram-claws smoke check ${new Date().toISOString()}`;
  const sendResponse = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: smokeChatId,
        text: message
      })
    }
  );
  const sendPayload =
    (await sendResponse.json()) as TelegramApiResponse<TelegramSendMessageResult>;

  if (!sendResponse.ok || !sendPayload?.ok) {
    fail(
      `Telegram sendMessage failed: ${sendPayload?.description || sendResponse.status}`
    );
  }

  console.log(`Smoke message sent to chat ${smokeChatId}.`);
}
