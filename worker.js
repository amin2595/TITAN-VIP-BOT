export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "GET") return new Response("OK", { status: 200 });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok", { status: 200 });
    } catch (e) {
      return new Response("ok", { status: 200 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanExpired(env));
  }
};

// -------------------- core --------------------

async function handleUpdate(update, env) {
  const msg = update.message || update.callback_query?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  await ensureTables(env);

  // ---------- inline callbacks ----------
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data;

    await answerCallback(cq.id, env);

    if (data?.startsWith("DAYS_")) {
      const days = parseInt(data.split("_")[1], 10);

      if (days === 0) {
        await setState(userId, "WAIT_CUSTOM_DAYS", env);
        await sendMessage(chatId, "✍️ تعداد روز دلخواه رو فقط به صورت عدد بفرست.\nمثال: 45", backKeyboard(), env);
        return;
      }

      await clearState(userId, env);
      await activateSub(userId, days, env);
      await sendMessage(chatId, `✅ اشتراک ${days} روزه فعال شد.`, mainKeyboard(), env);
      return;
    }

    if (data === "BACK_MAIN") {
      await clearState(userId, env);
      await sendMessage(chatId, "به منوی اصلی برگشتی 👇", mainKeyboard(), env);
      return;
    }

    return;
  }

  // ---------- normal messages ----------
  const text = (msg.text || "").trim();

  // /start
  if (text === "/start") {
    await clearState(userId, env);
    await sendMessage(
      chatId,
      `✨ به ربات VIP خوش اومدی!

اینجا می‌تونی:
✅ اشتراک رو فعال کنی
📌 وضعیت اشتراکتو ببینی
🧾 کد دریافت کنی
👨‍💻 با ادمین ارتباط بگیری

از منو انتخاب کن 👇`,
      mainKeyboard(),
      env
    );
    return;
  }

  // اگر منتظر عدد روز دلخواه هستیم
  const state = await getState(userId, env);
  if (state === "WAIT_CUSTOM_DAYS") {
    const days = parseInt(text, 10);

    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      await sendMessage(chatId, "❌ فقط عدد معتبر روز بفرست.\nمثال: 45", backKeyboard(), env);
      return;
    }

    await clearState(userId, env);
    await activateSub(userId, days, env);
    await sendMessage(chatId, `✅ اشتراک ${days} روزه فعال شد.`, mainKeyboard(), env);
    return;
  }

  // منوی اصلی
  if (text.includes("فعال‌سازی اشتراک")) {
    await sendMessage(chatId, "⏳ مدت اشتراک رو انتخاب کن:", daysInlineKeyboard(), env);
    return;
  }

  if (text.includes("وضعیت اشتراک")) {
    const sub = await getSub(userId, env);
    if (!sub) {
      await sendMessage(chatId, "❌ هیچ اشتراک فعالی نداری.", mainKeyboard(), env);
      return;
    }
    const leftMs = sub.expires_at * 1000 - Date.now();
    const leftDays = Math.max(0, Math.ceil(leftMs / (24 * 3600 * 1000)));
    await sendMessage(chatId, `✅ اشتراک فعاله.\n⏳ باقی‌مانده: ${leftDays} روز`, mainKeyboard(), env);
    return;
  }

  if (text.includes("دریافت اشتراک")) {
    await sendMessage(chatId, "🧾 برای دریافت اشتراک لطفاً با ادمین تماس بگیر.", mainKeyboard(), env);
    return;
  }

  if (text.includes("ارتباط با ادمین")) {
    await sendMessage(chatId, "👨‍💻 پیام بده تا ادمین جواب بده.", mainKeyboard(), env);
    return;
  }

  await sendMessage(chatId, "از منو انتخاب کن 👇", mainKeyboard(), env);
}

// -------------------- db --------------------

async function ensureTables(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      days INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      used_by INTEGER,
      used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY,
      state TEXT
    );
  `);
}

async function activateSub(userId, days, env) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + days * 24 * 3600;

  await env.DB.prepare(`
    INSERT INTO subscriptions (user_id, expires_at)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at
  `).bind(userId, expiresAt).run();
}

async function getSub(userId, env) {
  return await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id = ?`
  ).bind(userId).first();
}

async function setState(userId, state, env) {
  await env.DB.prepare(`
    INSERT INTO user_state (user_id, state)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state
  `).bind(userId, state).run();
}

async function getState(userId, env) {
  const r = await env.DB.prepare(
    `SELECT state FROM user_state WHERE user_id = ?`
  ).bind(userId).first();
  return r?.state || null;
}

async function clearState(userId, env) {
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id = ?`)
    .bind(userId).run();
}

// پاکسازی اشتراک‌های منقضی + بن از کانال
async function cleanExpired(env) {
  const now = Math.floor(Date.now() / 1000);

  const expired = await env.DB.prepare(
    `SELECT user_id FROM subscriptions WHERE expires_at <= ?`
  ).bind(now).all();

  if (!expired.results?.length) return;

  for (const row of expired.results) {
    const uid = row.user_id;

    await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id = ?`)
      .bind(uid).run();

    if (env.CHANNEL_ID) {
      await banUserFromChannel(uid, env.CHANNEL_ID, env);
    }
  }
}

// -------------------- telegram api --------------------

async function sendMessage(chatId, text, replyMarkup, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup
    })
  });
}

async function answerCallback(id, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id })
  });
}

async function banUserFromChannel(userId, channelId, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      user_id: userId
    })
  });
}

// -------------------- keyboards --------------------

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "✅ فعال‌سازی اشتراک VIP" }],
      [{ text: "📌 وضعیت اشتراک من" }],
      [{ text: "🧾 دریافت اشتراک" }],
      [{ text: "👨‍💻 ارتباط با ادمین" }]
    ],
    resize_keyboard: true
  };
}

function daysInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "30 روزه", callback_data: "DAYS_30" },
        { text: "60 روزه", callback_data: "DAYS_60" },
        { text: "90 روزه", callback_data: "DAYS_90" }
      ],
      [
        { text: "مدت دلخواه", callback_data: "DAYS_0" }
      ],
      [
        { text: "⬅️ برگشت", callback_data: "BACK_MAIN" }
      ]
    ]
  };
}

function backKeyboard() {
  return {
    keyboard: [
      [{ text: "⬅️ برگشت به منو" }]
    ],
    resize_keyboard: true
  };
}
