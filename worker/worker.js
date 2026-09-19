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

    // =========================================================================
    // 2. ระบบ Private Sync Key (Multi-Device, No Collision, Auto-Expand 60%, Auto-Merge)
    // =========================================================================
    const TWO_YEARS_MS = 730 * 24 * 60 * 60 * 1000; // 2 ปี (730 วัน)
    const TWO_YEARS_SECONDS = 730 * 24 * 60 * 60;   // 63,072,000 วินาที
    const MAX_HISTORY_ITEMS = 500;                  // เพิ่มเป็น 500 เรื่อง

    // รวมประวัติการอ่านอย่างชาญฉลาด (Smart Merge History พร้อมตรวจจับการลบ)
    const mergeHistoryList = (histA, histB, deletedMap = {}, clearedAt = 0) => {
      const map = new Map();
      const combined = [...(Array.isArray(histA) ? histA : []), ...(Array.isArray(histB) ? histB : [])];
      const cutoff = Date.now() - (730 * 24 * 60 * 60 * 1000); // 2 ปี

      for (const item of combined) {
        if (!item || !item.title) continue;
        const titleKey = item.title.trim();
        const urlKey = (item.mangaUrl || '').trim();
        const itemUpdatedAt = item.updatedAt || 0;

        // ตรวจสอบการล้างประวัติทั้งหมด
        if (clearedAt > 0 && itemUpdatedAt <= clearedAt) {
          continue;
        }

        // ตรวจสอบการลบรายเรื่อง
        const deletedTime = Math.max(deletedMap[titleKey] || 0, deletedMap[urlKey] || 0);
        if (deletedTime > 0 && itemUpdatedAt <= deletedTime) {
          continue;
        }

        if (itemUpdatedAt && itemUpdatedAt < cutoff) continue; // ลบเมื่อเกิน 2 ปี

        const itemReadChapters = Array.isArray(item.readChapters) 
          ? item.readChapters 
          : (typeof item.readChapters === 'string' && item.readChapters ? [item.readChapters] : []);

        const normTitle = titleKey.toLowerCase().replace(/แปลไทย|manga|manhwa|ตอนที่|ch\.|season|[^\u0E00-\u0E7Fa-zA-Z0-9]/g, '').trim();
        const itemKey = (normTitle && normTitle.length >= 3) ? normTitle : (titleKey || urlKey);
        if (!map.has(itemKey)) {
          map.set(itemKey, { 
            ...item,
            readChapters: itemReadChapters
          });
        } else {
          const existing = map.get(itemKey);
          const existRead = Array.isArray(existing.readChapters) ? existing.readChapters : [];
          const combinedRead = Array.from(new Set([...existRead, ...itemReadChapters]));
          const newer = itemUpdatedAt >= (existing.updatedAt || 0) ? item : existing;
          const older = newer === item ? existing : item;
          const combinedAlt = [
            ...(newer.altSources || []),
            ...(older.altSources || []),
            ...(older.mangaUrl && older.mangaUrl !== newer.mangaUrl ? [older] : [])
          ];
          map.set(itemKey, {
            ...newer,
            readChapters: combinedRead,
            altSources: combinedAlt,
            updatedAt: Math.max(existing.updatedAt || 0, itemUpdatedAt)
          });
        }
      }

      const result = Array.from(map.values());
      result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return result.slice(0, MAX_HISTORY_ITEMS); // คุมไม่เกิน 500 เรื่อง
    };

    // รวมเรื่องโปรดอย่างชาญฉลาด (Smart Merge Favorites พร้อมตรวจจับการลบ)
    const mergeFavoritesList = (favA, favB, deletedMap = {}) => {
      const map = new Map();
      const combined = [...(Array.isArray(favA) ? favA : []), ...(Array.isArray(favB) ? favB : [])];
      for (const item of combined) {
        if (!item || !item.title) continue;
        const titleKey = item.title.trim();
        const urlKey = (item.mangaUrl || '').trim();
        const itemSavedAt = item.savedAt || 0;

        // ตรวจสอบการลบเรื่องโปรด
        const deletedTime = Math.max(deletedMap[titleKey] || 0, deletedMap[urlKey] || 0);
        if (deletedTime > 0 && itemSavedAt <= deletedTime) {
          continue;
        }

        const normTitle = titleKey.toLowerCase().replace(/แปลไทย|manga|manhwa|ตอนที่|ch\.|season|[^\u0E00-\u0E7Fa-zA-Z0-9]/g, '').trim();
        const itemKey = (normTitle && normTitle.length >= 3) ? normTitle : (titleKey || urlKey);
        if (!map.has(itemKey)) {
          map.set(itemKey, item);
        } else {
          const existing = map.get(itemKey);
          if (itemSavedAt >= (existing.savedAt || 0)) {
            map.set(itemKey, item);
          }
        }
      }
      const result = Array.from(map.values());
      result.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      return result;
    };

    // 2.1 สุ่มรหัสใหม่แท้ 100% ห้ามซ้ำ พร้อมขยายหลักอัตโนมัติเมื่อแตะ 60%
    if (url.pathname === '/api/sync/generate-key' && request.method === 'POST') {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const digits = '0123456789';

      if (!env || !env.CHAT_KV) {
        let key = '';
        for (let i = 0; i < 2; i++) key += letters.charAt(Math.floor(Math.random() * letters.length));
        for (let i = 0; i < 2; i++) key += digits.charAt(Math.floor(Math.random() * digits.length));
        return new Response(JSON.stringify({ success: true, key }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        let meta = await env.CHAT_KV.get('sync_registry_meta', { type: 'json' });
        if (!meta) {
          meta = { count: 0, letterCount: 2, digitCount: 2 };
        }

        // ตรวจสอบเกณฑ์ 60% ของความเป็นไปได้ทั้งหมด (เช่น 2 ตัวอักษร + 2 ตัวเลข = 26*26*100 = 67,600)
        const totalPossible = Math.pow(26, meta.letterCount) * Math.pow(10, meta.digitCount);
        if (meta.count >= totalPossible * 0.60) {
          // ขยายเพิ่มตัวอักษรนำหน้าอีก 1 หลักอัตโนมัติ
          meta.letterCount += 1;
        }

        let generatedKey = '';
        let attempts = 0;
        while (attempts < 20) {
          attempts++;
          let candidate = '';
          for (let i = 0; i < meta.letterCount; i++) candidate += letters.charAt(Math.floor(Math.random() * letters.length));
          for (let i = 0; i < meta.digitCount; i++) candidate += digits.charAt(Math.floor(Math.random() * digits.length));

          // ตรวจสอบใน KV ว่าซ้ำหรือไม่
          const existing = await env.CHAT_KV.get(`sync_key_${candidate}`);
          if (!existing) {
            generatedKey = candidate;
            break;
          }
        }

        if (!generatedKey) {
          meta.letterCount += 1;
          let candidate = '';
          for (let i = 0; i < meta.letterCount; i++) candidate += letters.charAt(Math.floor(Math.random() * letters.length));
          for (let i = 0; i < meta.digitCount; i++) candidate += digits.charAt(Math.floor(Math.random() * digits.length));
          generatedKey = candidate;
        }

        await env.CHAT_KV.put(`sync_key_${generatedKey}`, JSON.stringify({ createdAt: Date.now() }));
        meta.count += 1;
        await env.CHAT_KV.put('sync_registry_meta', JSON.stringify(meta));

        return new Response(JSON.stringify({ success: true, key: generatedKey }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 2.2 คืนคีย์ชั่วคราวที่ไม่ได้ใช้งาน เมื่อเปลี่ยนไปใช้รหัสเดิม
    if (url.pathname === '/api/sync/release-key' && request.method === 'POST') {
      try {
        const data = await request.json();
        const key = (data.key || '').trim().toUpperCase();
        if (key && env && env.CHAT_KV) {
          const existingData = await env.CHAT_KV.get(`sync_data_${key}`, { type: 'json' });
          const isEmpty = !existingData || (
            (!existingData.favorites || existingData.favorites.length === 0) &&
            (!existingData.history || existingData.history.length === 0)
          );

          if (isEmpty) {
            await env.CHAT_KV.delete(`sync_key_${key}`);
            await env.CHAT_KV.delete(`sync_data_${key}`);

            let meta = await env.CHAT_KV.get('sync_registry_meta', { type: 'json' });
            if (meta && meta.count > 0) {
              meta.count -= 1;
              await env.CHAT_KV.put('sync_registry_meta', JSON.stringify(meta));
            }
          }
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 2.3 ดึงข้อมูล Sync ของคีย์นั้น
    if (url.pathname === '/api/sync/data' && request.method === 'GET') {
      const key = (url.searchParams.get('key') || '').trim().toUpperCase();
      if (!key) {
        return new Response(JSON.stringify({ success: false, error: "Missing key" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      let cloudData = {
        nickname: '',
        favorites: [],
        history: [],
        deletedFavorites: {},
        deletedHistory: {},
        historyClearedAt: 0
      };

      if (env && env.CHAT_KV) {
        try {
          const stored = await env.CHAT_KV.get(`sync_data_${key}`, { type: 'json' });
          if (stored) {
            const delFavs = (typeof stored.deletedFavorites === 'object' && stored.deletedFavorites) ? stored.deletedFavorites : {};
            const delHist = (typeof stored.deletedHistory === 'object' && stored.deletedHistory) ? stored.deletedHistory : {};
            const clearedAt = Number(stored.historyClearedAt || 0);

            cloudData = {
              nickname: (stored.nickname || '').trim(),
              favorites: Array.isArray(stored.favorites) ? mergeFavoritesList(stored.favorites, [], delFavs) : [],
              history: Array.isArray(stored.history) ? mergeHistoryList(stored.history, [], delHist, clearedAt) : [],
              deletedFavorites: delFavs,
              deletedHistory: delHist,
              historyClearedAt: clearedAt
            };
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({ success: true, data: cloudData }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 2.4 บันทึกและ Smart Merge ข้อมูลข้ามอุปกรณ์
    if (url.pathname === '/api/sync/data' && request.method === 'POST') {
      try {
        const payload = await request.json();
        const key = (payload.key || '').trim().toUpperCase();
        if (!key) {
          return new Response(JSON.stringify({ success: false, error: "Missing key" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        let existingData = {
          nickname: '',
          favorites: [],
          history: [],
          deletedFavorites: {},
          deletedHistory: {},
          historyClearedAt: 0
        };

        if (env && env.CHAT_KV) {
          try {
            const stored = await env.CHAT_KV.get(`sync_data_${key}`, { type: 'json' });
            if (stored) {
              existingData = {
                nickname: (stored.nickname || '').trim(),
                favorites: Array.isArray(stored.favorites) ? stored.favorites : [],
                history: Array.isArray(stored.history) ? stored.history : [],
                deletedFavorites: (typeof stored.deletedFavorites === 'object' && stored.deletedFavorites) ? stored.deletedFavorites : {},
                deletedHistory: (typeof stored.deletedHistory === 'object' && stored.deletedHistory) ? stored.deletedHistory : {},
                historyClearedAt: Number(stored.historyClearedAt || 0)
              };
            }
          } catch (e) {}
        }

        // ผสานรายการที่ถูกลบ (Tombstones) และเวลาล้างประวัติ
        const mergedDeletedFavs = { ...existingData.deletedFavorites, ...(payload.deletedFavorites || {}) };
        const mergedDeletedHist = { ...existingData.deletedHistory, ...(payload.deletedHistory || {}) };
        const mergedHistClearedAt = Math.max(existingData.historyClearedAt || 0, Number(payload.historyClearedAt || 0));

        // รวมข้อมูลแบบ Smart Merge: ผสานประวัติ, เรื่องโปรด และชื่อเล่นในแชทจากหลายเครื่อง โดยเคารพการลบ
        const nickname = (payload.nickname || existingData.nickname || '').trim().slice(0, 25);
        const mergedFavorites = mergeFavoritesList(existingData.favorites, payload.favorites, mergedDeletedFavs);
        const mergedHistory = mergeHistoryList(existingData.history, payload.history, mergedDeletedHist, mergedHistClearedAt);

        const resultData = {
          nickname,
          favorites: mergedFavorites,
          history: mergedHistory,
          deletedFavorites: mergedDeletedFavs,
          deletedHistory: mergedDeletedHist,
          historyClearedAt: mergedHistClearedAt,
          lastSyncedAt: Date.now()
        };

        if (env && env.CHAT_KV) {
          await env.CHAT_KV.put(`sync_data_${key}`, JSON.stringify(resultData), {
            expirationTtl: TWO_YEARS_SECONDS // 730 วัน (2 ปี)
          });
          await env.CHAT_KV.put(`sync_key_${key}`, JSON.stringify({ active: true, updatedAt: Date.now() }));
        }

        return new Response(JSON.stringify({ success: true, data: resultData }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
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
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return new Response("Proxy Error: Invalid target URL protocol", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain; charset=utf-8" }
        });
      }
      const parsedTarget = new URL(targetUrl);
      const origin = parsedTarget.origin;

      const customReferer = url.searchParams.get("referer") || request.headers.get("x-referer");
      let refererHeader = origin + "/";
      if (customReferer) {
        refererHeader = customReferer;
      } else if (origin.includes("webtoon168") || targetUrl.includes("webtoon168")) {
        refererHeader = "https://ped-manga.com/";
      } else if (origin.includes("chibi-manga") || targetUrl.includes("chibi-manga")) {
        refererHeader = "https://chibi-manga.com/";
      } else if (origin.includes("mangahere") || targetUrl.includes("mangahere") || origin.includes("mangatown") || targetUrl.includes("mangatown")) {
        refererHeader = "https://www.mangatown.com/";
      } else if (origin.includes("bully-manga") || targetUrl.includes("bully-manga")) {
        refererHeader = "https://bully-manga.com/";
      } else if (origin.includes("sixmanga") || targetUrl.includes("sixmanga")) {
        refererHeader = "https://www.sixmanga.com/";
      }

      const fetchOptions = {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": refererHeader,
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
