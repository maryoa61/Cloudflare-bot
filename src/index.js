import { Bot, InlineKeyboard } from "grammy";

export default {
  async fetch(request, env) {
    const bot = new Bot(env.BOT_TOKEN);

    // --- میدلور بررسی عضویت در کانال ---
    bot.use(async (ctx, next) => {
      if (!ctx.from) return next();
      const userId = ctx.from.id;
      
      // ذخیره کاربر در دیتابیس
      const userExists = await env.DB.prepare("SELECT user_id FROM users WHERE user_id = ?").bind(userId).first();
      if (!userExists) {
        await env.DB.prepare("INSERT INTO users (user_id, username) VALUES (?, ?)").bind(userId, ctx.from.username || "None").run();
      }

      // بررسی عضویت در کانال
      try {
        const member = await bot.api.getChatMember(env.CHANNEL_ID, userId);
        if (member.status === "left" || member.status === "kicked") {
          const keyboard = new InlineKeyboard().url("عضویت در کانال 📢", `https://t.me/${env.CHANNEL_ID.replace('@', '')}`).url("تایید عضویت ✅", `https://t.me/${bot.botInfo.username}?start=verify`);
          return ctx.reply("برای استفاده از ربات، ابتدا در کانال ما عضو شوید:", { reply_markup: keyboard });
        }
      } catch (e) {
        console.error("Channel check error:", e);
      }
      return next();
    });

    // --- دستور /start ---
    bot.command("start", async (ctx) => {
      const keyboard = new InlineKeyboard()
        .text("🛒 فروشگاه", "shop")
        .text("👤 پنل مدیریت", "admin");
      
      if (ctx.from.id.toString() === env.ADMIN_ID) {
        await ctx.reply("به ربات فروشگاهی خوش آمدید!", { reply_markup: keyboard });
      } else {
        await ctx.reply("به ربات فروشگاهی خوش آمدید!\nبرای خرید روی دکمه زیر بزنید.", { reply_markup: new InlineKeyboard().text("🛒 فروشگاه", "shop") });
      }
    });

    // --- بخش فروشگاه ---
    bot.callbackQuery("shop", async (ctx) => {
      const products = await env.DB.prepare("SELECT * FROM products").all();
      if (!products.results.length) return ctx.answerCallbackQuery("محصولی موجود نیست.");

      const keyboard = new InlineKeyboard();
      products.results.forEach(p => {
        keyboard.text(`${p.name} - ${p.price} تومان`, `buy_${p.id}`).row();
      });
      
      await ctx.editMessageText("لیست محصولات:", { reply_markup: keyboard });
      await ctx.answerCallbackQuery();
    });

    // --- نمایش محصول و انتخاب درگاه ---
    bot.callbackQuery(/^buy_(\d+)$/, async (ctx) => {
      const productId = ctx.match[1];
      const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first();
      if (!product) return ctx.answerCallbackQuery("محصول یافت نشد.");

      await env.KV.put(`user_cart_${ctx.from.id}`, productId);

      const keyboard = new InlineKeyboard()
        .text("⭐ پرداخت با استارز تلگرام", `pay_stars_${product.id}`)
        .row()
        .text("💳 پرداخت کارت به کارت", `pay_card_${product.id}`);
      
      await ctx.editMessageText(`محصول: ${product.name}\nتوضیحات: ${product.description}\nقیمت: ${product.price} تومان\n\nروش پرداخت را انتخاب کنید:`, { reply_markup: keyboard });
      await ctx.answerCallbackQuery();
    });

    // --- پرداخت با استارز تلگرام ---
    bot.callbackQuery(/^pay_stars_(\d+)$/, async (ctx) => {
      const productId = ctx.match[1];
      const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first();
      
      // Stars تلگرام قیمت را به عنوان عدد صحیح می‌گیرد (1 Star = 1)
      const starsPrice = Math.floor(product.price / 10000); // مثال: هر 10000 تومان = 1 استار
      
      await ctx.answerCallbackQuery("در حال ساخت فاکتور...");
      await bot.api.sendInvoice(ctx.from.id, {
        title: product.name,
        description: product.description,
        payload: `product_${product.id}`,
        currency: "XTR", // کد ارز برای Stars
        prices: [{ label: product.name, amount: starsPrice }],
      });
    });

    // --- پیش‌فاکتور استارز (Precheckout) ---
    bot.on("pre_checkout_query", async (ctx) => {
      await ctx.answerPreCheckoutQuery(true); // تایید خودکار فاکتور
    });

    // --- پرداخت موفق استارز ---
    bot.on("message:successful_payment", async (ctx) => {
      const payload = ctx.message.successful_payment.invoice_payload;
      const productId = payload.replace("product_", "");
      const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first();
      
      await env.DB.prepare("INSERT INTO orders (user_id, product_id, amount, status, method) VALUES (?, ?, ?, 'paid', 'stars')").bind(ctx.from.id, product.id, product.price).run();
      
      await ctx.reply("✅ پرداخت با موفقیت انجام شد! محصول شما در زیر ارسال شد:");
      await ctx.replyWithDocument(product.file_id);
    });

    // --- پرداخت کارت به کارت ---
    bot.callbackQuery(/^pay_card_(\d+)$/, async (ctx) => {
      const productId = ctx.match[1];
      const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first();
      
      const order = await env.DB.prepare("INSERT INTO orders (user_id, product_id, amount, status, method) VALUES (?, ?, ?, 'pending', 'card')").bind(ctx.from.id, product.id, product.price).run();
      
      await ctx.editMessageText(`برای پرداخت کارت به کارت، مبلغ ${product.price} تومان را به شماره کارت زیر واریز کنید:\n\n💳 ${env.CARD_NUMBER}\n\nسپس عکس فیش را همینجا ارسال کنید.\nکد پیگیری شما: ${order.meta.last_row_id}`);
      await ctx.answerCallbackQuery();
      
      // ذخیره وضعیت کاربر برای دریافت عکس فیش
      await env.KV.put(`user_state_${ctx.from.id}`, `receipt_${order.meta.last_row_id}`);
    });

    // --- دریافت عکس فیش کارت به کارت ---
    bot.on("message:photo", async (ctx) => {
      const state = await env.KV.get(`user_state_${ctx.from.id}`);
      if (!state || !state.startsWith("receipt_")) return;

      const orderId = state.replace("receipt_", "");
      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      
      // ارسال فیش به ادمین
      const keyboard = new InlineKeyboard()
        .text("✅ تایید", `approve_${orderId}`)
        .text("❌ رد", `reject_${orderId}`);
        
      await bot.api.sendPhoto(env.ADMIN_ID, fileId, { caption: `فیش جدید از کاربر ${ctx.from.id}\nکد سفارش: ${orderId}`, reply_markup: keyboard });
      await env.KV.delete(`user_state_${ctx.from.id}`);
      await ctx.reply("فیش شما برای بررسی به ادمین ارسال شد. پس از تایید، محصول برای شما ارسال می‌شود.");
    });

    // --- پنل مدیریت (تایید فیش) ---
    bot.callbackQuery(/^approve_(\d+)$/, async (ctx) => {
      if (ctx.from.id.toString() !== env.ADMIN_ID) return;
      const orderId = ctx.match[1];
      const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
      
      await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").bind(orderId).run();
      
      const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(order.product_id).first();
      await bot.api.sendDocument(order.user_id, product.file_id, { caption: "✅ پرداخت شما تایید شد. محصول شما:" });
      
      await ctx.editMessageCaption({ caption: "✅ تایید شد و محصول ارسال شد." });
      await ctx.answerCallbackQuery("تایید شد!");
    });

    bot.callbackQuery(/^reject_(\d+)$/, async (ctx) => {
      if (ctx.from.id.toString() !== env.ADMIN_ID) return;
      const orderId = ctx.match[1];
      const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
      
      await env.DB.prepare("UPDATE orders SET status = 'rejected' WHERE id = ?").bind(orderId).run();
      await bot.api.sendMessage(order.user_id, "❌ متاسفانه فیش شما تایید نشد. در صورت اشتباه با پشتیبانی تماس بگیرید.");
      
      await ctx.editMessageCaption({ caption: "❌ رد شد." });
      await ctx.answerCallbackQuery("رد شد!");
    });

    // --- افزودن محصول (مخصوص ادمین) ---
    bot.command("addproduct", async (ctx) => {
      if (ctx.from.id.toString() !== env.ADMIN_ID) return;
      const args = ctx.message.text.split(" ");
      if (args.length < 4) return ctx.reply("فرمت: /addproduct [نام] [قیمت_تومان] [file_id]");
      
      const name = args[1];
      const price = parseInt(args[2]);
      const fileId = args[3];
      
      await env.DB.prepare("INSERT INTO products (name, description, price, file_id) VALUES (?, ?, ?, ?)").bind(name, "توضیحات محصول", price, fileId).run();
      await ctx.reply(`✅ محصول ${name} با قیمت ${price} تومان اضافه شد.`);
    });

    // راه‌اندازی Webhook
    const url = new URL(request.url);
    if (url.pathname === "/webhook") {
      try {
        return await bot.handleUpdate(await request.json());
      } catch (e) {
        console.error(e);
      }
    }
    return new Response("Bot is running...");
  }
};
