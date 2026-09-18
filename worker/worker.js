/**
 * Cloudflare Worker Script สำหรับ Clean Manga Reader
 * 
 * หน้าที่:
 * 1. ปลดล็อก CORS ให้อ่านข้ามโดเมนได้จาก GitHub Pages
 * 2. แนบ Header 'Referer' และ 'User-Agent' หลอก Cloudflare ของเว็บต้นทางเพื่อแก้ Error 403 Forbidden
 * 3. ส่งข้อมูลรูปภาพและ HTML กลับไปยังเว็บของเราอย่างปลอดภัย
 */

export default {
  async fetch(request, env, ctx) {
    // จัดการ Preflight Request (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response("Clean Manga Reader Proxy is running! Ready to proxy manga requests.", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    try {
      const parsedTarget = new URL(targetUrl);
      const origin = parsedTarget.origin;

      const fetchOptions = {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": origin + "/",
          "Accept": "*/*"
        }
      };

      if (request.method === "POST") {
        fetchOptions.body = await request.text();
        const contentType = request.headers.get("content-type");
        if (contentType) {
          fetchOptions.headers["Content-Type"] = contentType;
        }
      }

      // ทำการร้องขอข้อมูลไปยังเว็บต้นทาง พร้อมแนบ Referer ต้นทาง
      const response = await fetch(targetUrl, fetchOptions);

      // คัดลอก Headers และเปิด CORS
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "*");
      
      // เพิ่มการแคชสำหรับ GET เพื่อความเร็ว
      if (request.method === "GET" && response.status === 200) {
        headers.set("Cache-Control", "public, max-age=86400"); // แคชไว้ 1 วัน
      }

      return new Response(response.body, {
        status: response.status,
        headers: headers
      });
    } catch (err) {
      return new Response("Proxy Error: " + err.message, {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
