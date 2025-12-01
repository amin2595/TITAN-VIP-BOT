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
    return showMainMenu(env, chatId);
  }

  const st = await getUserState(env, userId);

  if (st?.state === "WAITING_CODE") {
    await clearUserState(env, userId);
    return redeemCode(env, chatId, userId, text);
  }

  if (st?.state === "WAITING_DAYS" && String(userId) === String(env.ADMIN_ID)) {
    const days = parseInt(text, 10);
    await clearUserState(env, userId);

    if (!Number.isFinite(days) || days <= 0 || days > 3650)
      return tgSendMessage(env, chatId, "❌ عدد معتبر نیست. مثلا 30 یا 90 بفرست.");

    return createCodeForAdmin(env, chatId, days);
  }

  if (st?.state === "WAITING_CUSTOM_DAYS" && String(userId) === String(env.ADMIN_ID)) {
    const days = parseInt(text, 10);
    await clearUserState(env, userId);

    if (!Number.isFinite(days) || days <= 0 || days > 3650)
      return tgSendMessage(env, chatId, "❌ عدد معتبر نیست. مثلا 45 بفرست.");

    return createCodeForAdmin(env, chatId, days);
  }

  return tgSendMessage(env, chatId, "از منو یکی از گزینه‌ها رو انتخاب کن 👇");
}

// ================= Callback =================
async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data;

  await tgAnswerCallback(env, cb.id);

  if (data === "MENU_MAIN") return showMainMenu(env, chatId);

  if (data === "ACTIVATE_SUB") {
    await setUserState(env, userId, "WAITING_CODE");
    return tgSendMessage(env, chatId, "🔑 کد اشتراک رو بفرست:");
  }

  if (data === "MY_STATUS") return showMyStatus(env, chatId, userId);

  if (data === "GET_CHANNEL_SUB") return sendChannelInvite(env, chatId);

  if (data === "CONTACT_ADMIN") return sendAdminContact(env, chatId);

  if (data === "ADMIN_CREATE_CODE") {
    if (String(userId) !== String(env.ADMIN_ID))
      return tgSendMessage(env, chatId, "⛔ فقط ادمین دسترسی داره.");

    return showDurationMenu(env, chatId);
  }

  if (data.startsWith("DAYS_")) {
    if (String(userId) !== String(env.ADMIN_ID))
      return tgSendMessage(env, chatId, "⛔ فقط ادمین.");

    const days = parseInt(data.replace("DAYS_", ""), 10);
    return createCodeForAdmin(env, chatId, days);
  }

  if (data === "DAYS_CUSTOM") {
    if (String(userId) !== String(env.ADMIN_ID))
      return tgSendMessage(env, chatId, "⛔ فقط ادمین.");
    await setUserState(env, userId, "WAITING_CUSTOM_DAYS");
    return tgSendMessage(env, chatId, "✍️ تعداد روز دلخواه رو فقط عدد بفرست. مثلا 45");
  }

  if (data === "DELETE_SUB") return showDeleteMenu(env, chatId, userId);

  if (data.startsWith("DEL_")) {
    const subId = data.replace("DEL_", "");
    return deleteSubscription(env, chatId, userId, subId);
  }

  return tgSendMessage(env, chatId, "❓ دستور ناشناخته.");
}

// ================= UI =================
async function sendWelcome(env, chatId) {
  const msg =
    `✨ به ربات VIP کانال <b>TITAN X</b> خوش اومدی!\n\n` +
    `اینجا می‌تونی اشتراک رو فعال کنی، وضعیتش رو ببینی یا لینک ورود VIP بگیری.\n\n` +
    `👇 از منو یکی رو انتخاب کن.`;
  return tgSendMessage(env, chatId, msg);
}

async function showMainMenu(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "✅ فعال‌سازی اشتراک VIP", callback_data: "ACTIVATE_SUB" }],
      [{ text: "📌 وضعیت اشتراک من", callback_data: "MY_STATUS" }],
      [{ text: "🧾 دریافت اشتراک کانال", callback_data: "GET_CHANNEL_SUB" }],
      [{ text: "👨‍💻 ارتباط با ادمین", callback_data: "CONTACT_ADMIN" }],
      [{ text: "🛠 ساخت کد جدید (ادمین)", callback_data: "ADMIN_CREATE_CODE" }],
      [{ text: "🗑 حذف اشتراک", callback_data: "DELETE_SUB" }],
    ],
  };

  return tgSendMessage(env, chatId, "📍 منوی اصلی:", keyboard);
}

async function showDurationMenu(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "30 روزه", callback_data: "DAYS_30" },
        { text: "60 روزه", callback_data: "DAYS_60" },
        { text: "90 روزه", callback_data: "DAYS_90" },
      ],
      [{ text: "مدت دلخواه", callback_data: "DAYS_CUSTOM" }],
      [{ text: "⬅️ برگشت", callback_data: "MENU_MAIN" }],
    ],
  };

  return tgSendMessage(env, chatId, "⏳ مدت اشتراک رو انتخاب کن:", keyboard);
}

// ================= Code Generator (30 chars) =================
function generate30CharCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(30);
  crypto.getRandomValues(arr);

  let out = "";
  for (let i = 0; i < 30; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

async function createCodeForAdmin(env, chatId, days) {
  try {
    const code = generate30CharCode();
    const now = Date.now();
    const exp = now + days * 24 * 60 * 60 * 1000;

    await env.DB.prepare(
      `INSERT INTO codes (code, days, expires_at, created_at, used)
       VALUES (?, ?, ?, ?, 0)`
    ).bind(code, days, exp, now).run();

    const tehranExp = new Date(exp).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });

    return tgSendMessage(
      env,
      chatId,
      `✅ کد ${days} روزه ساخته شد:\n\n<code>${code}</code>\n\n🗓 پایان: ${tehranExp}`
    );
  } catch (e) {
    return tgSendMessage(env, chatId, `❌ خطا در ساخت کد:\n${e.message || e}`);
  }
}

// ================= Redeem =================
async function redeemCode(env, chatId, userId, codeText) {
  try {
    const now = Date.now();

    const row = await env.DB.prepare(
      `SELECT code, days, expires_at, used
       FROM codes WHERE code=? LIMIT 1`
    ).bind(codeText).first();

    if (!row) return tgSendMessage(env, chatId, "❌ کد نامعتبره.");
    if (row.used) return tgSendMessage(env, chatId, "❌ این کد قبلاً استفاده شده.");
    if (row.expires_at && row.expires_at < now)
      return tgSendMessage(env, chatId, "❌ این کد منقضی شده.");

    const subExp = now + row.days * 24 * 60 * 60 * 1000;

    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, expires_at, created_at)
       VALUES (?, ?, ?)`
    ).bind(userId, subExp, now).run();

    await env.DB.prepare(
      `UPDATE codes SET used=1, used_by=?, used_at=? WHERE code=?`
    ).bind(userId, now, codeText).run();

    const invite = await tgCreateInvite(env);
    const tehranExp = new Date(subExp).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });

    return tgSendMessage(
      env,
      chatId,
      `🎉 اشتراک فعال شد!\n\n⏳ اعتبار تا: ${tehranExp}\n\n🔗 لینک ورود VIP:\n${invite}`
    );
  } catch (e) {
    return tgSendMessage(env, chatId, `❌ خطا:\n${e.message || e}`);
  }
}

// ================= Status =================
async function showMyStatus(env, chatId, userId) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, expires_at FROM subscriptions
     WHERE user_id=? AND expires_at>? ORDER BY expires_at DESC`
  ).bind(userId, now).all();

  if (!rows.results.length)
    return tgSendMessage(env, chatId, "⛔ اشتراک فعالی نداری.");

  const latest = rows.results[0];
  const remainDays = Math.ceil((latest.expires_at - now) / (24 * 60 * 60 * 1000));
  const tehranExp = new Date(latest.expires_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });

  return tgSendMessage(
    env,
    chatId,
    `✅ اشتراک فعاله\n\n📅 پایان: ${tehranExp}\n⏳ باقی‌مانده: ${remainDays} روز`
  );
}

// ================= Delete Subs =================
async function showDeleteMenu(env, chatId, userId) {
  const rows = await env.DB.prepare(
    `SELECT id, expires_at FROM subscriptions WHERE user_id=? ORDER BY expires_at DESC`
  ).bind(userId).all();

  if (!rows.results.length)
    return tgSendMessage(env, chatId, "هیچ اشتراکی برای حذف نداری.");

  const keyboard = {
    inline_keyboard: rows.results.map(r => {
      const exp = new Date(r.expires_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
      return [{ text: `🗑 حذف اشتراک تا ${exp}`, callback_data: `DEL_${r.id}` }];
    }).concat([[{ text: "⬅️ برگشت", callback_data: "MENU_MAIN" }]])
  };

  return tgSendMessage(env, chatId, "کدوم اشتراک حذف بشه؟", keyboard);
}

async function deleteSubscription(env, chatId, userId, subId) {
  const row = await env.DB.prepare(
    `SELECT id FROM subscriptions WHERE id=? AND user_id=?`
  ).bind(subId, userId).first();

  if (!row) return tgSendMessage(env, chatId, "❌ پیدا نشد.");

  await env.DB.prepare(`DELETE FROM subscriptions WHERE id=?`).bind(subId).run();
  return tgSendMessage(env, chatId, "✅ اشتراک حذف شد.");
}

// ================= Invite + Admin chat =================
async function sendChannelInvite(env, chatId) {
  try {
    const invite = await tgCreateInvite(env);
    return tgSendMessage(env, chatId, `🔗 لینک ورود VIP:\n${invite}`);
  } catch {
    return tgSendMessage(env, chatId, "❌ لینک ساخته نشد. ربات باید ادمین کانال باشه.");
  }
}

async function sendAdminContact(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "💬 چت با ادمین", url: `tg://user?id=${env.ADMIN_ID}` }],
      [{ text: "⬅️ برگشت", callback_data: "MENU_MAIN" }]
    ]
  };
  return tgSendMessage(env, chatId, "برای چت مستقیم با ادمین بزن 👇", keyboard);
}

// ================= Join channel welcome =================
async function handleChatMember(upd, env) {
  const chatId = upd.chat.id;
  if (String(chatId) !== String(env.CHANNEL_ID)) return;

  const status = upd.new_chat_member?.status;
  const user = upd.new_chat_member?.user;

  if (status === "member" && user) {
    await tgSendMessage(env, user.id, "🎉 خوش اومدی به کانال VIP TITAN X!");
  }
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
          "⛔ اشتراک تموم شد و از کانال خارج شدی.\nبرای تمدید کد جدید بگیر."
        );

        await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
          .bind(s.user_id).run();
      } catch {}
    }
  }
}

// ================= States =================
async function setUserState(env, userId, state) {
  await env.DB.prepare(
    `INSERT INTO user_states (user_id, state, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
     SET state=excluded.state, updated_at=excluded.updated_at`
  ).bind(userId, state, Date.now()).run();
}

async function getUserState(env, userId) {
  try {
    return await env.DB.prepare(
      `SELECT state FROM user_states WHERE user_id=? LIMIT 1`
    ).bind(userId).first();
  } catch {
    return null;
  }
}

async function clearUserState(env, userId) {
  await env.DB.prepare(`DELETE FROM user_states WHERE user_id=?`)
    .bind(userId).run();
}

// ================= Telegram Helpers =================
async function tgSendMessage(env, chatId, text, replyMarkup) {
  return tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}

async function tgAnswerCallback(env, callbackId) {
  return tgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackId
  });
}

async function tgCreateInvite(env) {
  const data = await tgApi(env, "createChatInviteLink", {
    chat_id: env.CHANNEL_ID,
    member_limit: 1,
    creates_join_request: false
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
