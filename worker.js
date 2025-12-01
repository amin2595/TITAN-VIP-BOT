export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/telegram-webhook") {
      const update = await req.json();
      ctx.waitUntil(handleTelegram(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  // Cron (every 1h)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpiredSubs(env));
  }
};

// ===================== Helpers =====================
const TG_API = (env) => `https://api.telegram.org/bot${env.BOT_TOKEN}`;

function tehranNowTs() {
  return Date.now();
}
function tehranNowString() {
  return new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
}
function fmtDateTehran(ts) {
  return new Date(ts).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
}

function replyKeyboard(buttonRows, extra = {}) {
  return {
    keyboard: buttonRows,
    resize_keyboard: true,
    one_time_keyboard: false,
    ...extra
  };
}

function inlineKeyboard(buttonRows) {
  return { inline_keyboard: buttonRows };
}

async function tgSendMessage(env, chatId, text, replyMarkup) {
  return fetch(`${TG_API(env)}/sendMessage`, {
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

async function tgAnswerCallback(env, callbackId, text) {
  return fetch(`${TG_API(env)}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text,
      show_alert: false
    })
  });
}

function generate30CharCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(30);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < 30; i++) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

// ================== DB init ==================
async function ensureTables(env) {
  // codes: code TEXT, days INTEGER, created_at INTEGER, used_by INTEGER, used_at INTEGER
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

// ===================== Telegram Router =====================
async function handleTelegram(update, env) {
  await ensureTables(env);

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

// ===================== Chat Member (welcome DM) =====================
async function handleChatMember(chatMemberUpdate, env) {
  const chatId = chatMemberUpdate.chat.id;
  if (String(chatId) !== String(env.CHANNEL_ID)) return;

  const newStatus = chatMemberUpdate.new_chat_member?.status;
  const user = chatMemberUpdate.new_chat_member?.user;

  if (newStatus === "member" && user) {
    await tgSendMessage(
      env,
      user.id,
      `✨ خوش اومدی به <b>TITAN X VIP</b>!\n\nاگه سوالی داشتی همینجا پیام بده 👇`,
      null
    );
  }
}

// ===================== Main Menu =====================
function mainMenuMarkup() {
  return replyKeyboard([
    ["✅ فعال‌سازی اشتراک VIP"],
    ["📌 وضعیت اشتراک من"],
    ["🧾 دریافت اشتراک کانال"],
    ["👨‍💻 ارتباط با ادمین"],
    ["🛠 ساخت کد جدید (ادمین)"],
    ["🗑 حذف اشتراک (ادمین)"]
  ]);
}

async function showMainMenu(env, chatId) {
  const text =
`🌟 به ربات <b>TITAN X VIP</b> خوش اومدی!

اینجا می‌تونی:
✅ کد اشتراک رو فعال کنی  
📌 وضعیت اشتراک رو ببینی  
🧾 لینک ورود کانال رو بگیری  
👨‍💻 با ادمین چت کنی  

⏰ زمان تهران: <b>${tehranNowString()}</b>

از منو انتخاب کن 👇`;

  await tgSendMessage(env, chatId, text, mainMenuMarkup());
}

// ===================== User State =====================
async function setState(env, userId, state) {
  await env.DB.prepare(`
    INSERT INTO user_state(user_id, state)
    VALUES(?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state=excluded.state
  `).bind(userId, state).run();
}
async function getState(env, userId) {
  const row = await env.DB.prepare(`SELECT state FROM user_state WHERE user_id=?`)
    .bind(userId).first();
  return row?.state || null;
}
async function clearState(env, userId) {
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id=?`)
    .bind(userId).run();
}

// ===================== Handle Message =====================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    await clearState(env, userId);
    return showMainMenu(env, chatId);
  }

  // if awaiting something:
  const state = await getState(env, userId);
  if (state === "await_code") {
    return processCodeActivation(env, chatId, userId, text);
  }
  if (state === "admin_custom_days") {
    return processAdminCustomDays(env, chatId, userId, text);
  }

  // menu actions
  switch (text) {
    case "✅ فعال‌سازی اشتراک VIP":
      await setState(env, userId, "await_code");
      return tgSendMessage(
        env,
        chatId,
        "🔑 کد اشتراکت رو ارسال کن:",
        replyKeyboard([["↩️ برگشت"]])
      );

    case "📌 وضعیت اشتراک من":
      return showMyStatus(env, chatId, userId);

    case "🧾 دریافت اشتراک کانال":
      return sendChannelInviteIfActive(env, chatId, userId);

    case "👨‍💻 ارتباط با ادمین":
      return contactAdmin(env, chatId);

    case "🛠 ساخت کد جدید (ادمین)":
      if (String(userId) !== String(env.ADMIN_ID)) {
        return tgSendMessage(env, chatId, "⛔️ این بخش فقط برای ادمینه.", mainMenuMarkup());
      }
      return showAdminCodeMenu(env, chatId);

    case "🗑 حذف اشتراک (ادمین)":
      if (String(userId) !== String(env.ADMIN_ID)) {
        return tgSendMessage(env, chatId, "⛔️ این بخش فقط برای ادمینه.", mainMenuMarkup());
      }
      return showDeleteSubsMenu(env, chatId);

    case "↩️ برگشت":
    case "برگشت":
      await clearState(env, userId);
      return showMainMenu(env, chatId);

    default:
      // if admin typed digits directly => quick create that many days
      if (String(userId) === String(env.ADMIN_ID) && /^\d+$/.test(text)) {
        const days = parseInt(text, 10);
        if (days > 0 && days <= 3650) {
          return createCodeForAdmin(env, chatId, days);
        }
      }
      return tgSendMessage(env, chatId, "از منو استفاده کن 👇", mainMenuMarkup());
  }
}

// ===================== Activation Flow =====================
async function processCodeActivation(env, chatId, userId, codeText) {
  if (!codeText || codeText.length < 5) {
    return tgSendMessage(env, chatId, "کد نامعتبره. دوباره بفرست:", null);
  }

  const codeRow = await env.DB.prepare(
    `SELECT code, days, used_by FROM codes WHERE code=?`
  ).bind(codeText).first();

  if (!codeRow) {
    return tgSendMessage(env, chatId, "❌ این کد وجود نداره یا اشتباهه.", mainMenuMarkup());
  }
  if (codeRow.used_by) {
    return tgSendMessage(env, chatId, "❌ این کد قبلاً استفاده شده.", mainMenuMarkup());
  }

  const now = tehranNowTs();
  const expiresAt = now + codeRow.days * 24 * 60 * 60 * 1000;

  // upsert subscription
  await env.DB.prepare(`
    INSERT INTO subscriptions(user_id, expires_at)
    VALUES(?, ?)
    ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at
  `).bind(userId, expiresAt).run();

  // mark code used
  await env.DB.prepare(`
    UPDATE codes SET used_by=?, used_at=? WHERE code=?
  `).bind(userId, now, codeText).run();

  await clearState(env, userId);

  await tgSendMessage(
    env,
    chatId,
    `✅ اشتراک شما با موفقیت فعال شد!\n\n📅 مدت: <b>${codeRow.days} روز</b>\n⏳ اعتبار تا: <b>${fmtDateTehran(expiresAt)}</b>\n\n🧾 حالا می‌تونی لینک کانال رو بگیری.`,
    mainMenuMarkup()
  );

  // auto send invite
  return sendChannelInviteIfActive(env, chatId, userId);
}

// ===================== Status =====================
async function showMyStatus(env, chatId, userId) {
  const row = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=?`
  ).bind(userId).first();

  const now = tehranNowTs();
  if (!row || row.expires_at <= now) {
    return tgSendMessage(env, chatId, "❌ هیچ اشتراک فعالی نداری.", mainMenuMarkup());
  }

  const leftMs = row.expires_at - now;
  const leftDays = Math.ceil(leftMs / (24*60*60*1000));

  return tgSendMessage(
    env,
    chatId,
    `✅ اشتراک شما فعاله.\n\n⏳ باقی‌مانده: <b>${leftDays} روز</b>\n📅 اعتبار تا: <b>${fmtDateTehran(row.expires_at)}</b>\n⏰ زمان تهران: <b>${tehranNowString()}</b>`,
    mainMenuMarkup()
  );
}

// ===================== Invite Link =====================
async function createInviteLink(env) {
  const res = await fetch(`${TG_API(env)}/createChatInviteLink`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.CHANNEL_ID,
      member_limit: 1,
      creates_join_request: false
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "create invite failed");
  return data.result.invite_link;
}

async function sendChannelInviteIfActive(env, chatId, userId) {
  const row = await env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=?`
  ).bind(userId).first();

  const now = tehranNowTs();
  if (!row || row.expires_at <= now) {
    return tgSendMessage(env, chatId, "❌ اشتراک فعالی نداری. اول فعالش کن.", mainMenuMarkup());
  }

  const link = await createInviteLink(env);
  return tgSendMessage(
    env,
    chatId,
    `🧾 لینک ورود اختصاصی شما آماده‌ست:\n\n${link}\n\n(لینک یکبار مصرفه)`,
    mainMenuMarkup()
  );
}

// ===================== Contact Admin =====================
async function contactAdmin(env, chatId) {
  const adminId = env.ADMIN_ID;
  const markup = inlineKeyboard([
    [{ text: "💬 باز کردن چت با ادمین", url: `tg://user?id=${adminId}` }]
  ]);

  return tgSendMessage(
    env,
    chatId,
    "برای ارتباط مستقیم با ادمین روی دکمه زیر بزن:",
    markup
  );
}

// ===================== Admin: Code generation menu =====================
async function showAdminCodeMenu(env, chatId) {
  const markup = inlineKeyboard([
    [
      { text: "30 روز", callback_data: "mkcode:30" },
      { text: "60 روز", callback_data: "mkcode:60" },
      { text: "90 روز", callback_data: "mkcode:90" }
    ],
    [{ text: "مدت دلخواه", callback_data: "mkcode:custom" }],
    [{ text: "↩️ برگشت", callback_data: "back_main" }]
  ]);

  return tgSendMessage(env, chatId, "⏳ مدت اشتراک رو انتخاب کن:", markup);
}

async function processAdminCustomDays(env, chatId, userId, text) {
  if (!/^\d+$/.test(text)) {
    return tgSendMessage(env, chatId, "فقط عدد بفرست. مثلا: 45", null);
  }
  const days = parseInt(text, 10);
  if (days <= 0 || days > 3650) {
    return tgSendMessage(env, chatId, "عدد معتبر نیست (1 تا 3650).", null);
  }
  await clearState(env, userId);
  return createCodeForAdmin(env, chatId, days);
}

async function createCodeForAdmin(env, chatId, days) {
  const code = generate30CharCode();
  const now = tehranNowTs();

  await env.DB.prepare(`
    INSERT INTO codes(code, days, created_at)
    VALUES(?, ?, ?)
  `).bind(code, days, now).run();

  return tgSendMessage(
    env,
    chatId,
    `✅ کد جدید ساخته شد:\n\n<code>${code}</code>\n\n📅 مدت: <b>${days} روز</b>\n⏰ زمان تهران: <b>${tehranNowString()}</b>`,
    mainMenuMarkup()
  );
}

// ===================== Admin: Delete subscriptions =====================
async function showDeleteSubsMenu(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions ORDER BY expires_at DESC LIMIT 20`
  ).all();

  if (!results || results.length === 0) {
    return tgSendMessage(env, chatId, "هیچ اشتراکی برای حذف وجود نداره.", mainMenuMarkup());
  }

  const buttons = results.map(r => ([
    {
      text: `❌ حذف ${r.user_id} (تا ${fmtDateTehran(r.expires_at)})`,
      callback_data: `delsub:${r.user_id}`
    }
  ]));

  buttons.push([{ text: "↩️ برگشت", callback_data: "back_main" }]);

  return tgSendMessage(
    env,
    chatId,
    "لیست اشتراک‌ها (برای حذف روی هر کدوم بزن):",
    inlineKeyboard(buttons)
  );
}

// ===================== Handle Callback =====================
async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data || "";

  if (data === "back_main") {
    await tgAnswerCallback(env, cb.id, "برگشت");
    return showMainMenu(env, chatId);
  }

  if (data.startsWith("mkcode:")) {
    if (String(userId) !== String(env.ADMIN_ID)) {
      await tgAnswerCallback(env, cb.id, "فقط ادمین");
      return;
    }
    const val = data.split(":")[1];
    if (val === "custom") {
      await tgAnswerCallback(env, cb.id, "عدد روز را بفرست");
      await setState(env, userId, "admin_custom_days");
      return tgSendMessage(env, chatId, "تعداد روز دلخواه را فقط عدد بفرست. مثلا 45", null);
    } else {
      const days = parseInt(val, 10);
      await tgAnswerCallback(env, cb.id, "ساخت کد...");
      return createCodeForAdmin(env, chatId, days);
    }
  }

  if (data.startsWith("delsub:")) {
    if (String(userId) !== String(env.ADMIN_ID)) {
      await tgAnswerCallback(env, cb.id, "فقط ادمین");
      return;
    }
    const targetId = parseInt(data.split(":")[1], 10);
    await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
      .bind(targetId).run();

    await tgAnswerCallback(env, cb.id, "حذف شد");
    return tgSendMessage(env, chatId, `✅ اشتراک ${targetId} حذف شد.`, mainMenuMarkup());
  }

  await tgAnswerCallback(env, cb.id, "انجام شد");
}

// ===================== Cron: Expire check =====================
async function checkExpiredSubs(env) {
  const now = tehranNowTs();

  const { results } = await env.DB.prepare(
    `SELECT user_id, expires_at FROM subscriptions`
  ).all();

  for (const s of results) {
    if (s.expires_at <= now) {
      // remove from channel
      await fetch(`${TG_API(env)}/banChatMember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHANNEL_ID,
          user_id: s.user_id,
          revoke_messages: false
        })
      });

      // notify user
      await tgSendMessage(
        env,
        s.user_id,
        `⛔️ اشتراک شما به پایان رسیده و از کانال حذف شدید.\nبرای تمدید، کد جدید تهیه کنید.`,
        null
      );

      // delete record
      await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
        .bind(s.user_id).run();
    }
  }
}
