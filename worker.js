export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // تلگرام وبهوک
    if (url.pathname === "/telegram-webhook") {
      const update = await req.json();
      ctx.waitUntil(handleTelegram(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  // کرون هر 1 ساعت
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpiredSubs(env));
  }
};

// ===================== Router =====================
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

// ===================== Message Handler =====================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  // /start
  if (text === "/start") {
    return showMainMenu(env, chatId);
  }

  // اگر منتظر وارد کردن کد اشتراک هست
  if (await getUserState(env, userId) === "WAITING_CODE") {
    await setUserState(env, userId, null);
    return redeemCode(env, chatId, userId, text);
  }

  // اگر منتظر روز دلخواه ادمین هست
  if (await getUserState(env, userId) === "WAITING_ADMIN_DAYS") {
    await setUserState(env, userId, null);
    const days = parseInt(text, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return tgSendMessage(env, chatId, "❌ عدد معتبر بفرست (مثلاً 45)");
    }
    return createCodeForAdmin(env, chatId, days);
  }

  // اگر منتظر روز دلخواه کاربر هست برای ساخت کد
  if (await getUserState(env, userId) === "WAITING_CUSTOM_DAYS") {
    await setUserState(env, userId, null);
    const days = parseInt(text, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return tgSendMessage(env, chatId, "❌ عدد معتبر بفرست (مثلاً 45)");
    }
    // فقط ادمین اجازه ساخت کد دارد
    if (String(userId) !== String(env.ADMIN_ID)) {
      return tgSendMessage(env, chatId, "⛔ فقط ادمین می‌تواند کد بسازد.");
    }
    return createCodeForAdmin(env, chatId, days);
  }

  // منوی دستی
  switch (text) {
    case "✅ فعال‌سازی اشتراک VIP":
      await setUserState(env, userId, "WAITING_CODE");
      return tgSendMessage(
        env,
        chatId,
        "🔑 لطفاً کد ۳۰ رقمی اشتراک را ارسال کن:"
      );

    case "📌 وضعیت اشتراک من":
      return showMyStatus(env, chatId, userId);

    case "🧾 دریافت اشتراک کانال":
      return sendChannelInvite(env, chatId);

    case "👨‍💻 ارتباط با ادمین":
      return tgSendMessage(
        env,
        chatId,
        "برای ارتباط مستقیم روی لینک زیر بزن 👇\n" +
          `https://t.me/${env.ADMIN_USERNAME || "your_username"}`
      );

    case "🛠 ساخت کد جدید (ادمین)":
      if (String(userId) !== String(env.ADMIN_ID)) {
        return tgSendMessage(env, chatId, "⛔ فقط ادمین اجازه دارد.");
      }
      return showAdminCodeMenu(env, chatId);

    case "🗑 حذف اشتراک":
      return showDeleteMenu(env, chatId, userId);

    case "⬅️ برگشت":
      return showMainMenu(env, chatId);

    default:
      return tgSendMessage(env, chatId, "از منو انتخاب کن 👇");
  }
}

// ===================== Callback Handler =====================
async function handleCallback(cb, env) {
  const data = cb.data;
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;

  // جواب به کلیک
  await tgAnswerCallback(env, cb.id);

  // فعالسازی های پیشفرض
  if (data.startsWith("ADMIN_MAKE_")) {
    if (String(userId) !== String(env.ADMIN_ID))
      return tgSendMessage(env, chatId, "⛔ فقط ادمین.");

    const days = parseInt(data.replace("ADMIN_MAKE_", ""), 10);
    return createCodeForAdmin(env, chatId, days);
  }

  if (data === "ADMIN_CUSTOM") {
    if (String(userId) !== String(env.ADMIN_ID))
      return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    await setUserState(env, userId, "WAITING_ADMIN_DAYS");
    return tgSendMessage(env, chatId, "✍️ تعداد روز دلخواه را فقط عدد بفرست:");
  }

  if (data.startsWith("DEL_SUB_")) {
    const targetUser = parseInt(data.replace("DEL_SUB_", ""), 10);

    // فقط ادمین یا خودش اجازه حذف
    if (
      String(userId) !== String(env.ADMIN_ID) &&
      String(userId) !== String(targetUser)
    ) {
      return tgSendMessage(env, chatId, "⛔ اجازه ندارید.");
    }

    await env.DB.prepare(
      "DELETE FROM subscriptions WHERE user_id=?"
    ).bind(targetUser).run();

    return tgSendMessage(env, chatId, "✅ اشتراک حذف شد.");
  }

  return tgSendMessage(env, chatId, "❓ دستور ناشناخته");
}

// ===================== Welcome on Join =====================
async function handleChatMember(chatMemberUpdate, env) {
  const chatId = chatMemberUpdate.chat.id;
  if (String(chatId) !== String(env.CHANNEL_ID)) return;

  const newStatus = chatMemberUpdate.new_chat_member?.status;
  const user = chatMemberUpdate.new_chat_member?.user;

  if (newStatus === "member" && user) {
    await tgSendMessage(
      env,
      user.id,
      "✨ به کانال VIP **TITAN X** خوش اومدی!\n\n" +
        "اینجا می‌تونی اشتراکت رو فعال کنی و لینک ورود بگیری.\n" +
        "از /start شروع کن 👇",
      null,
      "Markdown"
    );
  }
}

// ===================== Menus =====================
async function showMainMenu(env, chatId) {
  const keyboard = {
    keyboard: [
      ["✅ فعال‌سازی اشتراک VIP"],
      ["📌 وضعیت اشتراک من"],
      ["🧾 دریافت اشتراک کانال"],
      ["👨‍💻 ارتباط با ادمین"],
      ["🛠 ساخت کد جدید (ادمین)"],
      ["🗑 حذف اشتراک"]
    ],
    resize_keyboard: true
  };

  return tgSendMessage(
    env,
    chatId,
    "🌟 به ربات VIP کانال **TITAN X** خوش اومدی!\n\n" +
      "اینجا می‌تونی:\n" +
      "• کد اشتراک رو فعال کنی ✅\n" +
      "• وضعیتتو ببینی 📌\n" +
      "• لینک ورود کانال بگیری 🧾\n" +
      "• با ادمین چت کنی 👨‍💻\n\n" +
      "از منو انتخاب کن 👇",
    keyboard,
    "Markdown"
  );
}

async function showAdminCodeMenu(env, chatId) {
  const inline = {
    inline_keyboard: [
      [
        { text: "۳۰ روزه", callback_data: "ADMIN_MAKE_30" },
        { text: "۶۰ روزه", callback_data: "ADMIN_MAKE_60" }
      ],
      [{ text: "۹۰ روزه", callback_data: "ADMIN_MAKE_90" }],
      [{ text: "مدت دلخواه", callback_data: "ADMIN_CUSTOM" }]
    ]
  };

  return tgSendMessage(
    env,
    chatId,
    "⏳ مدت اشتراک رو انتخاب کن:",
    inline
  );
}

async function showDeleteMenu(env, chatId, userId) {
  // لیست اشتراک‌ها
  const { results } = await env.DB.prepare(
    "SELECT user_id, expires_at FROM subscriptions ORDER BY expires_at DESC LIMIT 30"
  ).all();

  if (!results.length)
    return tgSendMessage(env, chatId, "هیچ اشتراکی ثبت نشده.");

  // فقط ادمین همه رو می‌بینه
  const rows = [];
  for (const s of results) {
    if (String(userId) !== String(env.ADMIN_ID) && String(userId) !== String(s.user_id))
      continue;

    rows.push([
      {
        text: `حذف اشتراک ${s.user_id}`,
        callback_data: `DEL_SUB_${s.user_id}`
      }
    ]);
  }

  if (!rows.length)
    return tgSendMessage(env, chatId, "اشتراک فعالی برای حذف نداری.");

  return tgSendMessage(
    env,
    chatId,
    "🗑 روی اشتراکی که می‌خوای حذف کنی بزن:",
    { inline_keyboard: rows }
  );
}

// ===================== Core Logic =====================
async function createCodeForAdmin(env, chatId, days) {
  const code = generate30CharCode();
  const now = Date.now();

  await env.DB.prepare(
    "INSERT INTO codes (code, days, created_at) VALUES (?, ?, ?)"
  )
    .bind(code, days, now)
    .run();

  return tgSendMessage(
    env,
    chatId,
    `✅ کد ساخته شد:\n\n<code>${code}</code>\n\n⏳ مدت: ${days} روز`,
    null,
    "HTML"
  );
}

async function redeemCode(env, chatId, userId, code) {
  const row = await env.DB.prepare(
    "SELECT code, days, used_by FROM codes WHERE code=?"
  ).bind(code).first();

  if (!row)
    return tgSendMessage(env, chatId, "❌ این کد معتبر نیست.");

  if (row.used_by)
    return tgSendMessage(env, chatId, "❌ این کد قبلاً استفاده شده.");

  const days = row.days;
  const now = Date.now();
  const expiresAt = now + days * 24 * 60 * 60 * 1000;

  // ثبت اشتراک
  await env.DB.prepare(
    "INSERT INTO subscriptions (user_id, expires_at) VALUES (?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET expires_at=?"
  )
    .bind(userId, expiresAt, expiresAt)
    .run();

  // علامت‌گذاری کد استفاده شده
  await env.DB.prepare(
    "UPDATE codes SET used_by=?, used_at=? WHERE code=?"
  )
    .bind(userId, now, code)
    .run();

  // آنبن / اد به کانال
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/unbanChatMember`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.CHANNEL_ID,
      user_id: userId,
      only_if_banned: true
    })
  });

  const invite = await tgCreateInvite(env);

  const tehranExp = new Date(expiresAt).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran"
  });

  return tgSendMessage(
    env,
    chatId,
    "✅ اشتراک فعال شد!\n\n" +
      `🗓 تاریخ پایان: ${tehranExp}\n\n` +
      `🔗 لینک ورود کانال:\n${invite}`,
    null
  );
}

async function showMyStatus(env, chatId, userId) {
  const row = await env.DB.prepare(
    "SELECT expires_at FROM subscriptions WHERE user_id=?"
  ).bind(userId).first();

  if (!row)
    return tgSendMessage(env, chatId, "هیچ اشتراک فعالی نداری.");

  const now = Date.now();
  const remainDays = Math.ceil((row.expires_at - now) / 86400000);

  const tehranExp = new Date(row.expires_at).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran"
  });

  return tgSendMessage(
    env,
    chatId,
    `📌 اشتراک فعاله ✅\n\n` +
      `⏳ باقی‌مانده: ${remainDays} روز\n` +
      `🗓 پایان اشتراک: ${tehranExp}`
  );
}

async function sendChannelInvite(env, chatId) {
  const invite = await tgCreateInvite(env);
  return tgSendMessage(
    env,
    chatId,
    `🔗 لینک ورود کانال VIP:\n${invite}`
  );
}

// ===================== Expire Cron =====================
async function checkExpiredSubs(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT user_id, expires_at FROM subscriptions"
  ).all();

  for (const s of results) {
    if (s.expires_at <= now) {
      await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: env.CHANNEL_ID,
            user_id: s.user_id,
            revoke_messages: false
          })
        }
      );

      await tgSendMessage(
        env,
        s.user_id,
        "⛔ اشتراک شما تمام شد و از کانال خارج شدید.\n" +
          "برای تمدید، کد جدید تهیه کنید."
      );

      await env.DB.prepare(
        "DELETE FROM subscriptions WHERE user_id=?"
      ).bind(s.user_id).run();
    }
  }
}

// ===================== Helpers =====================
function generate30CharCode() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  let out = "";
  const arr = new Uint8Array(30);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 30; i++) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

// state ساده داخل kv موقت (D1)
async function getUserState(env, userId) {
  const row = await env.DB.prepare(
    "SELECT state FROM user_state WHERE user_id=?"
  ).bind(userId).first();
  return row?.state || null;
}

async function setUserState(env, userId, state) {
  await env.DB.prepare(
    "INSERT INTO user_state (user_id, state) VALUES (?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET state=?"
  )
    .bind(userId, state, state)
    .run();
}

// ===================== Telegram API =====================
async function tgSendMessage(env, chatId, text, replyMarkup = null, parseMode = null) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode || "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    })
  });
}

async function tgAnswerCallback(env, callbackId) {
  return fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId })
    }
  );
}

async function tgCreateInvite(env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        member_limit: 1,
        creates_join_request: false
      })
    }
  );
  const data = await res.json();
  return data?.result?.invite_link || "خطا در ساخت لینک";
}
