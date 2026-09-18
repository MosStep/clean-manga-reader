/**
 * Cloudflare Worker Script สำหรับ Clean Manga Reader
 * 
 * หน้าที่:
 * 1. ปลดล็อก CORS ให้อ่านข้ามโดเมนได้จาก GitHub Pages
 * 2. แนบ Header 'Referer' และ 'User-Agent' หลอก Cloudflare ของเว็บต้นทางเพื่อแก้ Error 403 Forbidden
 * 3. ส่งข้อมูลรูปภาพและ HTML กลับไปยังเว็บของเราอย่างปลอดภัย
 */

// หน่วยความจำเก็บข้อความแชทส่วนกลาง (จำกัดสูงสุด 50 ข้อความล่าสุด ไม่เกิน 0.02 MB)
let chatMessages = [
  {
    id: "welcome-1",
    nickname: "CleanManga Bot ⚡",
    text: "ยินดีต้อนรับสู่ห้องคุย & แลกเปลี่ยนมังงะ! พิมพ์พูดคุยหรือป้ายยาการ์ตูนเรื่องโปรดได้เลยครับ ✨",
    mangaTitle: "Clean Manga",
    mangaUrl: "",
    time: Date.now() - 600000
  }
];

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

    // ค่าคงที่: จำกัดไม่เกิน 50 ข้อความ และเก็บไม่เกิน 60 วัน (2 เดือน)
    const MAX_CHAT_MESSAGES = 50;
    const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;
    const TWO_MONTHS_SECONDS = 60 * 24 * 60 * 60; // 5,184,000 วินาที

    const filterValidMessages = (msgs) => {
      const cutoff = Date.now() - TWO_MONTHS_MS;
      return (Array.isArray(msgs) ? msgs : [])
        .filter(m => m && m.time && m.time > cutoff)
        .slice(0, MAX_CHAT_MESSAGES);
    };

    // 1. ระบบแชทส่วนกลาง (Community Chat API รองรับ Cloudflare KV + In-Memory Fallback)
    if (url.pathname === '/api/chat') {
      if (request.method === "GET") {
        let currentMessages = chatMessages;
        let isKvActive = false;

        if (env && env.CHAT_KV) {
          try {
            const kvData = await env.CHAT_KV.get('chat_messages', { type: 'json' });
            if (Array.isArray(kvData) && kvData.length > 0) {
              currentMessages = filterValidMessages(kvData);
              chatMessages = currentMessages;
              isKvActive = true;
            }
          } catch (err) {
            console.warn("KV read error:", err);
          }
        } else {
          currentMessages = filterValidMessages(chatMessages);
          chatMessages = currentMessages;
        }

        return new Response(JSON.stringify({ 
          success: true, 
          messages: currentMessages,
          storage: isKvActive ? "kv" : "ram"
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          }
        });
      }

      if (request.method === "POST") {
        try {
          const data = await request.json();
          const nickname = (data.nickname || '').trim().slice(0, 25) || 'สหายมังงะ';
          const text = (data.text || '').trim().slice(0, 280);
          const mangaTitle = (data.mangaTitle || '').trim().slice(0, 80);
          const mangaUrl = (data.mangaUrl || '').trim().slice(0, 300);

          if (!text) {
            return new Response(JSON.stringify({ success: false, error: "กรุณาใส่ข้อความ" }), {
              status: 400,
              headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
            });
          }

          const newMsg = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            nickname,
            text,
            mangaTitle,
            mangaUrl,
            time: Date.now()
          };

          let currentList = chatMessages;
          if (env && env.CHAT_KV) {
            try {
              const kvData = await env.CHAT_KV.get('chat_messages', { type: 'json' });
              if (Array.isArray(kvData)) {
                currentList = filterValidMessages(kvData);
              }
            } catch (err) {
              console.warn("KV pre-read error:", err);
            }
          }

          // กรองไม่เกิน 2 เดือน และจำกัดสูงสุด 50 ข้อความ
          const updatedMessages = filterValidMessages([newMsg, ...currentList]);
          chatMessages = updatedMessages;

          let isKvActive = false;
          if (env && env.CHAT_KV) {
            try {
              await env.CHAT_KV.put('chat_messages', JSON.stringify(updatedMessages), {
                expirationTtl: TWO_MONTHS_SECONDS // หมดอายุอัตโนมัติเมื่อครบ 2 เดือน
              });
              isKvActive = true;
            } catch (err) {
              console.warn("KV write error:", err);
            }
          }

          return new Response(JSON.stringify({ 
            success: true, 
            messages: updatedMessages,
            storage: isKvActive ? "kv" : "ram"
          }), {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            }
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        }
      }
    }

    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
        const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00e676"/><stop offset="100%" stop-color="#00b0ff"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="#0c0d12"/><rect x="1.5" y="1.5" width="61" height="61" rx="14.5" fill="none" stroke="url(#g)" stroke-width="2" stroke-opacity="0.6"/><path d="M36 7 L17 34 L31 34 L26 57 L47 27 L33 27 Z" fill="url(#g)"/></svg>`;
        return new Response(faviconSvg, {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=604800",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": origin + "/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
          "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1"
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
