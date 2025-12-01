// Cloudflare Worker - Telegram Bot (D1)
// env vars needed in Cloudflare:
// BOT_TOKEN  = "123456:ABC..."
// ADMIN_ID   = "175438306"   // عدد آیدی تلگرام ادمین
// CHANNEL_ID = "-100..."     // اگر لازم داری (الزامی نیست)
// DB         = D1 binding name (مثلا DB)

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    // اطمینان از وجود جدول‌ها (اگر مهاجرت نکردی)
    await ensureTables(env);

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    // ---------------------------
    // 1) CALLBACK QUERY (دکمه‌ها)
    // ---------------------------
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || "";
      const fromId = String(cq.from.id);

      // فقط ادمین اجازه داره دنبال دکمه‌های ادمین بره
      const isAdmin = fromId === String(env.ADMIN_ID);

      if (data === "MENU_HOME") {
        await showHomeMenu(env, cq.message.chat.id, isAdmin);
        await answerCallback(env, cq.id);
        return new Response("OK");
      }

      if (!isAdmin && (data.startsWith("ADMIN_") || data.startsWith("DEL_"))) {
        await answerCallback(env, cq.id, "⛔️ دسترسی نداری");
        return new Response("OK");
      }

      // --- ادمین: لیست ---
      if (data === "ADMIN_LIST_SUBS") {
        await sendAdminSubsList(env, cq.message.chat.id);
        await answerCallback(env, cq.id);
        return new Response("OK");
      }

      // --- ادمین: درخواست حذف (مرحله تایید) ---
      if (data.startsWith("DEL_REQ:")) {
        const subId = data.split(":")[1];
        await sendMessage(env, cq.message.chat.id,
          `⚠️ مطمئنی این اشتراک حذف بشه؟\nID: ${subId}`,
          {
            inline_keyboard: [
              [
                { text: "✅ بله حذف کن", callback_data: `DEL_OK:${subId}` },
                { text: "❌ نه", callback_data: "ADMIN_LIST_SUBS" }
              ]
            ]
          }
        );
        await answerCallback(env, cq.id);
        return new Response("OK");
      }

      // --- ادمین: تایید حذف ---
      if (data.startsWith("DEL_OK:")) {
        const subId = data.split(":")[1];
        await env.DB.prepare(`DELETE FROM subscriptions WHERE id = ?`)
          .bind(subId)
          .run();

        await sendMessage(env, cq.message.chat.id, `✅ اشتراک ${subId} حذف شد.`);
        await answerCallback(env, cq.id);
        return new Response("OK");
      }

      await answerCallback(env, cq.id);
      return new Response("OK");
    }

    // ---------------------------
    // 2) MESSAGE
    // ---------------------------
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const fromId = String(msg.from.id);
      const text = (msg.text || "").trim();
      const isAdmin = fromId === String(env.ADMIN_ID);

      // /start
      if (text === "/start") {
        await sendMessage(env, chatId,
          "👋 خوش اومدی به ربات تایتان VIP!\n\n" +
          "✅ اگر کد اشتراک ۳۰ رقمی داری همینجا بفرست.\n" +
          "📌 منو رو از دکمه‌ها استفاده کن.",
        );
        await showHomeMenu(env, chatId, isAdmin);
        return new Response("OK");
      }

      // اگر کاربر کد 30 رقمی فرستاد
      if (/^\d{30}$/.test(text)) {
        // ذخیره کد به عنوان اشتراک جدید
        // اگر میخوای کدها فقط یک‌بار مصرف باشن،
        // باید جدول codes بسازی. فعلا ساده ذخیره می‌کنیم.
        await env.DB.prepare(
          `INSERT INTO subscriptions (user_id, code, created_at) VALUES (?, ?, ?)`
        )
          .bind(fromId, text, Date.now())
          .run();

        await sendMessage(env, chatId,
          "✅ کد دریافت شد و اشتراک ثبت شد.\n" +
          "اگر مشکلی بود به ادمین پیام بده."
        );
        await showHomeMenu(env, chatId, isAdmin);
        return new Response("OK");
      }

      // هر متن دیگه → منو
      await showHomeMenu(env, chatId, isAdmin);
      return new Response("OK");
    }

    return new Response("OK");
  }
};


// -------------------- helpers --------------------

async function ensureTables(env) {
  // اگر قبلا migration زدی، اینا کاری انجام نمیدن.
  // subscriptions: نگهداری اشتراک‌ها/کدها
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      code TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

async function showHomeMenu(env, chatId, isAdmin) {
  const keyboard = [
    [{ text: "📌 راهنما / منو", callback_data: "MENU_HOME" }],
  ];

  if (isAdmin) {
    keyboard.push([{ text: "👑 پنل ادمین", callback_data: "ADMIN_LIST_SUBS" }]);
  }

  await sendMessage(env, chatId, "گزینه‌ها:", { inline_keyboard: keyboard });
}

async function sendAdminSubsList(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, code, created_at FROM subscriptions ORDER BY id DESC LIMIT 50`
  ).all();

  if (!results || results.length === 0) {
    await sendMessage(env, chatId, "هیچ اشتراکی ثبت نشده.");
    return;
  }

  let text = "📋 لیست اشتراک‌ها:\n\n";
  const kb = [];

  for (const r of results) {
    const date = new Date(r.created_at).toLocaleString("fa-IR");
    text += `🆔 ${r.id} | 👤 ${r.user_id}\n🔑 ${r.code || "-"}\n🕒 ${date}\n\n`;

    kb.push([
      { text: `❌ حذف ${r.id}`, callback_data: `DEL_REQ:${r.id}` }
    ]);
  }

  kb.push([{ text: "🏠 برگشت به منو", callback_data: "MENU_HOME" }]);

  await sendMessage(env, chatId, text, { inline_keyboard: kb });
}

async function sendMessage(env, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function answerCallback(env, callbackQueryId, text) {
  const body = {
    callback_query_id: callbackQueryId,
    text: text || "",
    show_alert: false,
  };
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
