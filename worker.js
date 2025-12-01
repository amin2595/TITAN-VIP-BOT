export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== "POST") {
        return new Response("OK", { status: 200 });
      }

      const update = await request.json();
      if (!update.message && !update.callback_query) {
        return new Response("OK", { status: 200 });
      }

      const BOT_TOKEN = env.BOT_TOKEN;
      const ADMIN_ID = Number(env.ADMIN_ID);
      const CHANNEL_ID = env.CHANNEL_ID;
      const DB = env.DB;

      const api = (method, body) =>
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const sendMessage = (chat_id, text, extra = {}) =>
        api("sendMessage", { chat_id, text, ...extra });

      const answerCb = (cb_id) =>
        api("answerCallbackQuery", { callback_query_id: cb_id });

      const nowSec = () => Math.floor(Date.now() / 1000);

      // -------------------------
      // Ensure tables exist
      // -------------------------
      async function ensureTables() {
        await DB.exec(`
          CREATE TABLE IF NOT EXISTS subscriptions (
            user_id INTEGER PRIMARY KEY,
            expires_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS codes (
            code TEXT PRIMARY KEY,
            days INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            used_by INTEGER,
            used_at INTEGER
          );

          CREATE TABLE IF NOT EXISTS user_state (
            user_id INTEGER PRIMARY KEY,
            state TEXT
          );
        `);
      }
      await ensureTables();

      // -------------------------
      // Keyboards
      // -------------------------
      function userKeyboard() {
        return {
          keyboard: [
            [{ text: "✅ فعال سازی اشتراک VIP" }],
            [{ text: "📌 وضعیت اشتراک من" }],
            [{ text: "🧾 فعالسازی با کد اشتراک" }],
            [{ text: "👨‍💻 ارتباط با ادمین" }],
          ],
          resize_keyboard: true,
          one_time_keyboard: false,
        };
      }

      function adminKeyboard() {
        return {
          keyboard: [
            [{ text: "✅ فعال سازی اشتراک VIP" }],
            [{ text: "📌 وضعیت اشتراک من" }],
            [{ text: "🧾 فعالسازی با کد اشتراک" }],
            [{ text: "👨‍💻 ارتباط با ادمین" }],
            [{ text: "🛠 ساخت کد جدید (ادمین)" }],
            [{ text: "📋 لیست اشتراک‌ها (ادمین)" }],
            [{ text: "🗑 حذف اشتراک کاربر (ادمین)" }],
          ],
          resize_keyboard: true,
          one_time_keyboard: false,
        };
      }

      function daysInlineKeyboard() {
        return {
          inline_keyboard: [
            [
              { text: "30 روزه", callback_data: "days_30" },
              { text: "60 روزه", callback_data: "days_60" },
              { text: "90 روزه", callback_data: "days_90" },
            ],
            [{ text: "مدت دلخواه", callback_data: "days_custom" }],
          ],
        };
      }

      function confirmDeleteKeyboard(targetId) {
        return {
          inline_keyboard: [
            [
              { text: "✅ تایید حذف", callback_data: `del_yes_${targetId}` },
              { text: "❌ لغو", callback_data: "del_no" },
            ],
          ],
        };
      }

      // -------------------------
      // /start (welcome + hide admin buttons)
      // -------------------------
      if (update.message?.text?.startsWith("/start")) {
        const chatId = update.message.chat.id;
        const userId = update.message.from.id;

        const kb = (userId === ADMIN_ID) ? adminKeyboard() : userKeyboard();

        ctx.waitUntil(
          sendMessage(
            chatId,
            "✨ به ربات VIP کانال <b>TITAN X</b> خوش اومدی! 👋\n\n" +
              "از منو انتخاب کن 👇",
            { parse_mode: "HTML", reply_markup: kb }
          )
        );

        return new Response("OK");
      }

      // -------------------------
      // Callback queries (buttons)
      // -------------------------
      if (update.callback_query) {
        const cq = update.callback_query;
        const data = cq.data;
        const chatId = cq.message.chat.id;
        const userId = cq.from.id;

        ctx.waitUntil(answerCb(cq.id));

        // انتخاب روزها برای فعال‌سازی
        if (data.startsWith("days_")) {
          if (data === "days_custom") {
            await DB.prepare(
              "INSERT OR REPLACE INTO user_state (user_id, state) VALUES (?, ?)"
            ).bind(userId, "awaiting_custom_days").run();

            ctx.waitUntil(
              sendMessage(chatId, "تعداد روز دلخواه رو فقط عددی بفرست (مثلا 45):")
            );
            return new Response("OK");
          }

          const days = Number(data.split("_")[1]); // 30/60/90
          const expiresAt = nowSec() + days * 86400;

          await DB.prepare(
            "INSERT OR REPLACE INTO subscriptions (user_id, expires_at) VALUES (?, ?)"
          ).bind(userId, expiresAt).run();

          ctx.waitUntil(
            sendMessage(chatId, `✅ اشتراک ${days} روزه فعال شد.`)
          );
          return new Response("OK");
        }

        // تایید حذف برای ادمین
        if (data.startsWith("del_yes_")) {
          if (userId !== ADMIN_ID) return new Response("OK");

          const targetId = Number(data.replace("del_yes_", ""));
          await DB.prepare("DELETE FROM subscriptions WHERE user_id=?")
            .bind(targetId)
            .run();

          ctx.waitUntil(sendMessage(chatId, `✅ اشتراک کاربر ${targetId} حذف شد.`));
          return new Response("OK");
        }

        if (data === "del_no") {
          ctx.waitUntil(sendMessage(chatId, "لغو شد."));
          return new Response("OK");
        }

        return new Response("OK");
      }

      // -------------------------
      // Normal messages
      // -------------------------
      const text = update.message?.text?.trim();
      const chatId = update.message?.chat?.id;
      const userId = update.message?.from?.id;

      if (!text || !chatId || !userId) return new Response("OK");

      const isAdmin = (userId === ADMIN_ID);

      // ---- فعالسازی VIP با انتخاب مدت
      if (text === "✅ فعال سازی اشتراک VIP") {
        ctx.waitUntil(
          sendMessage(chatId, "مدت اشتراک رو انتخاب کن:", {
            reply_markup: daysInlineKeyboard(),
          })
        );
        return new Response("OK");
      }

      // ---- وضعیت اشتراک من
      if (text === "📌 وضعیت اشتراک من") {
        const sub = await DB.prepare(
          "SELECT expires_at FROM subscriptions WHERE user_id=?"
        ).bind(userId).first();

        if (!sub) {
          ctx.waitUntil(sendMessage(chatId, "❌ هیچ اشتراک فعالی نداری."));
          return new Response("OK");
        }

        const remain = sub.expires_at - nowSec();
        if (remain <= 0) {
          ctx.waitUntil(sendMessage(chatId, "⚠️ اشتراک شما منقضی شده."));
          return new Response("OK");
        }

        const daysLeft = Math.ceil(remain / 86400);
        ctx.waitUntil(
          sendMessage(chatId, `✅ اشتراک فعاله.\n⏳ باقی‌مانده: ${daysLeft} روز`)
        );
        return new Response("OK");
      }

      // ---- فعالسازی با کد اشتراک (کاربر کد می‌فرسته)
      if (text === "🧾 فعالسازی با کد اشتراک") {
        await DB.prepare(
          "INSERT OR REPLACE INTO user_state (user_id, state) VALUES (?, ?)"
        ).bind(userId, "awaiting_code").run();

        ctx.waitUntil(sendMessage(chatId, "کد اشتراک رو بفرست:"));
        return new Response("OK");
      }

      // ---- ارتباط با ادمین
      if (text === "👨‍💻 ارتباط با ادمین") {
        ctx.waitUntil(
          sendMessage(chatId, "برای ارتباط با ادمین روی آیدی زیر پیام بده:\n@TitanAdmin")
        );
        return new Response("OK");
      }

      // ---- ساخت کد جدید (ادمین)
      if (text === "🛠 ساخت کد جدید (ادمین)") {
        if (!isAdmin) return new Response("OK");

        await DB.prepare(
          "INSERT OR REPLACE INTO user_state (user_id, state) VALUES (?, ?)"
        ).bind(userId, "admin_awaiting_days").run();

        ctx.waitUntil(sendMessage(chatId, "تعداد روز کد جدید رو بفرست (مثلا 30):"));
        return new Response("OK");
      }

      // ---- لیست اشتراک‌ها (ادمین)
      if (text === "📋 لیست اشتراک‌ها (ادمین)") {
        if (!isAdmin) return new Response("OK");

        const rows = await DB.prepare(
          "SELECT user_id, expires_at FROM subscriptions ORDER BY expires_at DESC"
        ).all();

        if (!rows.results || rows.results.length === 0) {
          ctx.waitUntil(sendMessage(chatId, "هیچ اشتراکی ثبت نشده."));
          return new Response("OK");
        }

        const now = nowSec();
        const msg = rows.results.map((r, i) => {
          const left = r.expires_at - now;
          const daysLeft = Math.max(0, Math.ceil(left / 86400));
          const status = left > 0 ? "فعال" : "منقضی";
          return `${i + 1}) ${r.user_id} — ${status} — ${daysLeft} روز`;
        }).join("\n");

        ctx.waitUntil(sendMessage(chatId, "📋 لیست اشتراک‌ها:\n\n" + msg));
        return new Response("OK");
      }

      // ---- حذف اشتراک کاربر (ادمین) با تایید
      if (text === "🗑 حذف اشتراک کاربر (ادمین)") {
        if (!isAdmin) return new Response("OK");

        await DB.prepare(
          "INSERT OR REPLACE INTO user_state (user_id, state) VALUES (?, ?)"
        ).bind(userId, "admin_awaiting_delete_id").run();

        ctx.waitUntil(sendMessage(chatId, "آیدی عددی کاربر رو بفرست تا حذفش کنم:"));
        return new Response("OK");
      }

      // -------------------------
      // Handle states
      // -------------------------
      const stateRow = await DB.prepare(
        "SELECT state FROM user_state WHERE user_id=?"
      ).bind(userId).first();

      const state = stateRow?.state;

      // مدت دلخواه برای کاربر
      if (state === "awaiting_custom_days") {
        const days = Number(text);
        if (!days || days <= 0) {
          ctx.waitUntil(sendMessage(chatId, "عدد درست بفرست مثلا 15"));
          return new Response("OK");
        }

        const expiresAt = nowSec() + days * 86400;
        await DB.prepare(
          "INSERT OR REPLACE INTO subscriptions (user_id, expires_at) VALUES (?, ?)"
        ).bind(userId, expiresAt).run();

        await DB.prepare("DELETE FROM user_state WHERE user_id=?")
          .bind(userId).run();

        ctx.waitUntil(sendMessage(chatId, `✅ اشتراک ${days} روزه فعال شد.`));
        return new Response("OK");
      }

      // کاربر کد اشتراک می‌فرسته
      if (state === "awaiting_code") {
        const code = text;

        const row = await DB.prepare(
          "SELECT code, days, used_by FROM codes WHERE code=?"
        ).bind(code).first();

        if (!row) {
          ctx.waitUntil(sendMessage(chatId, "❌ این کد معتبر نیست."));
          return new Response("OK");
        }
        if (row.used_by) {
          ctx.waitUntil(sendMessage(chatId, "⚠️ این کد قبلاً استفاده شده."));
          return new Response("OK");
        }

        const expiresAt = nowSec() + row.days * 86400;

        await DB.prepare(
          "INSERT OR REPLACE INTO subscriptions (user_id, expires_at) VALUES (?, ?)"
        ).bind(userId, expiresAt).run();

        await DB.prepare(
          "UPDATE codes SET used_by=?, used_at=? WHERE code=?"
        ).bind(userId, nowSec(), code).run();

        await DB.prepare("DELETE FROM user_state WHERE user_id=?")
          .bind(userId).run();

        ctx.waitUntil(sendMessage(chatId, `✅ اشتراک ${row.days} روزه فعال شد.`));
        return new Response("OK");
      }

      // ادمین روز کد جدید می‌فرسته
      if (state === "admin_awaiting_days") {
        if (!isAdmin) return new Response("OK");

        const days = Number(text);
        if (!days || days <= 0) {
          ctx.waitUntil(sendMessage(chatId, "عدد روز درست بفرست مثلا 30"));
          return new Response("OK");
        }

        const code =
          "TITAN-" +
          Math.random().toString(36).substring(2, 6).toUpperCase() +
          Math.random().toString(36).substring(2, 6).toUpperCase();

        await DB.prepare(
          "INSERT INTO codes (code, days, created_at) VALUES (?, ?, ?)"
        ).bind(code, days, nowSec()).run();

        await DB.prepare("DELETE FROM user_state WHERE user_id=?")
          .bind(userId).run();

        ctx.waitUntil(
          sendMessage(chatId, `✅ کد ساخته شد:\n\n${code}\n\n⏳ مدت: ${days} روز`)
        );
        return new Response("OK");
      }

      // ادمین آیدی کاربر برای حذف می‌فرسته
      if (state === "admin_awaiting_delete_id") {
        if (!isAdmin) return new Response("OK");

        const targetId = Number(text);
        if (!Number.isFinite(targetId)) {
          ctx.waitUntil(sendMessage(chatId, "فقط آیدی عددی بفرست."));
          return new Response("OK");
        }

        await DB.prepare("DELETE FROM user_state WHERE user_id=?")
          .bind(userId).run();

        ctx.waitUntil(
          sendMessage(
            chatId,
            `می‌خوای اشتراک کاربر ${targetId} حذف بشه؟`,
            { reply_markup: confirmDeleteKeyboard(targetId) }
          )
        );
        return new Response("OK");
      }

      // چیز ناشناخته
      const kb = isAdmin ? adminKeyboard() : userKeyboard();
      ctx.waitUntil(sendMessage(chatId, "از منو انتخاب کن 👇", { reply_markup: kb }));

      return new Response("OK");

    } catch (err) {
      return new Response("ERR: " + err.message, { status: 200 });
    }
  },

  // -------------------------
  // Cron: پاکسازی منقضی‌شده‌ها
  // -------------------------
  async scheduled(event, env, ctx) {
    try {
      const DB = env.DB;
      const now = Math.floor(Date.now() / 1000);

      await DB.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          user_id INTEGER PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);

      await DB.prepare(
        "DELETE FROM subscriptions WHERE expires_at <= ?"
      ).bind(now).run();

    } catch (e) {}
  },
};
