export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // تلگرام وبهوک را اینجا می‌زند
    if (url.pathname === "/telegram-webhook") {
      const update = await req.json();
      ctx.waitUntil(handleTelegram(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  // کران هر 6 ساعت
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

  // شروع
  if (text === "/start") {
    return showMainMenu(env, chatId, userId);
  }

  // اگر ادمین عدد روز دلخواه فرستاد
  if (String(userId) === String(env.ADMIN_ID) && /^\d+$/.test(text)) {
    const days = parseInt(text, 10);
    if (days > 0 && days <= 3650) {
      return createCodeForAdmin(env, chatId, days);
    }
  }

  // کد ۲۰ کاراکتری کاربر
  if (/^[A-Za-z0-9]{20}$/.test(text)) {
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

  // دکمه‌های کاربر
  if (data === "USER_REDEEM") {
    return tgSendMessage(env, chatId, "کد ۲۰ کاراکتری اشتراک رو همینجا بفرست 🙂");
  }

  if (data === "USER_STATUS") {
    return sendUserStatus(env, chatId, userId);
  }

  // دکمه‌های ادمین
  if (String(userId) === String(env.ADMIN_ID)) {
    if (data === "ADMIN_CREATE") {
      return showAdminDaysMenu(env, chatId);
    }

    if (data.startsWith("ADMIN_DAYS_")) {
      const days = parseInt(data.replace("ADMIN_DAYS_", ""), 10);
      return createCodeForAdmin(env, chatId, days);
    }

    if (data === "ADMIN_CUSTOM") {
      return tgSendMessage(env, chatId, "عدد روز دلخواه رو تایپ کن (مثلاً 30) و بفرست.");
    }
  }

  return;
}

// ================== Menus ==================

async function showMainMenu(env, chatId, userId) {
  const isAdmin = String(userId) === String(env.ADMIN_ID);

  const keyboard = [
    [{ text: "✅ فعال‌سازی اشتراک", callback_data: "USER_REDEEM" }],
    [{ text: "📌 وضعیت اشتراک من", callback_data: "USER_STATUS" }]
  ];

  if (isAdmin) {
    keyboard.push([{ text: "🛠 ساخت کد جدید", callback_data: "ADMIN_CREATE" }]);
  }

  return tgSendMessage(
    env,
    chatId,
    "به ربات VIP کانال TITAN X خوش اومدی!\nیکی از گزینه‌ها رو انتخاب کن:",
    { inline_keyboard: keyboard }
  );
}

async function showAdminDaysMenu(env, chatId) {
  const keyboard = [
    [
      { text: "7 روزه", callback_data: "ADMIN_DAYS_7" },
      { text: "30 روزه", callback_data: "ADMIN_DAYS_30" },
      { text: "90 روزه", callback_data: "ADMIN_DAYS_90" }
    ],
    [{ text: "دلخواه", callback_data: "ADMIN_CUSTOM" }]
  ];

  return tgSendMessage(env, chatId, "مدت اشتراک رو انتخاب کن:", {
    inline_keyboard: keyboard
  });
}

// ================== Core DB Logic ==================

async function createCodeForAdmin(env, chatId, days) {
  const code = generate20CharCode();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO codes (code, duration_days, created_at)
     VALUES (?, ?, ?)`
  ).bind(code, days, now).run();

  return tgSendMessage(
    env,
    chatId,
    `✅ کد ساخته شد:\n<code>${code}</code>\nمدت: ${days} روز`
  );
}

async function redeemCode(env, chatId, userId, codeText) {
  const codeRow = await env.DB.prepare(
    `SELECT code, duration_days, consumed_by
     FROM codes WHERE code = ?`
  ).bind(codeText).first();

  if (!codeRow) {
    return tgSendMessage(env, chatId, "❌ کد نامعتبر است.");
  }
  if (codeRow.consumed_by) {
    return tgSendMessage(env, chatId, "❌ این کد قبلاً استفاده شده.");
  }

  const now = Date.now();

  // اشتراک فعلی اگر وجود دارد
  const subRow = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id = ?`
  ).bind(userId).first();

  let base = now;
  if (subRow && subRow.expires_at > now) {
    base = subRow.expires_at;
  }

  const newExpiresAt = base + codeRow.duration_days * 24 * 60 * 60 * 1000;

  // آپدیت یا ساخت اشتراک
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, expires_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       expires_at=excluded.expires_at,
       updated_at=excluded.updated_at`
  ).bind(userId, newExpiresAt, now).run();

  // مصرف شدن کد
  await env.DB.prepare(
    `UPDATE codes SET consumed_by=?, consumed_at=? WHERE code=?`
  ).bind(userId, now, codeText).run();

  // لینک یکبار مصرف کانال
  const invite = await tgCreateInvite(env);

  await tgSendMessage(
    env,
    chatId,
    `✅ اشتراک فعال شد تا:\n${new Date(newExpiresAt).toLocaleString("fa-IR")}\n\n` +
      `🔗 لینک ورود یک‌بارمصرف به TITAN X:\n${invite}`
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
    `📌 اشتراک شما فعاله.\n` +
      `⏳ باقی‌مانده: حدود ${remainDays} روز\n` +
      `📅 تاریخ پایان: ${new Date(exp).toLocaleString("fa-IR")}`
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
      "🎉 به کانال TITAN X خوش اومدی!\nاگر سوالی داشتی همینجا بپرس."
    );
  }
}

// ================== Cron: expire check (every 6h) ==================

async function checkExpiredSubs(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions`
  ).all();

  for (const s of results) {
    if (s.expires_at <= now) {
      // اخراج از کانال
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          user_id: s.user_id,
          revoke_messages: false
        })
      });

      // پیام اتمام
      await tgSendMessage(
        env,
        s.user_id,
        "⛔️ اشتراک شما تمام شده و از کانال TITAN X خارج شدید.\nبرای تمدید، کد جدید تهیه کنید."
      );

      // حذف رکورد
      await env.DB.prepare(
        `DELETE FROM subscriptions WHERE user_id=?`
      ).bind(s.user_id).run();
    }
  }
}

// ================== Helpers ==================

function generate20CharCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  let out = "";
  const arr = new Uint8Array(20);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 20; i++) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

async function tgSendMessage(env, chatId, text, replyMarkup) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
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
        member_limit: 1,
        creates_join_request: false
      })
    }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(JSON.stringify(data));
  return data.result.invite_link;
}
