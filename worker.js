export default {
  async fetch(req, env) {
    // 1) اگر با مرورگر بازش کنی باید اینو ببینی
    if (req.method === "GET") {
      return new Response("WORKER IS ALIVE ✅", { status: 200 });
    }

    // 2) هر چیزی از تلگرام بیاد اینجا لاگ میشه
    try {
      const body = await req.text();
      console.log("INCOMING:", body);
    } catch (e) {
      console.log("BODY ERR:", e);
    }

    return new Response("OK", { status: 200 });
  }
}
