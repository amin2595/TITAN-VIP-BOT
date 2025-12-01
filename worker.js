export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Telegram webhook endpoint
    if (url.pathname === "/telegram-webhook") {
      const update = await req.json();
      ctx.waitUntil(handleTelegram(update, env));
      return new Response("ok");
    }

    // Optional health check
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("Titan VIP Bot is alive ✅");
    }

    return new Response("not found", { status: 404 });
  },

  // Cron every 1 hour
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpiredSubs(env));
  }
};

// ================== Telegram Router ==================

async function handleTelegram(update, env) {
  if (update.callback_query) {
    return handleCallback(update.callback_query, env);
  }
  if (update.message) {
    return handleMessage(update.message, env);
  }
  if (update.chat_member) {
    return handleChatMember(update.chat_member, env);
  }
}

// ================== Messages ==================

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    return showMainMenu(env, chatId, userId);
  }

  // Admin: send number for custom days
  if (isAdmin(userId, env) && /^\d+$/.test(text)) {
    const days = parseInt(text, 10);
    if (days > 0 && days <= 3650) {
      return createCodeForAdmin(env, chatId, days);
    }
  }

  // User: send 30-char code
  if (/^[A-Za-z0-9]{30}$/.test(text)) {
    return redeemCode(env, chatId, userId, text);
  }

  return showMainMenu(env, chatId, userId);
}

// ================== Buttons (Callbacks) ==================

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data;

  await tgAnswerCallback(env, cb.id);

  // -------- User buttons --------
  if (data === "USER_REDEEM") {
    return tgSendMessage(env, chatId, "🔑 کد ۳۰ کاراکتری اشتراک رو همینجا بفرست تا فعالش کنم 🙂");
  }

  if (data === "USER_STATUS") {
    return sendUserStatus(env, chatId, userId);
  }

  // -------- Admin buttons --------
  if (isAdmin(userId, env)) {
    if (data === "ADMIN_CREATE") {
      return showAdminDaysMenu(env, chatId);
    }

    if (data.startsWith("ADMIN_DAYS_")) {
      const days = parseInt(data.replace("ADMIN_DAYS_", ""), 10);
      return createCodeForAdmin(env, chatId, days);
    }

    if (data === "ADMIN_CUSTOM") {
      return tgSendMessage(env, chatId, "✍️ تعداد روز دلخواه رو فقط به صورت عدد بفرست.\nمثلاً: 45");
    }

    if (data === "ADMIN_LIST_SUBS") {
      return adminListSubs(env, chatId);
    }

    if (data.startsWith("ADMIN_DEL_SUB:")) {
      const targetId = data.split(":")[1];
      return adminDeleteSub(env, chatId, targetId, cb.id);
    }
  }

  return;
}

// ================== Menus ==================

async function showMainMenu(env, chatId, userId) {
  // Admin chat URL button
  const adminUrl =
    env.ADMIN_USERNAME && env.ADMIN_USERNAME.trim()
      ? `https://t.me/${env.ADMIN_USERNAME.trim()}`
      : `tg://user?id=${env.ADMIN_ID}`;

  const keyboard = [
    [{ text: "✅ فعال‌سازی اشتراک VIP", callback_data: "USER_REDEEM" }],
    [{ text: "📌 وضعیت اشتراک من", callback_data: "USER_STATUS" }],
    [{ text: "💳 دریافت اشتراک کانال", url: adminUrl }],
    [{ text: "👨‍💻 ارتباط با ادمین", url: adminUrl }]
  ];

  if (isAdmin(userId, env)) {
    keyboard.push([{ text: "🛠 ساخت کد جدید", callback_data: "ADMIN_CREATE" }]);
    keyboard.push([{ text: "🗑 حذف اشتراک", callback_data: "ADMIN_LIST_SUBS" }]);
  }

  const welcome =
    "✨ به ربات VIP کانال **TITAN X** خوش اومدی!\n\n" +
    "اینجا می‌تونی اشتراکت رو فعال کنی و لینک ورود یک‌بارمصرف بگیری.\n" +
    "یکی از گزینه‌ها رو انتخاب کن 👇";

  return tgSendMessage(env, chatId, welcome, { inline_keyboard: keyboard });
}

async function showAdminDaysMenu(env, chatId) {
  const keyboard = [
    [
      { text: "30 روزه", callback_data: "ADMIN_DAYS_30" },
      { text: "60 روزه", callback_data: "ADMIN_DAYS_60" },
      { text: "90 روزه", callback_data: "ADMIN_DAYS_90" }
    ],
    [{ text: "مدت دلخواه", callback_data: "ADMIN_CUSTOM" }]
  ];

  return tgSendMessage(env, chatId, "⏳ مدت اشتراک رو انتخاب کن:", {
    inline_keyboard: keyboard
  });
}

// ================== Core DB Logic ==================

async function createCodeForAdmin(env, chatId, days) {
  const code = generate30CharCode();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO codes (code, duration_days, created_at, consumed_by, consumed_at)
     VALUES (?, ?, ?, NULL, NULL)`
  ).bind(code, days, now).run();

  return tgSendMessage(
    env,
    chatId,
    `✅ کد VIP ساخته شد:\n<code>${code}</code>\n⏳ مدت: ${days} روز`,
    null,
    "HTML"
  );
}

async function redeemCode(env, chatId, userId, codeText) {
  const codeRow = await env.DB.prepare(
    `SELECT code, duration_days, consumed_by
     FROM codes WHERE code = ?`
  ).bind(codeText).first();

  if (!codeRow) {
    return tgSendMessage(env, chatId, "❌ کد نامعتبره یا اشتباه وارد شده.");
  }
  if (codeRow.consumed_by) {
    return tgSendMessage(env, chatId, "❌ این کد قبلاً استفاده شده.");
  }

  const now = Date.now();

  const subRow = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id = ?`
  ).bind(userId).first();

  let base = now;
  if (subRow && subRow.expires_at > now) {
    base = subRow.expires_at; // extend
  }

  const newExpiresAt = base + codeRow.duration_days * 24 * 60 * 60 * 1000;

  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, expires_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       expires_at=excluded.expires_at,
       updated_at=excluded.updated_at`
  ).bind(userId, newExpiresAt, now).run();

  await env.DB.prepare(
    `UPDATE codes SET consumed_by=?, consumed_at=? WHERE code=?`
  ).bind(userId, now, codeText).run();

  const invite = await tgCreateInvite(env);

  await tgSendMessage(
    env,
    chatId,
    "🎉 اشتراک VIP شما فعال شد!\n\n" +
    `📅 تاریخ پایان: ${tehranDate(newExpiresAt)}\n\n` +
    `🔗 لینک ورود یک‌بارمصرف به کانال TITAN X:\n${invite}\n\n` +
    "⚠️ این لینک فقط یک بار قابل استفاده است."
  );

  return showMainMenu(env, chatId, userId);
}

async function sendUserStatus(env, chatId, userId) {
  const subRow = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id = ?`
  ).bind(userId).first();

  if (!subRow) {
    return tgSendMessage(env, chatId, "شما اشتراک فعالی ندارید.");
  }

  const exp = subRow.expires_at;
  const remainMs = exp - Date.now();

  if (remainMs <= 0) {
    return tgSendMessage(env, chatId, "اشتراک شما تمام شده است.");
  }

  const remainDays = Math.ceil(remainMs / (24 * 60 * 60 * 1000));
  return tgSendMessage(
    env,
    chatId,
    `✅ اشتراک شما فعاله.\n` +
    `⏳ باقی‌مانده: حدود ${remainDays} روز\n` +
    `📅 تاریخ پایان: ${tehranDate(exp)}`
  );
}

// ================== Welcome on Join ==================

async function handleChatMember(chatMemberUpdate, env) {
  const chatId = chatMemberUpdate.chat.id;
  if (String(chatId) !== String(env.CHANNEL_ID)) return;

  const newStatus = chatMemberUpdate.new_chat_member?.status;
  const user = chatMemberUpdate.new_chat_member?.user;

  if (newStatus === "member" && user) {
    await tgSendMessage(
      env,
      user.id,
      "🌟 خوش اومدی به کانال **TITAN X**!\n\n" +
      "از امروز عضوی از جمع VIP ما هستی 🚀\n" +
      "اگر سوالی داشتی، همینجا بهم پیام بده."
    );
  }
}

// ================== Cron: expire check ==================

async function checkExpiredSubs(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions`
  ).all();

  for (const s of results) {
    if (s.expires_at <= now) {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          user_id: s.user_id,
          revoke_messages: false
        })
      });

      await tgSendMessage(
        env,
        s.user_id,
        "⛔️ اشتراک VIP شما تمام شد و دسترسی‌تان قطع شد.\n" +
        "برای تمدید، با ادمین در ارتباط باشید."
      );

      await env.DB.prepare(
        `DELETE FROM subscriptions WHERE user_id=?`
      ).bind(s.user_id).run();
    }
  }
}

// ================= Admin: list / delete subs =================

async function adminListSubs(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions
     ORDER BY expires_at DESC
     LIMIT 50`
  ).all();

  if (!results || results.length === 0) {
    return tgSendMessage(env, chatId, "هیچ اشتراک فعالی پیدا نشد.");
  }

  const buttons = results.map((r) => {
    const expText = tehranDate(r.expires_at);
    return [{
      text: `👤 ${r.user_id} | ⏳ تا ${expText}`,
      callback_data: `ADMIN_DEL_SUB:${r.user_id}`
    }];
  });

  return tgSendMessage(
    env,
    chatId,
    "لیست اشتراک‌های فعال (برای حذف روی هرکدوم بزن):",
    { inline_keyboard: buttons }
  );
}

async function adminDeleteSub(env, chatId, targetUserId, callbackId) {
  await env.DB.prepare(
    `DELETE FROM subscriptions WHERE user_id=?`
  ).bind(targetUserId).run();

  await tgAnswerCallback(env, callbackId, "✅ اشتراک حذف شد");
  await tgSendMessage(env, chatId, `✅ اشتراک کاربر ${targetUserId} حذف شد.`);

  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        user_id: Number(targetUserId),
        revoke_messages: false
      })
    });

    await tgSendMessage(
      env,
      Number(targetUserId),
      "⛔️ اشتراک شما توسط ادمین حذف شد و دسترسی‌تان قطع گردید."
    );
  } catch (e) {}
}

// ================== Helpers ==================

function isAdmin(userId, env) {
  return String(userId) === String(env.ADMIN_ID);
}

function tehranDate(ts) {
  return new Date(ts).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
}

// 30-char code generator
function generate30CharCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  let out = "";
  const arr = new Uint8Array(30);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 30; i++) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

async function tgSendMessage(env, chatId, text, replyMarkup, parseMode = "Markdown") {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    })
  });
}

async function tgAnswerCallback(env, callbackId) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId })
  });
}

async function tgCreateInvite(env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        member_limit: 1
      })
    }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(JSON.stringify(data));
  return data.result.invite_link;
}
