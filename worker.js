export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== "POST") return new Response("OK");

      const update = await request.json();
      if (!update.message && !update.callback_query) return new Response("OK");

      const BOT_TOKEN = env.BOT_TOKEN;
      const ADMIN_ID = Number(env.ADMIN_ID);
      const CHANNEL_ID = env.CHANNEL_ID;
      const DB = env.DB;

      const api = (method, body) =>
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(r => r.json());

      // --- ensure table exists ---
      const ensureTables = async () => {
        await DB.exec(`
          CREATE TABLE IF NOT EXISTS subscriptions (
            user_id INTEGER PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            days INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS pending_actions (
            user_id INTEGER PRIMARY KEY,
            action TEXT NOT NULL,
            payload TEXT,
            created_at INTEGER NOT NULL
          );
        `);
      };
      await ensureTables();

      const now = () => Math.floor(Date.now() / 1000);

      // --- helpers ---
      const isAdmin = (id) => Number(id) === ADMIN_ID;

      const sendMainMenu = async (chatId) => {
        const keyboardUser = [
          [{ text: "✅ فعال سازی اشتراک VIP" }],
          [{ text: "📌 وضعیت اشتراک من" }],
          [{ text: "🧾 دریافت اشتراک" }],
          [{ text: "👨‍💻 ارتباط با ادمین" }],
        ];

        const keyboardAdmin = [
          [{ text: "🛠 ساخت کد جدید (ادمین)" }],
          [{ text: "📋 لیست اشتراک‌ها (ادمین)" }],
          [{ text: "🗑 حذف اشتراک (ادمین)" }],
        ];

        const kb = isAdmin(chatId)
          ? keyboardUser.concat(keyboardAdmin)
          : keyboardUser;

        await api("sendMessage", {
          chat_id: chatId,
          text:
            "به ربات VIP TITAN X خوش اومدی! 🟢\n\n" +
            "از منو انتخاب کن 👇",
          reply_markup: {
            keyboard: kb,
            resize_keyboard: true,
            one_time_keyboard: false,
          },
        });
      };

      const getSub = async (userId) => {
        const res = await DB.prepare(
          "SELECT * FROM subscriptions WHERE user_id = ?"
        ).bind(userId).first();
        return res || null;
      };

      const setSub = async (userId, days) => {
        const exp = now() + days * 86400;
        await DB.prepare(
          `INSERT INTO subscriptions (user_id, expires_at, days, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             expires_at=excluded.expires_at,
             days=excluded.days`
        ).bind(userId, exp, days, now()).run();
        return exp;
      };

      const deleteSub = async (userId) => {
        await DB.prepare("DELETE FROM subscriptions WHERE user_id=?")
          .bind(userId).run();
      };

      const fmtDate = (unix) => {
        const d = new Date(unix * 1000);
        return d.toLocaleString("fa-IR");
      };

      const setPending = async (userId, action, payloadObj = null) => {
        await DB.prepare(
          `INSERT INTO pending_actions (user_id, action, payload, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             action=excluded.action, payload=excluded.payload, created_at=excluded.created_at`
        ).bind(userId, action, payloadObj ? JSON.stringify(payloadObj) : null, now()).run();
      };

      const getPending = async (userId) => {
        return await DB.prepare(
          "SELECT * FROM pending_actions WHERE user_id=?"
        ).bind(userId).first();
      };

      const clearPending = async (userId) => {
        await DB.prepare("DELETE FROM pending_actions WHERE user_id=?")
          .bind(userId).run();
      };

      // ------------ message handling ------------
      if (update.message) {
        const chatId = update.message.chat.id;
        const text = update.message.text?.trim();

        // /start
        if (text === "/start") {
          await sendMainMenu(chatId);
          return new Response("OK");
        }

        // --- user menu ---
        if (text === "✅ فعال سازی اشتراک VIP") {
          await api("sendMessage", {
            chat_id: chatId,
            text: "مدت اشتراک رو انتخاب کن:",
            reply_markup: {
              inline_keyboard: [
                [{ text: "30 روزه", callback_data: "days_30" }],
                [{ text: "60 روزه", callback_data: "days_60" }],
                [{ text: "90 روزه", callback_data: "days_90" }],
                [{ text: "مدت دلخواه", callback_data: "days_custom" }],
              ],
            },
          });
          return new Response("OK");
        }

        if (text === "📌 وضعیت اشتراک من") {
          const sub = await getSub(chatId);
          if (!sub) {
            await api("sendMessage", {
              chat_id: chatId,
              text: "اشتراکی برات ثبت نشده ❌",
            });
          } else {
            await api("sendMessage", {
              chat_id: chatId,
              text:
                `✅ اشتراک فعال داری\n` +
                `مدت: ${sub.days} روز\n` +
                `تاریخ پایان: ${fmtDate(sub.expires_at)}`
            });
          }
          return new Response("OK");
        }

        if (text === "🧾 دریافت اشتراک") {
          const sub = await getSub(chatId);
          if (!sub) {
            await api("sendMessage", {
              chat_id: chatId,
              text: "اول اشتراک رو فعال کن.",
            });
          } else {
            await api("sendMessage", {
              chat_id: chatId,
              text:
                "اشتراک شما فعاله ✅\n" +
                "لینک/فایل‌های VIP رو از ادمین بگیر.",
            });
          }
          return new Response("OK");
        }

        if (text === "👨‍💻 ارتباط با ادمین") {
          await api("sendMessage", {
            chat_id: chatId,
            text: "برای ارتباط با ادمین پیام بده:\n@YourAdminUsername",
          });
          return new Response("OK");
        }

        // --- custom days input ---
        const pending = await getPending(chatId);
        if (pending?.action === "await_custom_days") {
          const days = Number(text);
          if (!Number.isFinite(days) || days <= 0 || days > 3650) {
            await api("sendMessage", {
              chat_id: chatId,
              text: "عدد معتبر بفرست (مثلاً 45).",
            });
            return new Response("OK");
          }
          const exp = await setSub(chatId, days);
          await clearPending(chatId);

          await api("sendMessage", {
            chat_id: chatId,
            text:
              `✅ اشتراک ${days} روزه فعال شد.\n` +
              `پایان: ${fmtDate(exp)}`,
          });
          await sendMainMenu(chatId);
          return new Response("OK");
        }

        // ------------ admin-only ------------
        if (text === "🛠 ساخت کد جدید (ادمین)" && isAdmin(chatId)) {
          await api("sendMessage", {
            chat_id: chatId,
            text: "این بخش بعداً اضافه میشه. (فعلاً placeholder)",
          });
          return new Response("OK");
        }

        if (text === "📋 لیست اشتراک‌ها (ادمین)" && isAdmin(chatId)) {
          const rows = await DB.prepare(
            "SELECT * FROM subscriptions ORDER BY expires_at DESC LIMIT 50"
          ).all();

          if (!rows.results.length) {
            await api("sendMessage", { chat_id: chatId, text: "لیست خالیه." });
            return new Response("OK");
          }

          const msg = rows.results.map(r =>
            `👤 ${r.user_id} | ${r.days} روز | تا ${fmtDate(r.expires_at)}`
          ).join("\n");

          await api("sendMessage", {
            chat_id: chatId,
            text: "📋 لیست اشتراک‌ها:\n\n" + msg
          });
          return new Response("OK");
        }

        if (text === "🗑 حذف اشتراک (ادمین)" && isAdmin(chatId)) {
          await api("sendMessage", {
            chat_id: chatId,
            text: "آیدی عددی کاربر رو بفرست تا حذف کنم (مثلاً 12345678):",
          });
          await setPending(chatId, "await_delete_userid");
          return new Response("OK");
        }

        if (pending?.action === "await_delete_userid" && isAdmin(chatId)) {
          const targetId = Number(text);
          if (!Number.isFinite(targetId)) {
            await api("sendMessage", {
              chat_id: chatId,
              text: "آیدی عددی معتبر بفرست.",
            });
            return new Response("OK");
          }

          await setPending(chatId, "confirm_delete", { targetId });

          await api("sendMessage", {
            chat_id: chatId,
            text: `واقعا اشتراک ${targetId} حذف بشه؟`,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ بله حذف کن", callback_data: "admin_del_yes" },
                  { text: "❌ نه", callback_data: "admin_del_no" }
                ]
              ]
            }
          });
          return new Response("OK");
        }

        // fallback
        await api("sendMessage", {
          chat_id: chatId,
          text: "از منو استفاده کن یا /start بزن.",
        });
        return new Response("OK");
      }

      // ------------ callback handling ------------
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message.chat.id;
        const data = cq.data;

        // user selects days
        if (data?.startsWith("days_")) {
          if (data === "days_custom") {
            await api("sendMessage", {
              chat_id: chatId,
              text: "تعداد روز دلخواه رو عددی بفرست:",
            });
            await setPending(chatId, "await_custom_days");
          } else {
            const days = Number(data.split("_")[1]);
            const exp = await setSub(chatId, days);
            await api("sendMessage", {
              chat_id: chatId,
              text:
                `✅ اشتراک ${days} روزه فعال شد.\n` +
                `پایان: ${fmtDate(exp)}`,
            });
            await sendMainMenu(chatId);
          }

          await api("answerCallbackQuery", { callback_query_id: cq.id });
          return new Response("OK");
        }

        // admin delete confirmation
        if ((data === "admin_del_yes" || data === "admin_del_no") && isAdmin(chatId)) {
          const pending = await getPending(chatId);
          const payload = pending?.payload ? JSON.parse(pending.payload) : null;
          const targetId = payload?.targetId;

          if (data === "admin_del_no") {
            await api("sendMessage", { chat_id: chatId, text: "لغو شد." });
            await clearPending(chatId);
            await api("answerCallbackQuery", { callback_query_id: cq.id });
            return new Response("OK");
          }

          if (targetId) {
            await deleteSub(targetId);
            await api("sendMessage", {
              chat_id: chatId,
              text: `✅ اشتراک ${targetId} حذف شد.`,
            });
          } else {
            await api("sendMessage", {
              chat_id: chatId,
              text: "خطا: کاربر مشخص نیست.",
            });
          }

          await clearPending(chatId);
          await api("answerCallbackQuery", { callback_query_id: cq.id });
          return new Response("OK");
        }

        await api("answerCallbackQuery", { callback_query_id: cq.id });
        return new Response("OK");
      }

      return new Response("OK");
    } catch (err) {
      return new Response("ERR: " + err.message, { status: 200 });
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const BOT_TOKEN = env.BOT_TOKEN;
      const CHANNEL_ID = env.CHANNEL_ID;
      const DB = env.DB;
      const nowTs = Math.floor(Date.now() / 1000);

      const api = (method, body) =>
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(r => r.json());

      // پیدا کردن منقضی‌ها
      const expired = await DB.prepare(
        "SELECT user_id FROM subscriptions WHERE expires_at <= ?"
      ).bind(nowTs).all();

      if (expired.results.length) {
        // حذف از دیتابیس
        await DB.prepare(
          "DELETE FROM subscriptions WHERE expires_at <= ?"
        ).bind(nowTs).run();

        // پیام به کاربرها + (اختیاری) بن/کیک از کانال
        for (const r of expired.results) {
          const uid = r.user_id;

          // پیام به کاربر
          await api("sendMessage", {
            chat_id: uid,
            text: "اشتراک شما منقضی شد ❌\nبرای تمدید از ربات اقدام کنید.",
          });

          // اگر می‌خوای از کانال هم حذف بشن اینو روشن نگه دار:
          if (CHANNEL_ID) {
            await api("banChatMember", {
              chat_id: CHANNEL_ID,
              user_id: uid,
            });
          }
        }
      }
    } catch (e) {
      // عمداً خالی
    }
  },
};
