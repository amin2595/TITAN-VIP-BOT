// ======================
// TITAN VIP BOT - Cloudflare Worker
// Token ONLY in webhook URL
// ======================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ✅ امنیت: فقط اگر مسیر = /<TOKEN> باشد کار کن
    // توکن از Cloudflare Variable میاد
    const tokenPath = "/" + env.BOT_TOKEN;
    if (url.pathname !== tokenPath) {
      return new Response("not found", { status: 404 });
    }

    if (request.method !== "POST") return new Response("ok");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    try {
      if (update.message) {
        await onMessage(update.message, env);
      } else if (update.callback_query) {
        await onCallback(update.callback_query, env);
      }
    } catch (e) {
      console.log("ERR:", e?.message || e);
    }

    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    // فعلاً کاری نداره
  }
};

// ----------------------
// Telegram helpers
// ----------------------

const API = (env, method) =>
  `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

async function tg(env, method, body) {
  const res = await fetch(API(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(env, chat_id, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

function tehranNowFa() {
  return new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
}

function mainMenuKeyboard(isAdmin) {
  const rows = [
    [{ text: "✅ فعال سازی اشتراک VIP" }],
    [{ text: "📌 وضعیت اشتراک من" }],
    [{ text: "🧾 دریافت اشتراک کانال" }],
    [{ text: "👨‍💻 ارتباط با ادمین" }]
  ];

  if (isAdmin) rows.push([{ text: "🛠 ساخت کد جدید (ادمین)" }]);
  rows.push([{ text: "🗑 حذف اشتراک" }]);

  return {
    keyboard: rows,
    resize_keyboard: true
  };
}

function durationKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "۳۰ روزه", callback_data: "dur_30" },
        { text: "۶۰ روزه", callback_data: "dur_60" },
        { text: "۹۰ روزه", callback_data: "dur_90" }
      ],
      [{ text: "مدت دلخواه", callback_data: "dur_custom" }],
      [{ text: "برگشت ↩️", callback_data: "back_menu" }]
    ]
  };
}

function deleteMenuKeyboard(codes) {
  const rows = codes.map(c => ([
    { text: `${c.code} (${c.days} روزه)`, callback_data: `delcode_${c.code}` }
  ]));
  rows.push([{ text: "برگشت ↩️", callback_data: "back_menu" }]);
  return { inline_keyboard: rows };
}

function randomDigits(len = 30) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// ----------------------
// State (D1)
// ----------------------

async function setState(env, user_id, state) {
  await env.DB.prepare(
    `INSERT INTO user_state (user_id, state)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET state=excluded.state`
  ).bind(user_id, state).run();
}

async function getState(env, user_id) {
  const r = await env.DB.prepare(
    `SELECT state FROM user_state WHERE user_id=?`
  ).bind(user_id).first();
  return r?.state || null;
}

async function clearState(env, user_id) {
  await env.DB.prepare(`DELETE FROM user_state WHERE user_id=?`)
    .bind(user_id).run();
}

// ----------------------
// DB ops
// ----------------------

async function getSubscription(env, user_id) {
  return env.DB.prepare(
    `SELECT expires_at FROM subscriptions WHERE user_id=?`
  ).bind(user_id).first();
}

async function upsertSubscription(env, user_id, expires_at) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, expires_at)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at`
  ).bind(user_id, expires_at).run();
}

async function deleteSubscription(env, user_id) {
  await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=?`)
    .bind(user_id).run();
}

async function insertCode(env, code, days) {
  const created_at = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO codes (code, days, created_at, used_by, used_at)
     VALUES (?, ?, ?, NULL, NULL)`
  ).bind(code, days, created_at).run();
}

async function markCodeUsed(env, code, user_id) {
  const used_at = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE codes
     SET used_by=?, used_at=?
     WHERE code=? AND used_by IS NULL`
  ).bind(user_id, used_at, code).run();
}

async function getValidCode(env, code) {
  return env.DB.prepare(
    `SELECT code, days, used_by FROM codes WHERE code=?`
  ).bind(code).first();
}

async function listUnusedCodes(env) {
  const res = await env.DB.prepare(
    `SELECT code, days, created_at, used_by, used_at
     FROM codes
     WHERE used_by IS NULL
     ORDER BY created_at DESC
     LIMIT 50`
  ).all();
  return res.results || [];
}

// ----------------------
// Handlers
// ----------------------

async function onMessage(msg, env) {
  const chat_id = msg.chat.id;
  const user_id = msg.from?.id;
  const text = (msg.text || "").trim();
  const isAdmin = String(user_id) === String(env.ADMIN_ID);

  if (text === "/start") {
    await clearState(env, user_id);

    const welcome =
`✨ به ربات VIP کانال <b>TITAN X</b> خوش اومدی!

اینجا می‌تونی:
✅ اشتراک VIP رو فعال کنی
📌 وضعیت اشتراکت رو ببینی
🧾 لینک ورود به کانال بگیری
👨‍💻 با ادمین چت کنی

<b>⏰ زمان تهران:</b> ${tehranNowFa()}

از منو یکی رو انتخاب کن 👇`;

    await sendMessage(env, chat_id, welcome, {
      reply_markup: mainMenuKeyboard(isAdmin)
    });
    return;
  }

  const state = await getState(env, user_id);

  if (state === "WAIT_CODE") {
    const code = text;
    const row = await getValidCode(env, code);

    if (!row) {
      await sendMessage(env, chat_id, "❌ این کد معتبر نیست. دوباره بفرست:");
      return;
    }
    if (row.used_by) {
      await sendMessage(env, chat_id, "❌ این کد قبلاً استفاده شده.");
      await clearState(env, user_id);
      return;
    }

    const days = row.days;
    const now = Math.floor(Date.now() / 1000);
    const expires_at = now + days * 86400;

    await markCodeUsed(env, code, user_id);
    await upsertSubscription(env, user_id, expires_at);
    await clearState(env, user_id);

    await sendMessage(
      env,
      chat_id,
      `✅ اشتراک فعال شد!\n\n📆 مدت: <b>${days}</b> روز\n📌 انقضا: <b>${new Date(expires_at * 1000).toLocaleString("fa-IR",{timeZone:"Asia/Tehran"})}</b>`
    );
    return;
  }

  if (state === "ADMIN_WAIT_DAYS") {
    const days = parseInt(text, 10);
    if (!days || days <= 0) {
      await sendMessage(env, chat_id, "❌ فقط عدد روز بفرست. مثلا 45");
      return;
    }

    const code = randomDigits(30);
    await insertCode(env, code, days);
    await clearState(env, user_id);

    await sendMessage(env, chat_id,
      `✅ کد ساخته شد:\n\n<code>${code}</code>\n📆 مدت: ${days} روز`
    );
    return;
  }

  if (text === "✅ فعال سازی اشتراک VIP") {
    await setState(env, user_id, "WAIT_CODE");
    await sendMessage(env, chat_id, "🔑 کد اشتراک رو بفرست:");
    return;
  }

  if (text === "📌 وضعیت اشتراک من") {
    const sub = await getSubscription(env, user_id);
    const now = Math.floor(Date.now() / 1000);

    if (!sub || sub.expires_at <= now) {
      if (sub) await deleteSubscription(env, user_id);
      await sendMessage(env, chat_id, "❌ هیچ اشتراک فعالی نداری.");
      return;
    }

    const leftDays = Math.ceil((sub.expires_at - now) / 86400);
    await sendMessage(env, chat_id,
      `✅ اشتراک فعاله.\n⏳ باقی‌مانده: <b>${leftDays}</b> روز\n📌 انقضا: <b>${new Date(sub.expires_at*1000).toLocaleString("fa-IR",{timeZone:"Asia/Tehran"})}</b>`
    );
    return;
  }

  if (text === "🧾 دریافت اشتراک کانال") {
    const sub = await getSubscription(env, user_id);
    const now = Math.floor(Date.now() / 1000);

    if (!sub || sub.expires_at <= now) {
      await sendMessage(env, chat_id, "❌ اول اشتراک VIP رو فعال کن.");
      return;
    }

    const inviteRes = await tg(env, "createChatInviteLink", {
      chat_id: env.CHANNEL_ID,
      expire_date: now + 3600,
      member_limit: 1
    });

    if (inviteRes.ok) {
      await sendMessage(env, chat_id,
        `✅ لینک یکبارمصرف:\n\n${inviteRes.result.invite_link}\n\n⏳ اعتبار: ۱ ساعت`
      );
    } else {
      await sendMessage(env, chat_id,
        "❌ ربات ادمین کانال نیست یا دسترسی ساخت لینک نداره."
      );
    }
    return;
  }

  if (text === "👨‍💻 ارتباط با ادمین") {
    await sendMessage(env, chat_id, "روی دکمه زیر بزن 👇", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 چت با ادمین", url: `tg://user?id=${env.ADMIN_ID}` }]
        ]
      }
    });
    return;
  }

  if (text === "🛠 ساخت کد جدید (ادمین)") {
    if (!isAdmin) {
      await sendMessage(env, chat_id, "⛔️ فقط ادمین.");
      return;
    }
    await sendMessage(env, chat_id, "مدت اشتراک رو انتخاب کن:", {
      reply_markup: durationKeyboard()
    });
    return;
  }

  if (text === "🗑 حذف اشتراک") {
    if (!isAdmin) return;

    const codes = await listUnusedCodes(env);
    if (codes.length === 0) {
      await sendMessage(env, chat_id, "کدی برای حذف نیست.");
      return;
    }

    await sendMessage(env, chat_id, "کد رو انتخاب کن:", {
      reply_markup: deleteMenuKeyboard(codes)
    });
    return;
  }

  await sendMessage(env, chat_id, "از منو انتخاب کن 👇", {
    reply_markup: mainMenuKeyboard(isAdmin)
  });
}

async function onCallback(q, env) {
  const chat_id = q.message.chat.id;
  const user_id = q.from.id;
  const data = q.data || "";
  const isAdmin = String(user_id) === String(env.ADMIN_ID);

  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });

  if (data === "back_menu") {
    await clearState(env, user_id);
    await sendMessage(env, chat_id, "منوی اصلی:", {
      reply_markup: mainMenuKeyboard(isAdmin)
    });
    return;
  }

  if (data.startsWith("dur_")) {
    if (!isAdmin) return;

    if (data === "dur_custom") {
      await setState(env, user_id, "ADMIN_WAIT_DAYS");
      await sendMessage(env, chat_id, "عدد روز دلخواه رو بفرست. مثال 45");
      return;
    }

    let days = 30;
    if (data === "dur_60") days = 60;
    if (data === "dur_90") days = 90;

    const code = randomDigits(30);
    await insertCode(env, code, days);

    await sendMessage(env, chat_id,
      `✅ کد ${days} روزه:\n\n<code>${code}</code>`
    );
    return;
  }

  if (data.startsWith("delcode_")) {
    if (!isAdmin) return;
    const code = data.replace("delcode_", "");

    await env.DB.prepare(
      `DELETE FROM codes WHERE code=? AND used_by IS NULL`
    ).bind(code).run();

    await sendMessage(env, chat_id, `✅ حذف شد:\n<code>${code}</code>`);
  }
}
