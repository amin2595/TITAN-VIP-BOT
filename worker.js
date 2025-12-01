export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // فقط همین مسیر وبهوک رو قبول می‌کنیم
    if (url.pathname === "/telegram-webhook") {
      const update = await req.json();
      ctx.waitUntil(handleTelegram(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  // کران (هر ۱ ساعت) — باید تو داشبورد Trigger event براش بذاری
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpiredSubs(env));
  }
};

// ======================= Telegram Router =======================
async function handleTelegram(update, env) {
  try {
    if (update.callback_query) return handleCallback(update.callback_query, env);
    if (update.message) return handleMessage(update.message, env);
    if (update.my_chat_member) return handleChatMember(update.my_chat_member, env);
  } catch (e) {
    // برای جلوگیری از خاموش شدن Worker
    console.log("handleTelegram error:", e);
  }
}

// ======================= Message Handler =======================
async function handleMessage(msg, env) {
  await ensureTables(env);

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  // دستور start
  if (text === "/start") {
    await clearUserState(env, userId);
    return showMainMenu(env, chatId);
  }

  // دریافت وضعیت استیت کاربر
  const state = await getUserState(env, userId);

  // اگر منتظر کد فعال‌سازی هستیم
  if (state === "await_code") {
    await clearUserState(env, userId);
    return redeemCode(env, chatId, userId, text);
  }

  // اگر ادمین منتظر انتخاب روز هست
  if (state === "admin_await_days") {
    if (!isAdmin(env, userId)) return;

    const days = parseInt(text, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return tgSendMessage(
        env,
        chatId,
        "❌ عدد معتبر نیست. یک عدد بین 1 تا 3650 بفرست."
      );
    }

    await clearUserState(env, userId);
    return createCodeForAdmin(env, chatId, days);
  }

  // ======================= دکمه‌های منو =======================
  switch (text) {
    case "✅ فعال‌سازی اشتراک VIP":
      await setUserState(env, userId, "await_code");
      return tgSendMessage(
        env,
        chatId,
        "🔑 لطفاً کد اشتراک ۳۰ کاراکتری رو ارسال کن:"
      );

    case "📌 وضعیت اشتراک من":
      return showMyStatus(env, chatId, userId);

    case "🧾 دریافت اشتراک کانال":
      return sendMyInvite(env, chatId, userId);

    case "👨‍💻 ارتباط با ادمین":
      return contactAdmin(env, chatId);

    case "🛠 ساخت کد جدید (ادمین)":
      if (!isAdmin(env, userId)) {
        return tgSendMessage(env, chatId, "⛔ فقط ادمین اجازه این بخش رو داره.");
      }
      return showAdminDaysMenu(env, chatId, userId);

    case "🗑 حذف اشتراک":
      return deleteMySubscription(env, chatId, userId);

    case "🏠 منوی اصلی":
      return showMainMenu(env, chatId);

    default:
      // اگر کاربر چیزی بی‌ربط زد
      return tgSendMessage(env, chatId, "از منو استفاده کن 👇", mainMenuKeyboard());
  }
}

// ======================= Callback Handler =======================
async function handleCallback(cb, env) {
  await ensureTables(env);

  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data;

  // جواب به callback برای حذف لودینگ تلگرام
  await tgAnswerCallback(env, cb.id);

  // انتخاب روزهای پیش‌فرض (ادمین)
  if (data.startsWith("ADMIN_DAYS_")) {
    if (!isAdmin(env, userId)) return;
    const days = parseInt(data.replace("ADMIN_DAYS_", ""), 10);
    return createCodeForAdmin(env, chatId, days);
  }

  // مدت دلخواه (ادمین)
  if (data === "ADMIN_CUSTOM_DAYS") {
    if (!isAdmin(env, userId)) return;
    await setUserState(env, userId, "admin_await_days");
    return tgSendMessage(env, chatId, "✍️ تعداد روز دلخواه رو فقط به صورت عدد بفرست.\nمثلاً: 45");
  }
}

// ======================= Chat Member Handler =======================
async function handleChatMember(chatMemberUpdate, env) {
  const chatId = chatMemberUpdate.chat.id;

  // فقط روی کانال VIP خودت
  if (String(chatId) !== String(env.CHANNEL_ID)) return;

  const newStatus = chatMemberUpdate.new_chat_member?.status;
  const user = chatMemberUpdate.new_chat_member?.user;

  if (newStatus === "member" && user) {
    await tgSendMessage(
      env,
      user.id,
      "✨ به ربات VIP کانال *TITAN X* خوش اومدی!\n\n" +
        "اینجا می‌تونی:\n" +
        "✅ اشتراکت رو فعال کنی\n" +
        "📌 وضعیت اشتراکت رو ببینی\n" +
        "🧾 لینک ورود کانال رو بگیری\n" +
        "👨‍💻 با ادمین چت کنی\n\n" +
        "از منوی زیر یکی رو انتخاب کن 👇",
      mainMenuKeyboard(true)
    );
  }
}

// ======================= Menus =======================
function mainMenuKeyboard(hideHome = false) {
  const keyboard = [
    ["✅ فعال‌سازی اشتراک VIP"],
    ["📌 وضعیت اشتراک من"],
    ["🧾 دریافت اشتراک کانال"],
    ["👨‍💻 ارتباط با ادمین"],
    ["🗑 حذف اشتراک"]
  ];

  // دکمه ادمین جدا
  keyboard.push(["🛠 ساخت کد جدید (ادمین)"]);

  if (!hideHome) keyboard.push(["🏠 منوی اصلی"]);

  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true,
      one_time_keyboard: false,
      selective: false
    }
  };
}

async function showMainMenu(env, chatId) {
  return tgSendMessage(
    env,
    chatId,
    "✨ به ربات VIP کانال *TITAN X* خوش اومدی!\n\n" +
      "اینجا می‌تونی:\n" +
      "✅ کد اشتراک رو فعال کنی\n" +
      "📌 وضعیت اشتراکت رو ببینی\n" +
      "🧾 لینک ورود کانال رو بگیری\n" +
      "👨‍💻 با ادمین چت کنی\n\n" +
      "👇 از منو انتخاب کن:",
    mainMenuKeyboard(true)
  );
}

async function showAdminDaysMenu(env, chatId) {
  const inline = {
    inline_keyboard: [
      [
        { text: "۳۰ روزه", callback_data: "ADMIN_DAYS_30" },
        { text: "۶۰ روزه", callback_data: "ADMIN_DAYS_60" },
        { text: "۹۰ روزه", callback_data: "ADMIN_DAYS_90" }
      ],
      [{ text: "مدت دلخواه", callback_data: "ADMIN_CUSTOM_DAYS" }]
    ]
  };

  return tgSendMessage(
    env,
    chatId,
    "⏳ مدت اشتراک رو انتخاب کن:",
    { reply_markup: inline }
  );
}

// ======================= Subscription Logic =======================
async function redeemCode(env, chatId, userId, codeInput) {
  const codeRow = await env.DB.prepare(
    `SELECT code, days, used_by FROM codes WHERE code=?`
  ).bind(codeInput).first();

  if (!codeRow) {
    return tgSendMessage(env, chatId, "❌ این کد وجود نداره.");
  }
  if (codeRow.used_by) {
    return tgSendMessage(env, chatId, "⚠️ این کد قبلاً استفاده شده.");
  }

  const now = Date.now();
  const expiresAt = now + codeRow.days * 24 * 60 * 60 * 1000;

  // ثبت اشتراک
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, expires_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at`
  ).bind(userId, expiresAt).run();

  // مصرف کد
  await env.DB.prepare(
    `UPDATE codes SET used_by=?, used_at=? WHERE code=?`
  ).bind(userId, now, codeInput).run();

  const invite = await tgCreateInvite(env, expiresAt);

  return tgSendMessage(
    env,
    chatId,
    "✅ اشتراک شما فعال شد!\n\n" +
      `⏳ مدت: ${codeRow.days} روز\n` +
      `📅 اعتبار تا: ${formatTehran(expiresAt)}\n\n` +
      "🔗 لینک ورود کانال:",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 ورود به کانال VIP", url: invite }]]
      }
    }
  );
}

async function showMyStatus(env, chatId, userId) {
  const sub = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=?`
  ).bind(userId).first();

  if (!sub) {
    return tgSendMessage(env, chatId, "❌ هیچ اشتراک فعالی نداری.");
  }

  const now = Date.now();
  const remainingMs = sub.expires_at - now;

  if (remainingMs <= 0) {
    await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`).bind(userId).run();
    return tgSendMessage(env, chatId, "❌ اشتراک شما منقضی شده.");
  }

  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));

  return tgSendMessage(
    env,
    chatId,
    "📌 وضعیت اشتراک شما:\n\n" +
      `✅ فعال\n` +
      `⏳ روزهای باقی‌مانده: ${remainingDays}\n` +
      `📅 تاریخ انقضا: ${formatTehran(sub.expires_at)}`
  );
}

async function sendMyInvite(env, chatId, userId) {
  const sub = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=?`
  ).bind(userId).first();

  if (!sub || sub.expires_at <= Date.now()) {
    return tgSendMessage(env, chatId, "❌ اشتراک فعالی نداری.");
  }

  const invite = await tgCreateInvite(env, sub.expires_at);

  return tgSendMessage(
    env,
    chatId,
    "🔗 لینک ورود اختصاصی شما به کانال:",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 ورود به کانال VIP", url: invite }]]
      }
    }
  );
}

async function deleteMySubscription(env, chatId, userId) {
  await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
    .bind(userId).run();

  return tgSendMessage(env, chatId, "🗑 اشتراک شما حذف شد.");
}

// ======================= Admin Code Creation =======================
async function createCodeForAdmin(env, chatId, days) {
  const code = generateCode(30);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO codes (code, days, created_at, used_by, used_at)
     VALUES (?, ?, ?, NULL, NULL)`
  ).bind(code, days, now).run();

  return tgSendMessage(
    env,
    chatId,
    "✅ کد جدید ساخته شد:\n\n" +
      `🔑 <code>${code}</code>\n` +
      `⏳ مدت: ${days} روز\n` +
      `🕒 زمان ساخت: ${formatTehran(now)}`,
    { parse_mode: "HTML" }
  );
}

// ======================= Cron: expire check =======================
async function checkExpiredSubs(env) {
  await ensureTables(env);

  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions`
  ).all();

  for (const s of results) {
    if (s.expires_at <= now) {
      // بن از کانال
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          user_id: s.user_id,
          revoke_messages: false
        })
      });

      // پیام به کاربر
      await tgSendMessage(
        env,
        s.user_id,
        "⛔️ اشتراک شما تمام شد و از کانال خارج شدید.\n" +
          "برای تمدید، کد جدید تهیه کنید."
      );

      // حذف رکورد
      await env.DB.prepare(
        `DELETE FROM subscriptions WHERE user_id=?`
      ).bind(s.user_id).run();
    }
  }
}

// ======================= Helpers =======================
function generateCode(len = 30) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789";
  let out = "";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

function isAdmin(env, userId) {
  return String(userId) === String(env.ADMIN_ID);
}

function formatTehran(ts) {
  return new Date(ts).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ======================= State =======================
async function getUserState(env, userId) {
  const row = await env.DB.prepare(
    `SELECT state FROM user_state WHERE user_id=?`
  ).bind(userId).first();
  return row?.state || null;
}

async function setUserState(env, userId, state) {
  await env.DB.prepare(
    `INSERT INTO user_state (user_id, state) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET state=excluded.state`
  ).bind(userId, state).run();
}

async function clearUserState(env, userId) {
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id=?`)
    .bind(userId).run();
}

// ======================= DB Init =======================
async function ensureTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      days INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      used_by INTEGER,
      used_at INTEGER
    );
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER PRIMARY KEY,
      state TEXT
    );
  `).run();
}

// ======================= Telegram API Helpers =======================
async function tgSendMessage(env, chatId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode || "Markdown",
    disable_web_page_preview: true,
    ...extra
  };

  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function tgAnswerCallback(env, callbackId) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId })
  });
}

async function tgCreateInvite(env, expiresAt) {
  // زمان انقضا به ثانیه
  const expireDate = Math.floor(expiresAt / 1000);

  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHANNEL_ID,
        expire_date: expireDate,
        member_limit: 1,
        creates_join_request: false
      })
    }
  );

  const j = await res.json();
  if (!j.ok) throw new Error("createChatInviteLink failed: " + JSON.stringify(j));

  return j.result.invite_link;
}

async function contactAdmin(env, chatId) {
  // deep-link مستقیم به چت ادمین (موبایل کار می‌کند)
  const url = `tg://user?id=${env.ADMIN_ID}`;

  return tgSendMessage(
    env,
    chatId,
    "برای ارتباط مستقیم با ادمین روی دکمه زیر بزن 👇",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "👨‍💻 چت با ادمین", url }]]
      }
    }
  );
}
