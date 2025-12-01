export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/telegram-webhook") {
      const update = await req.json();
      ctx.waitUntil(routeTelegram(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpiredSubs(env));
  },
};

// ================= Router =================
async function routeTelegram(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message) return handleMessage(update.message, env);
  if (update.my_chat_member) return handleChatMember(update.my_chat_member, env);
}

// ================= Messages =================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    await sendWelcome(env, chatId);
    return showMainMenu(env, chatId, userId);
  }

  const st = await getUserState(env, userId);

  // Admin custom days
  if (st?.state === "WAITING_CUSTOM_DAYS" && isAdmin(userId, env)) {
    await clearUserState(env, userId);
    const days = parseInt(text, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650)
      return tgSendMessage(env, chatId, "❌ عدد معتبر نیست. مثلا 45 بفرست.");
    return createCodeForAdmin(env, chatId, days);
  }

  // User redeem code (30 chars)
  if (/^[A-Za-z0-9]{30}$/.test(text)) {
    return redeemCode(env, chatId, userId, text);
  }

  return tgSendMessage(env, chatId, "از منو یکی از گزینه‌ها رو انتخاب کن 👇");
}

// ================= Callbacks =================
async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data;

  await tgAnswerCallback(env, cb.id);

  if (data === "USER_REDEEM") {
    return tgSendMessage(env, chatId, "🔑 کد ۳۰ کاراکتری رو بفرست تا فعال کنم.");
  }

  if (data === "USER_STATUS") {
    return sendUserStatus(env, chatId, userId);
  }

  if (data === "USER_BUY" || data === "USER_CONTACT") {
    // دکمه URL در منو چت رو باز می‌کنه؛ اینجا چیز خاصی لازم نیست
    return;
  }

  if (data === "ADMIN_CREATE") {
    if (!isAdmin(userId, env)) return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    return showAdminDaysMenu(env, chatId);
  }

  if (data.startsWith("ADMIN_DAYS_")) {
    if (!isAdmin(userId, env)) return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    const days = parseInt(data.replace("ADMIN_DAYS_", ""), 10);
    return createCodeForAdmin(env, chatId, days);
  }

  if (data === "ADMIN_CUSTOM") {
    if (!isAdmin(userId, env)) return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    await setUserState(env, userId, "WAITING_CUSTOM_DAYS");
    return tgSendMessage(env, chatId, "✍️ تعداد روز دلخواه رو فقط عدد بفرست. مثلا 45");
  }

  if (data === "ADMIN_LIST_SUBS") {
    if (!isAdmin(userId, env)) return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    return adminListSubs(env, chatId);
  }

  if (data.startsWith("ADMIN_DEL_SUB:")) {
    if (!isAdmin(userId, env)) return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    const targetId = data.split(":")[1];
    return adminDeleteSub(env, chatId, targetId);
  }
}

// ================= Menus =================
async function sendWelcome(env, chatId) {
  const msg =
    "✨ به ربات VIP کانال <b>TITAN X</b> خوش اومدی!\n\n" +
    "اینجا می‌تونی اشتراک رو فعال کنی و لینک ورود یک‌بارمصرف بگیری.\n" +
    "👇 از منو انتخاب کن:";
  return tgSendMessage(env, chatId, msg);
}

async function showMainMenu(env, chatId, userId) {
  const adminUrl =
    env.ADMIN_USERNAME && env.ADMIN_USERNAME.trim()
      ? `https://t.me/${env.ADMIN_USERNAME.trim()}`
      : `tg://user?id=${env.ADMIN_ID}`;

  const keyboard = [
    [{ text: "✅ فعال‌سازی اشتراک VIP", callback_data: "USER_REDEEM" }],
    [{ text: "📌 وضعیت اشتراک من", callback_data: "USER_STATUS" }],
    [{ text: "💳 دریافت اشتراک", url: adminUrl }],
    [{ text: "👨‍💻 ارتباط با ادمین", url: adminUrl }],
  ];

  if (isAdmin(userId, env)) {
    keyboard.push([{ text: "🛠 ساخت کد جدید", callback_data: "ADMIN_CREATE" }]);
    keyboard.push([{ text: "🗑 حذف اشتراک", callback_data: "ADMIN_LIST_SUBS" }]);
  }

  return tgSendMessage(env, chatId, "📍 منو:", { inline_keyboard: keyboard });
}

async function showAdminDaysMenu(env, chatId) {
  const keyboard = [
    [
      { text: "30 روزه", callback_data: "ADMIN_DAYS_30" },
      { text: "60 روزه", callback_data: "ADMIN_DAYS_60" },
      { text: "90 روزه", callback_data: "ADMIN_DAYS_90" },
    ],
    [{ text: "مدت دلخواه", callback_data: "ADMIN_CUSTOM" }],
  ];
  return tgSendMessage(env, chatId, "⏳ مدت اشتراک رو انتخاب کن:", { inline_keyboard: keyboard });
}

// ================= Core =================
function generate30CharCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(30);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < 30; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

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
    `✅ کد VIP ساخته شد:\n\n<code>${code}</code>\n⏳ مدت: ${days} روز`,
    null,
    "HTML"
  );
}

async function redeemCode(env, chatId, userId, codeText) {
  const now = Date.now();

  const codeRow = await env.DB.prepare(
    `SELECT code, duration_days, consumed_by FROM codes WHERE code=? LIMIT 1`
  ).bind(codeText).first();

  if (!codeRow) return tgSendMessage(env, chatId, "❌ کد نامعتبره.");
  if (codeRow.consumed_by) return tgSendMessage(env, chatId, "❌ این کد قبلاً استفاده شده.");

  // تمدید یا ساخت اشتراک
  const subRow = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=? LIMIT 1`
  ).bind(userId).first();

  let base = now;
  if (subRow && subRow.expires_at > now) base = subRow.expires_at;

  const newExp = base + codeRow.duration_days * 24 * 60 * 60 * 1000;

  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, expires_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       expires_at=excluded.expires_at,
       updated_at=excluded.updated_at`
  ).bind(userId, newExp, now).run();

  await env.DB.prepare(
    `UPDATE codes SET consumed_by=?, consumed_at=? WHERE code=?`
  ).bind(userId, now, codeText).run();

  const invite = await tgCreateInvite(env);

  return tgSendMessage(
    env,
    chatId,
    "🎉 اشتراک VIP فعال شد!\n\n" +
    `📅 پایان: ${tehranDate(newExp)}\n\n` +
    `🔗 لینک ورود یک‌بارمصرف:\n${invite}\n\n` +
    "⚠️ لینک فقط یک‌بار قابل استفاده است."
  );
}

async function sendUserStatus(env, chatId, userId) {
  const subRow = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=? LIMIT 1`
  ).bind(userId).first();

  if (!subRow) return tgSendMessage(env, chatId, "شما اشتراک فعالی ندارید.");

  const exp = subRow.expires_at;
  const remainMs = exp - Date.now();
  if (remainMs <= 0) return tgSendMessage(env, chatId, "اشتراک شما تمام شده است.");

  const remainDays = Math.ceil(remainMs / (24 * 60 * 60 * 1000));
  return tgSendMessage(
    env,
    chatId,
    `✅ اشتراک فعاله\n⏳ باقی‌مانده: ${remainDays} روز\n📅 پایان: ${tehranDate(exp)}`
  );
}

// ================= Admin list / delete =================
async function adminListSubs(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions ORDER BY expires_at DESC LIMIT 50`
  ).all();

  if (!results.length) return tgSendMessage(env, chatId, "هیچ اشتراک فعالی نیست.");

  const buttons = results.map(r => [{
    text: `👤 ${r.user_id} | ⏳ تا ${tehranDate(r.expires_at)}`,
    callback_data: `ADMIN_DEL_SUB:${r.user_id}`
  }]);

  return tgSendMessage(env, chatId, "برای حذف روی کاربر بزن:", { inline_keyboard: buttons });
}

async function adminDeleteSub(env, chatId, targetUserId) {
  await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
    .bind(targetUserId).run();

  // اخراج از کانال (اختیاری)
  try {
    await tgApi(env, "banChatMember", {
      chat_id: env.CHANNEL_ID,
      user_id: Number(targetUserId),
      revoke_messages: false
    });
    await tgSendMessage(env, Number(targetUserId),
      "⛔️ اشتراک شما توسط ادمین حذف شد و دسترسی قطع گردید."
    );
  } catch {}

  return tgSendMessage(env, chatId, `✅ اشتراک کاربر ${targetUserId} حذف شد.`);
}

// ================= Cron expire check =================
async function checkExpiredSubs(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions`
  ).all();

  for (const s of results) {
    if (s.expires_at <= now) {
      try {
        await tgApi(env, "banChatMember", {
          chat_id: env.CHANNEL_ID,
          user_id: s.user_id,
          revoke_messages: false
        });

        await tgSendMessage(env, s.user_id,
          "⛔️ اشتراک VIP شما تمام شد و دسترسی‌تان قطع شد."
        );

        await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
          .bind(s.user_id).run();
      } catch {}
    }
  }
}

// ================= Join welcome =================
async function handleChatMember(upd, env) {
  const chatId = upd.chat.id;
  if (String(chatId) !== String(env.CHANNEL_ID)) return;

  const status = upd.new_chat_member?.status;
  const user = upd.new_chat_member?.user;
  if (status === "member" && user) {
    await tgSendMessage(env, user.id, "🌟 خوش اومدی به کانال VIP TITAN X!");
  }
}

// ================= States =================
async function setUserState(env, userId, state) {
  await env.DB.prepare(
    `INSERT INTO user_states (user_id, state, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`
  ).bind(userId, state, Date.now()).run();
}
async function getUserState(env, userId) {
  return env.DB.prepare(`SELECT state FROM user_states WHERE user_id=? LIMIT 1`)
    .bind(userId).first();
}
async function clearUserState(env, userId) {
  await env.DB.prepare(`DELETE FROM user_states WHERE user_id=?`).bind(userId).run();
}

// ================= Helpers =================
function isAdmin(userId, env) {
  return String(userId) === String(env.ADMIN_ID);
}
function tehranDate(ts) {
  return new Date(ts).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
}

// ================= Telegram API =================
async function tgSendMessage(env, chatId, text, replyMarkup, parseMode="HTML") {
  return tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}
async function tgAnswerCallback(env, callbackId) {
  return tgApi(env, "answerCallbackQuery", { callback_query_id: callbackId });
}
async function tgCreateInvite(env) {
  const data = await tgApi(env, "createChatInviteLink", {
    chat_id: env.CHANNEL_ID,
    member_limit: 1
  });
  return data.result.invite_link;
}
async function tgApi(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data;
}
