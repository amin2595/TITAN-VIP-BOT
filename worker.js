export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN is missing in Variables", { status: 500 });
    }

    const BOT_TOKEN = env.BOT_TOKEN;
    const ADMIN_ID = Number(env.ADMIN_ID);
    const CHANNEL_ID = String(env.CHANNEL_ID);
    const CHANNEL_LINK = env.CHANNEL_LINK || null;

    const url = new URL(request.url);
    const SECRET_PATH = `/webhook/${BOT_TOKEN}`;

    if (url.pathname === SECRET_PATH) {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

      let update;
      try { update = await request.json(); }
      catch { return new Response("Bad Request", { status: 400 }); }

      ctx.waitUntil(initTables(env));
      ctx.waitUntil(handleUpdate(update, env, BOT_TOKEN, ADMIN_ID, CHANNEL_ID, CHANNEL_LINK));
      return new Response("OK");
    }

    return new Response("Titan VIP Bot is running ✅");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
};

// ----- DB INIT -----
async function initTables(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      days INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      used_by INTEGER,
      used_at INTEGER
    );
  `);

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY,
      state TEXT
    );
  `);
}

// ----- CLEANUP -----
async function cleanupExpired(env) {
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM subscriptions WHERE expires_at <= ?`).bind(now).run();
}

// ----- TG HELPERS -----
async function tg(method, BOT_TOKEN, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ----- UPDATE HANDLER -----
async function handleUpdate(update, env, BOT_TOKEN, ADMIN_ID, CHANNEL_ID, CHANNEL_LINK) {
  const msg = update.message;
  const cbq = update.callback_query;

  if (msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || "").trim();

    if (text === "/start" || text === "منو" || text === "برگشت") {
      await clearState(env, userId);
      await sendMainMenu(chatId, BOT_TOKEN, ADMIN_ID, userId);
      return;
    }

    const state = await getState(env, userId);

    if (state === "WAIT_CODE") {
      await clearState(env, userId);
      await handleActivateCode(chatId, userId, text, env, BOT_TOKEN);
      return;
    }

    if (state === "WAIT_CUSTOM_DAYS") {
      const days = Number(text);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "❌ فقط عدد مثبت بفرست." });
        return;
      }
      await clearState(env, userId);
      await createAdminCode(chatId, days, env, BOT_TOKEN);
      return;
    }

    if (state === "WAIT_DELETE_USER") {
      const targetId = Number(text);
      if (!Number.isFinite(targetId)) {
        await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "❌ فقط آیدی عددی بفرست." });
        return;
      }
      await clearState(env, userId);
      await deleteSubscriptionById(chatId, targetId, env, BOT_TOKEN);
      return;
    }

    if (text === "✅ فعال سازی اشتراک VIP") {
      await setState(env, userId, "WAIT_CODE");
      await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "🔑 کد اشتراک رو بفرست:" });
      return;
    }

    if (text === "📌 وضعیت اشتراک من") {
      await showMyStatus(chatId, userId, env, BOT_TOKEN);
      return;
    }

    if (text === "🧾 دریافت اشتراک کانال") {
      await sendChannelLink(chatId, BOT_TOKEN, CHANNEL_ID, CHANNEL_LINK);
      return;
    }

    if (text === "👨‍💻 ارتباط با ادمین") {
      await sendAdminContact(chatId, BOT_TOKEN, ADMIN_ID);
      return;
    }

    if (text === "🛠 ساخت کد جدید (ادمین)") {
      if (userId !== ADMIN_ID) {
        await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "⛔ فقط ادمین." });
        return;
      }
      await askDuration(chatId, BOT_TOKEN);
      return;
    }

    if (text === "🗑 حذف اشتراک") {
      if (userId !== ADMIN_ID) {
        await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "⛔ فقط ادمین." });
        return;
      }
      await promptDelete(chatId, BOT_TOKEN);
      await setState(env, userId, "WAIT_DELETE_USER");
      return;
    }

    await tg("sendMessage", BOT_TOKEN, {
      chat_id: chatId,
      text: "از منو انتخاب کن 👇",
      reply_markup: mainKeyboard(ADMIN_ID, userId),
    });
  }

  if (cbq) {
    const chatId = cbq.message.chat.id;
    const userId = cbq.from.id;
    const data = cbq.data;

    await tg("answerCallbackQuery", BOT_TOKEN, { callback_query_id: cbq.id });

    if (data.startsWith("DAYS:")) {
      const days = Number(data.split(":")[1]);
      await createAdminCode(chatId, days, env, BOT_TOKEN);
      return;
    }

    if (data === "CUSTOM_DAYS") {
      await setState(env, userId, "WAIT_CUSTOM_DAYS");
      await tg("sendMessage", BOT_TOKEN, {
        chat_id: chatId,
        text: "تعداد روز دلخواه رو عددی بفرست:",
      });
      return;
    }
  }
}

// ----- MENUS -----
function mainKeyboard(ADMIN_ID, userId) {
  const buttons = [
    [{ text: "✅ فعال سازی اشتراک VIP" }],
    [{ text: "📌 وضعیت اشتراک من" }],
    [{ text: "🧾 دریافت اشتراک کانال" }],
    [{ text: "👨‍💻 ارتباط با ادمین" }],
  ];
  if (userId === ADMIN_ID) {
    buttons.push([{ text: "🛠 ساخت کد جدید (ادمین)" }]);
    buttons.push([{ text: "🗑 حذف اشتراک" }]);
  }
  return { keyboard: buttons, resize_keyboard: true };
}

async function sendMainMenu(chatId, BOT_TOKEN, ADMIN_ID, userId) {
  await tg("sendMessage", BOT_TOKEN, {
    chat_id: chatId,
    text:
      "✨ به ربات VIP TITAN X خوش اومدی!\n\n" +
      "👇 از منو انتخاب کن:",
    reply_markup: mainKeyboard(ADMIN_ID, userId),
  });
}

async function askDuration(chatId, BOT_TOKEN) {
  await tg("sendMessage", BOT_TOKEN, {
    chat_id: chatId,
    text: "⏳ مدت اشتراک رو انتخاب کن:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "30 روزه", callback_data: "DAYS:30" },
          { text: "60 روزه", callback_data: "DAYS:60" },
          { text: "90 روزه", callback_data: "DAYS:90" },
        ],
        [{ text: "مدت دلخواه", callback_data: "CUSTOM_DAYS" }],
      ],
    },
  });
}

async function sendAdminContact(chatId, BOT_TOKEN, ADMIN_ID) {
  await tg("sendMessage", BOT_TOKEN, {
    chat_id: chatId,
    text: "برای ارتباط با ادمین:",
    reply_markup: {
      inline_keyboard: [[{ text: "💬 چت با ادمین", url: `tg://user?id=${ADMIN_ID}` }]],
    },
  });
}

async function sendChannelLink(chatId, BOT_TOKEN, CHANNEL_ID, CHANNEL_LINK) {
  if (CHANNEL_LINK) {
    await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: CHANNEL_LINK });
    return;
  }

  const r = await tg("createChatInviteLink", BOT_TOKEN, { chat_id: CHANNEL_ID });
  if (!r.ok) {
    await tg("sendMessage", BOT_TOKEN, {
      chat_id: chatId,
      text: "❌ لینک نساختم. ربات باید تو کانال ادمین باشه.",
    });
    return;
  }
  await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: r.result.invite_link });
}

// ----- STATES -----
async function getState(env, userId) {
  const { results } = await env.DB.prepare(`SELECT state FROM user_state WHERE user_id=?`)
    .bind(userId)
    .all();
  return results?.[0]?.state || null;
}
async function setState(env, userId, state) {
  await env.DB.prepare(`
    INSERT INTO user_state (user_id,state) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET state=excluded.state
  `).bind(userId, state).run();
}
async function clearState(env, userId) {
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id=?`).bind(userId).run();
}

// ----- SUBS -----
async function handleActivateCode(chatId, userId, code, env, BOT_TOKEN) {
  const row = await env.DB.prepare(`SELECT code,days,used_by FROM codes WHERE code=?`)
    .bind(code).first();

  if (!row) {
    await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "❌ کد وجود نداره." });
    return;
  }
  if (row.used_by) {
    await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "❌ کد قبلاً استفاده شده." });
    return;
  }

  const now = Date.now();
  const expiresAt = now + row.days * 86400000;

  await env.DB.prepare(`
    INSERT INTO subscriptions(user_id,expires_at) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at
  `).bind(userId, expiresAt).run();

  await env.DB.prepare(`UPDATE codes SET used_by=?,used_at=? WHERE code=?`)
    .bind(userId, now, code).run();

  await tg("sendMessage", BOT_TOKEN, {
    chat_id: chatId,
    text: `✅ فعال شد تا: ${formatTehran(expiresAt)}`,
  });
}

async function showMyStatus(chatId, userId, env, BOT_TOKEN) {
  const sub = await env.DB.prepare(`SELECT expires_at FROM subscriptions WHERE user_id=?`)
    .bind(userId).first();

  if (!sub) {
    await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "هیچ اشتراک فعالی نداری." });
    return;
  }
  if (sub.expires_at <= Date.now()) {
    await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "اشتراک منقضی شده." });
    return;
  }

  await tg("sendMessage", BOT_TOKEN, {
    chat_id: chatId,
    text: `✅ اشتراک فعاله تا: ${formatTehran(sub.expires_at)}`,
  });
}

// ----- ADMIN -----
function generate30DigitCode() {
  let s = "";
  for (let i = 0; i < 30; i++) s += Math.floor(Math.random() * 10);
  return s;
}
async function createAdminCode(chatId, days, env, BOT_TOKEN) {
  const code = generate30DigitCode();
  const now = Date.now();

  await env.DB.prepare(`INSERT INTO codes(code,days,created_at) VALUES (?,?,?)`)
    .bind(code, days, now).run();

  await tg("sendMessage", BOT_TOKEN, {
    chat_id: chatId,
    parse_mode: "Markdown",
    text: `✅ کد ساخته شد:\n\`${code}\`\nمدت: ${days} روز`,
  });
}

async function promptDelete(chatId, BOT_TOKEN) {
  await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "آیدی کاربر رو بفرست:" });
}
async function deleteSubscriptionById(chatId, targetId, env, BOT_TOKEN) {
  await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`).bind(targetId).run();
  await tg("sendMessage", BOT_TOKEN, { chat_id: chatId, text: "✅ حذف شد." });
}

// ----- TEHRAN TIME -----
function formatTehran(ts) {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(ts));
}
