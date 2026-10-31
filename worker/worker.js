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
let aiChatActiveUntil = 0; // เก็บเวลาหมดอายุของเซสชันคุยเล่นกับ น้องมังงะ AI ✨

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

    const syncSourceTypes = new Set([
      'autodetect', 'mangareader', 'madara', 'whytoon', 'readtoon', 'ntrnaja',
      'kairew', 'mangatown', 'asurascans', 'bullymanga', 'mangablackcat', 'dongmanga', 'nekopost', 'duketoon', 'mangadex'
    ]);
    const safePublicUrl = (value) => {
      try {
        const parsed = new URL(String(value || ''));
        const host = parsed.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(parsed.protocol) || !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return '';
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return '';
        return parsed.href;
      } catch (e) { return ''; }
    };
    const cleanSyncText = (value, limit) => String(value || '').replace(/[<>]/g, '').trim().slice(0, limit);
    const sanitizeSourceProfiles = (profiles) => (Array.isArray(profiles) ? profiles : []).map(profile => {
      if (!profile || typeof profile !== 'object') return null;
      const sourceUrl = safePublicUrl(profile.url);
      if (!sourceUrl) return null;
      const origin = new URL(sourceUrl).origin;
      const id = cleanSyncText(profile.id, 72).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!id.startsWith('custom-')) return null;
      const listing = safePublicUrl(profile.listingUrl || origin);
      const listingUrl = listing && new URL(listing).origin === origin ? listing : origin;
      const type = syncSourceTypes.has(profile.type) ? profile.type : 'autodetect';
      const detectedParserType = syncSourceTypes.has(profile.detectedParserType) ? profile.detectedParserType : '';
      const pageLinks = {};
      if (profile.discoveredPageUrls && typeof profile.discoveredPageUrls === 'object') {
        Object.entries(profile.discoveredPageUrls).slice(0, 25).forEach(([page, href]) => {
          const number = Number(page);
          const safeHref = safePublicUrl(href);
          if (number > 1 && number <= 500 && safeHref && new URL(safeHref).hostname.replace(/^www\./i, '') === new URL(origin).hostname.replace(/^www\./i, '')) pageLinks[number] = safeHref;
        });
      }
      return {
        id,
        name: cleanSyncText(profile.name || new URL(sourceUrl).hostname, 60),
        url: origin,
        listingUrl,
        type,
        detectedParserType,
        pageUrlTemplate: /^\/(?!\/)[^\r\n<>]*$/.test(String(profile.pageUrlTemplate || '')) ? cleanSyncText(profile.pageUrlTemplate, 200) : '',
        discoveredPageUrls: pageLinks,
        icon: cleanSyncText(profile.icon || '🌐', 12),
        lang: ['th', 'en', 'ja'].includes(profile.lang) ? profile.lang : 'th',
        customSource: true,
        status: ['active', 'pending', 'removed'].includes(profile.status) ? profile.status : 'pending',
        triedStrategies: Array.isArray(profile.triedStrategies) ? profile.triedStrategies.slice(0, 12).map(item => cleanSyncText(item, 40)) : [],
        lastMessage: cleanSyncText(profile.lastMessage, 220),
        createdAt: Number(profile.createdAt) || Date.now(),
        updatedAt: Number(profile.updatedAt) || Date.now(),
        lastVerifiedAt: Number(profile.lastVerifiedAt) || 0
      };
    }).filter(Boolean).slice(-50);
    const mergeSourceProfiles = (current, incoming) => {
      const profiles = new Map(sanitizeSourceProfiles(current).map(profile => [profile.id, profile]));
      sanitizeSourceProfiles(incoming).forEach(profile => {
        const previous = profiles.get(profile.id);
        if (!previous || profile.updatedAt > previous.updatedAt) profiles.set(profile.id, profile);
      });
      return Array.from(profiles.values()).sort((a, b) => a.updatedAt - b.updatedAt).slice(-50);
    };
    const sanitizeSourceSnapshots = (snapshots) => (Array.isArray(snapshots) ? snapshots : []).map(snapshot => {
      if (!snapshot || typeof snapshot !== 'object') return null;
      const sourceId = cleanSyncText(snapshot.sourceId, 72).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!sourceId || !Array.isArray(snapshot.items)) return null;
      const seen = new Set();
      const items = snapshot.items.slice(0, 80).map(item => {
        if (!item || typeof item !== 'object' || cleanSyncText(item.sourceId, 72) !== sourceId) return null;
        const mangaUrl = safePublicUrl(item.mangaUrl);
        if (!mangaUrl || !cleanSyncText(item.title, 180) || seen.has(mangaUrl)) return null;
        const cover = item.cover ? safePublicUrl(item.cover) : '';
        seen.add(mangaUrl);
        return {
          title: cleanSyncText(item.title, 180),
          mangaUrl,
          cover,
          latestEp: cleanSyncText(item.latestEp, 100),
          type: cleanSyncText(item.type || 'Manga', 40),
          sourceId,
          sourceName: cleanSyncText(item.sourceName, 80),
          sourceUrl: safePublicUrl(item.sourceUrl) || '',
          sourceType: syncSourceTypes.has(item.sourceType) ? item.sourceType : 'mangareader',
          readable: item.readable !== false,
          isCoin: !!item.isCoin,
          icon: cleanSyncText(item.icon || '🌐', 12),
          lang: ['th', 'en', 'ja', 'ko'].includes(item.lang) ? item.lang : 'th'
        };
      }).filter(Boolean);
      return { sourceId, updatedAt: Number(snapshot.updatedAt) || Date.now(), items };
    }).filter(Boolean).slice(-60);
    const mergeSourceSnapshots = (current, incoming) => {
      const snapshots = new Map(sanitizeSourceSnapshots(current).map(snapshot => [snapshot.sourceId, snapshot]));
      sanitizeSourceSnapshots(incoming).forEach(snapshot => {
        const previous = snapshots.get(snapshot.sourceId);
        if (!previous || snapshot.updatedAt > previous.updatedAt) {
          snapshots.set(snapshot.sourceId, snapshot);
        } else if (snapshot.updatedAt === previous.updatedAt) {
          const byUrl = new Map(previous.items.map(item => [item.mangaUrl, item]));
          snapshot.items.forEach(item => { if (!byUrl.has(item.mangaUrl)) byUrl.set(item.mangaUrl, item); });
          snapshots.set(snapshot.sourceId, { ...previous, items: Array.from(byUrl.values()).slice(0, 80) });
        }
      });
      return Array.from(snapshots.values()).sort((a, b) => a.updatedAt - b.updatedAt).slice(-60);
    };

    // ============================================================
    // Tenixe AI Helper Functions (สลับคีย์อัตโนมัติ + Streaming Parser ประหยัด Token)
    // ============================================================
    const TENIXE_KEYS = [
      (env && env.TENIXE_KEY_1) || 'txc_a9b58666d7af0a1ef12675757074c61b',
      (env && env.TENIXE_KEY_2) || 'txc_9fec4ca9adfabf57f99a27fc0161e95a',
      (env && env.TENIXE_KEY_3) || 'txc_bd70db10dc2355f995bc3f9ad81558b3'
    ].filter(Boolean);

    const callTenixeChat = async (messages, maxTokens = 350) => {
      for (const key of TENIXE_KEYS) {
        try {
          const resp = await fetch('https://api.tenixe.com/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model: 'nemotron-3-ultra',
              messages,
              stream: false,
              max_tokens: maxTokens
            })
          });

          if (!resp.ok) {
            console.warn(`Tenixe key ${key.slice(0, 8)} returned ${resp.status}`);
            continue;
          }

          const raw = await resp.text();
          try {
            const j = JSON.parse(raw);
            const content = j.choices?.[0]?.message?.content;
            if (content && content.trim()) return content.trim();
          } catch (e) {
            // Fallback parsing SSE chunks if returned as stream
            let full = '';
            const lines = raw.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const j = JSON.parse(line.slice(6));
                  const delta = j.choices?.[0]?.delta?.content || '';
                  full += delta;
                } catch (err) {}
              }
            }
            if (full.trim()) return full.trim();
          }
        } catch (e) {
          console.warn(`Tenixe chat error with key:`, e);
        }
      }
      return null;
    };

    const callTenixeImage = async (prompt) => {
      for (const key of TENIXE_KEYS) {
        try {
          const resp = await fetch('https://api.tenixe.com/api/v1/images/generations', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model: 'gpt-image-1',
              prompt,
              size: '1024x1024',
              n: 1
            })
          });

          if (!resp.ok) {
            const errBody = await resp.json().catch(() => ({}));
            console.warn(`Tenixe image key ${key.slice(0, 8)} status ${resp.status}:`, errBody);
            if (resp.status === 402) {
              return { success: false, reason: 'quota_exceeded' };
            }
            continue;
          }

          const data = await resp.json();
          const imgUrl = data?.data?.[0]?.url || data?.data?.[0]?.b64_json;
          if (imgUrl) return { success: true, url: imgUrl };
        } catch (e) {
          console.warn(`Tenixe image error:`, e);
        }
      }
      return { success: false, reason: 'service_unavailable' };
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
          let updatedMessages = filterValidMessages([newMsg, ...currentList]);
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

          // ตรวจสอบการเรียกหรือเซสชันคุยเล่นกับ น้องมังงะ AI ✨
          const isBotNick = nickname.includes('น้องมังงะ') || nickname.includes('Bot') || nickname.includes('AI');
          const summonPattern = /(?:@ai|@บอท|\/ai|\bai\b|น้องมังงะ|บอท\s|เรียก\s*ai)/i;
          const isSummon = summonPattern.test(text);
          const stopPattern = /^(?:บาย|บ๊าย|ไปพัก|ไปนอน|เงียบก่อน|พอแล้ว|stop|\/stop|\/bye)/i;
          const isStop = stopPattern.test(text.trim());

          let now = Date.now();
          let isAiSessionActive = false;
          if (env && env.CHAT_KV) {
            try {
              const kvActiveUntil = await env.CHAT_KV.get('ai_chat_active_until');
              if (kvActiveUntil && Number(kvActiveUntil) > now) {
                isAiSessionActive = true;
              }
            } catch (e) {}
          }
          if (!isAiSessionActive && aiChatActiveUntil > now) {
            isAiSessionActive = true;
          }

          let needAiReply = false;
          if (isStop && (isSummon || isAiSessionActive)) {
            // สั่งให้น้องมังงะหยุดคุย / ไปพักผ่อน
            aiChatActiveUntil = 0;
            if (env && env.CHAT_KV) {
              try { await env.CHAT_KV.delete('ai_chat_active_until'); } catch (e) {}
            }
            const byeMsg = {
              id: 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              nickname: 'น้องมังงะ AI ✨',
              text: 'โอเคเลยคับ ไว้เจอกันใหม่นะทุกคน พักผ่อนเยอะๆ น้า! 😴✨',
              mangaTitle: '',
              mangaUrl: '',
              time: Date.now()
            };
            updatedMessages = filterValidMessages([byeMsg, ...updatedMessages]);
            chatMessages = updatedMessages;
            if (env && env.CHAT_KV) {
              try {
                await env.CHAT_KV.put('chat_messages', JSON.stringify(updatedMessages), {
                  expirationTtl: TWO_MONTHS_SECONDS
                });
              } catch (e) {}
            }
          } else if (!isBotNick && (isSummon || isAiSessionActive)) {
            needAiReply = true;
            const newActiveUntil = Date.now() + 150000;
            aiChatActiveUntil = newActiveUntil;
            if (env && env.CHAT_KV) {
              try {
                await env.CHAT_KV.put('ai_chat_active_until', String(newActiveUntil), {
                  expirationTtl: 300
                });
              } catch (e) {}
            }
          }

          // ส่งข้อความของผู้ใช้กลับทันที (<50ms) เพื่อให้ขึ้นในจอทันใจ ไม่ต้องรอ AI
          return new Response(JSON.stringify({ 
            success: true, 
            messages: updatedMessages,
            needAiReply,
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

    // 1.1 ตอบแชทแบบมีชีวิตชีวาด้วย น้องมังงะ AI ✨ (/api/chat/ai)
    if (url.pathname === '/api/chat/ai' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const mangaTitle = (body.mangaTitle || '').trim().slice(0, 80);
        const mangaUrl = (body.mangaUrl || '').trim().slice(0, 300);
        const readHistory = Array.isArray(body.readHistory) ? body.readHistory : [];

        let currentList = chatMessages;
        if (env && env.CHAT_KV) {
          try {
            const kvData = await env.CHAT_KV.get('chat_messages', { type: 'json' });
            if (Array.isArray(kvData) && kvData.length > 0) {
              currentList = filterValidMessages(kvData);
              chatMessages = currentList;
            }
          } catch (e) {}
        }

        // บริบทแชท 6 ข้อความล่าสุด
        const recentContext = currentList.slice(0, 6).reverse().map(m => {
          const isBot = (m.nickname && (m.nickname.includes('AI') || m.nickname.includes('น้องมังงะ') || m.nickname.includes('Bot')));
          return {
            role: isBot ? 'assistant' : 'user',
            content: isBot ? m.text : `${m.nickname}: ${m.text}${m.mangaTitle ? ` (กำลังดูเรื่อง: ${m.mangaTitle})` : ''}`
          };
        });

        const historyPrompt = readHistory.length > 0 
          ? `\nประวัติการอ่านของผู้ใช้นี้ (เรื่องที่อ่านแล้ว ห้ามแนะนำซ้ำเด็ดขาด!):\n${readHistory.slice(0, 30).map(t => `- ${t}`).join('\n')}\nกฎสำคัญสำหรับการแนะนำเรื่อง:\n- หากผู้ใช้ถามหาเรื่องอ่าน หรือขอให้แนะนำการ์ตูน/มังงะ ห้ามแนะนำเรื่องที่มีชื่ออยู่ในประวัติการอ่านด้านบนเด็ดขาด! ให้แนะนำเรื่องใหม่ที่ยังไม่เคยอ่าน พร้อมเหตุผลสั้นๆ\n- หากผู้ใช้ถามเรื่องที่ตนเคยอ่าน สามารถตอบอ้างอิงจากประวัติการอ่านได้`
          : '';

        const systemPrompt = `คุณคือ "น้องมังงะ AI ✨" เพื่อนสนิทประจำห้องแชท CleanManga
บุคลิกภาพและการตอบ:
- ร่าเริง สดใส เป็นกันเอง คุยเล่นทั่วไปได้ สัพเพเหระ ให้กำลังใจ เหมือนเพื่อนในแชทกลุ่ม
- รู้จักมังงะ มังฮวา อนิเมะ ทุกแนว ป้ายยาหรือแนะนำได้ตรงใจ
- สไตล์การตอบ: สั้นกระชับ 1-3 ประโยคเสมอ เพื่อให้แชทลื่นไหล ไม่พิมพ์ยาวเกินไป
- ใส่อีโมจิที่เข้ากับอารมณ์อย่างน่ารักเป็นธรรมชาติ เช่น ✨, 😆, 📖, 🔥
- ไม่พูดซ้ำซาก ไม่เป็นทางการ ไม่ทำตัวเป็นหุ่นยนต์ตอบข้อสอบ
- กฎเหล็กสำคัญ: ห้ามใส่ชื่อตนเองหรือคำนำหน้าใดๆ เช่น "น้องมังงะ AI ✨:", "น้องบอท :", "AI:" ในคำตอบเด็ดขาด ให้เริ่มตอบเนื้อความทันที เพราะหน้าต่างแชทมีชื่อแสดงอยู่แล้ว!${historyPrompt}`;

        const aiReply = await callTenixeChat([
          { role: 'system', content: systemPrompt },
          ...recentContext
        ], 280);

        if (!aiReply) {
          return new Response(JSON.stringify({ success: false, error: "AI ไม่สามารถตอบได้ในขณะนี้" }), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        }

        // ตัด prefix ใดๆ ที่ AI อาจหลุดส่งมาออกให้หมดจด
        const cleanReply = aiReply.replace(/^(?:น้อง(?:บอท|มังงะ(?:\s*AI)?(?:\s*✨)?)|CleanManga\s*Bot|บอท|AI|Bot)\s*[:：\-]\s*/i, '').trim();

        const botMsg = {
          id: 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          nickname: 'น้องมังงะ AI ✨',
          text: cleanReply,
          mangaTitle: mangaTitle || '',
          mangaUrl: mangaUrl || '',
          time: Date.now()
        };

        const updatedMessages = filterValidMessages([botMsg, ...currentList]);
        chatMessages = updatedMessages;

        if (env && env.CHAT_KV) {
          try {
            await env.CHAT_KV.put('chat_messages', JSON.stringify(updatedMessages), {
              expirationTtl: TWO_MONTHS_SECONDS
            });
          } catch (e) {}
        }

        return new Response(JSON.stringify({
          success: true,
          botMessage: botMsg,
          messages: updatedMessages
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
        const itemUpdatedAt = Number(item.updatedAt || 0);
        const titleKey = item.title.trim();
        const urlKey = (item.mangaUrl || '').trim();
        const isFromPayload = Array.isArray(histB) && histB.includes(item);
        if (!isFromPayload) {
          // ตรวจสอบการล้างประวัติทั้งหมดเฉพาะกับข้อมูลเก่าบนคลาวด์
          if (clearedAt > 0 && itemUpdatedAt <= clearedAt) {
            continue;
          }

          // ตรวจสอบการลบรายเรื่องเฉพาะกับข้อมูลเก่าบนคลาวด์
          const deletedTime = Math.max(deletedMap[titleKey] || 0, deletedMap[urlKey] || 0);
          if (deletedTime > 0 && itemUpdatedAt <= deletedTime) {
            continue;
          }
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
            readChapters: itemReadChapters.slice(-50)
          });
        } else {
          const existing = map.get(itemKey);
          const existRead = Array.isArray(existing.readChapters) ? existing.readChapters : [];
          const combinedRead = Array.from(new Set([...existRead, ...itemReadChapters]));
          const newer = itemUpdatedAt >= (existing.updatedAt || 0) ? item : existing;
          const older = newer === item ? existing : item;
          const rawAlt = Array.isArray(newer.altSources) ? newer.altSources : [];
          const rawOlderAlt = Array.isArray(older.altSources) ? older.altSources : [];
          const combinedAlt = [
            ...rawAlt,
            ...rawOlderAlt,
            ...(older.mangaUrl && older.mangaUrl !== newer.mangaUrl ? [{
              sourceId: older.sourceId || '',
              sourceName: older.sourceName || 'Online',
              mangaUrl: older.mangaUrl,
              sourceType: older.sourceType || 'mangareader'
            }] : [])
          ].map(a => ({
            sourceId: a.sourceId || '',
            sourceName: a.sourceName || 'Online',
            mangaUrl: a.mangaUrl,
            sourceType: a.sourceType || 'mangareader'
          })).filter((a, idx, arr) => a.mangaUrl && arr.findIndex(x => x.mangaUrl === a.mangaUrl) === idx);

          map.set(itemKey, {
            ...newer,
            readChapters: combinedRead.slice(-50),
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
            (!existingData.history || existingData.history.length === 0) &&
            (!existingData.sourceProfiles || existingData.sourceProfiles.length === 0) &&
            (!existingData.sourceSnapshots || existingData.sourceSnapshots.length === 0)
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
        historyClearedAt: 0,
        sourceProfiles: [],
        sourceSnapshots: []
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
              historyClearedAt: clearedAt,
              sourceProfiles: sanitizeSourceProfiles(stored.sourceProfiles),
              sourceSnapshots: sanitizeSourceSnapshots(stored.sourceSnapshots)
            };
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({ success: true, data: cloudData }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
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
          historyClearedAt: 0,
          sourceProfiles: [],
          sourceSnapshots: []
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
                historyClearedAt: Number(stored.historyClearedAt || 0),
                sourceProfiles: sanitizeSourceProfiles(stored.sourceProfiles),
                sourceSnapshots: sanitizeSourceSnapshots(stored.sourceSnapshots)
              };
            }
          } catch (e) {}
        }

        // ผสานรายการที่ถูกลบ (Tombstones) และเวลาล้างประวัติ
        const mergedDeletedFavs = { ...existingData.deletedFavorites, ...(payload.deletedFavorites || {}) };
        const mergedDeletedHist = { ...existingData.deletedHistory, ...(payload.deletedHistory || {}) };
        const mergedHistClearedAt = (Array.isArray(payload.history) && payload.history.length > 0)
          ? 0
          : Math.max(existingData.historyClearedAt || 0, Number(payload.historyClearedAt || 0));

        // ถ้านำเรื่องที่มีอยู่กลับมาส่ง แปลว่าผู้ใช้อ่านเรื่องนี้อยู่ ให้ล้าง Tombstone การลบทิ้งทันที
        if (Array.isArray(payload.history)) {
          payload.history.forEach(item => {
            if (!item || !item.title) return;
            delete mergedDeletedHist[item.title.trim()];
            if (item.mangaUrl) delete mergedDeletedHist[item.mangaUrl.trim()];
          });
        }
        if (Array.isArray(payload.favorites)) {
          payload.favorites.forEach(item => {
            if (!item || !item.title) return;
            delete mergedDeletedFavs[item.title.trim()];
            if (item.mangaUrl) delete mergedDeletedFavs[item.mangaUrl.trim()];
          });
        }

        // รวมข้อมูลแบบ Smart Merge: ผสานประวัติ, เรื่องโปรด และชื่อเล่นในแชทจากหลายเครื่อง โดยเคารพการลบ
        const nickname = (payload.nickname || existingData.nickname || '').trim().slice(0, 25);
        const mergedFavorites = mergeFavoritesList(existingData.favorites, payload.favorites, mergedDeletedFavs);
        const mergedHistory = mergeHistoryList(existingData.history, payload.history, mergedDeletedHist, mergedHistClearedAt);
        const mergedSourceProfiles = mergeSourceProfiles(existingData.sourceProfiles, payload.sourceProfiles);
        const mergedSourceSnapshots = mergeSourceSnapshots(existingData.sourceSnapshots, payload.sourceSnapshots);

        const resultData = {
          nickname,
          favorites: mergedFavorites,
          history: mergedHistory,
          deletedFavorites: mergedDeletedFavs,
          deletedHistory: mergedDeletedHist,
          historyClearedAt: mergedHistClearedAt,
          sourceProfiles: mergedSourceProfiles,
          sourceSnapshots: mergedSourceSnapshots,
          lastSyncedAt: Date.now()
        };

        if (env && env.CHAT_KV) {
          await env.CHAT_KV.put(`sync_data_${key}`, JSON.stringify(resultData), {
            expirationTtl: TWO_YEARS_SECONDS // 730 วัน (2 ปี)
          });
        }

        return new Response(JSON.stringify({ success: true, data: resultData }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ============================================================
    // 3. Tenixe AI Integrations: Semantic Search, AI Cover & Manga Summary
    // ============================================================

    // 3.1 AI Semantic Search Endpoint (/api/ai/search)
    if (url.pathname === '/api/ai/search') {
      let query = url.searchParams.get('q') || '';
      if (!query && request.method === 'POST') {
        try {
          const body = await request.json();
          query = body.query || body.q || '';
        } catch (e) {}
      }
      query = String(query).trim().slice(0, 200);

      if (!query) {
        return new Response(JSON.stringify({ success: false, error: "กรุณาระบุคำค้นหาพล็อตเรื่อง" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const cacheKey = 'ai_search_' + encodeURIComponent(query.toLowerCase().replace(/\s+/g, '_').slice(0, 70));

      // ตรวจสอบ KV Cache
      if (env && env.CHAT_KV) {
        try {
          const cached = await env.CHAT_KV.get(cacheKey, { type: 'json' });
          if (cached && Array.isArray(cached.keywords)) {
            return new Response(JSON.stringify({ success: true, ...cached, fromCache: true }), {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" }
            });
          }
        } catch (e) {}
      }

      const messages = [
        {
          role: 'system',
          content: `You are an expert manga semantic search engine.
The user searches for manga using story plots, character concepts, feelings, or tropes in Thai or English.
1. Extract "coreKeywords": The MUST-HAVE primary subject or character terms in BOTH English and Thai (e.g. if query has "elf", include ["elf", "elves", "เอลฟ์"]). If query has adult themes ("sex", "18+"), put adult terms here too.
2. Extract "qualifiers": Secondary attributes, age rating, tropes in BOTH English and Thai (e.g. if query has "18+" or "sex", include ["18+", "adult", "erotica", "mature", "ecchi", "hentai", "ติดเรท", "ผู้ใหญ่", "sex"]).
3. Extract "genres": High-level broad genres (e.g. ["fantasy", "romance", "erotica"]).
4. Set "isAdult": boolean true if query relates to 18+, sex, erotica, hentai, ecchi, adult themes; false otherwise.
5. Provide "summary": 1-line punchy Thai summary.

Output ONLY valid JSON in format:
{
  "coreKeywords": ["keyword_en", "keyword_th"],
  "qualifiers": ["qualifier1", "qualifier2"],
  "genres": ["genre1"],
  "keywords": ["all", "combined", "keywords"],
  "isAdult": false,
  "summary": "คำอธิบายแนวเรื่องสั้นๆ 1 บรรทัด"
}`
        },
        {
          role: 'user',
          content: query
        }
      ];

      const aiText = await callTenixeChat(messages, 300);
      let parsedResult = null;
      if (aiText) {
        try {
          const jsonMatch = aiText.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsedResult = JSON.parse(jsonMatch[0]);
        } catch (e) {}
      }

      if (!parsedResult) {
        const basicKeywords = query.split(/[\s,+/]+/).filter(w => w.length >= 2);
        parsedResult = {
          keywords: basicKeywords,
          genres: [],
          summary: query
        };
      }

      // บันทึกลง KV Cache (เก็บไว้ 7 วัน ประหยัดโควต้า 100%)
      if (env && env.CHAT_KV) {
        try {
          await env.CHAT_KV.put(cacheKey, JSON.stringify(parsedResult), {
            expirationTtl: 604800 // 7 วัน
          });
        } catch (e) {}
      }

      return new Response(JSON.stringify({ success: true, ...parsedResult, fromCache: false }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" }
      });
    }

    // 3.2 AI Cover Generation Endpoint (/api/ai/cover)
    if (url.pathname === '/api/ai/cover') {
      let title = url.searchParams.get('title') || '';
      if (!title && request.method === 'POST') {
        try {
          const body = await request.json();
          title = body.title || '';
        } catch (e) {}
      }
      title = String(title).trim().slice(0, 150);

      if (!title) {
        return new Response(JSON.stringify({ success: false, error: "กรุณาระบุชื่อเรื่องมังงะ" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const cacheKey = 'ai_cover_' + encodeURIComponent(title.toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, '_').slice(0, 70));

      // ตรวจสอบ KV Cache
      if (env && env.CHAT_KV) {
        try {
          const cachedCover = await env.CHAT_KV.get(cacheKey);
          if (cachedCover) {
            return new Response(JSON.stringify({ success: true, coverUrl: cachedCover, cached: true }), {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=2592000" }
            });
          }
        } catch (e) {}
      }

      // Prompt Engineering สำหรับภาพปกการ์ตูนคุณภาพสูง
      const imagePrompt = `Masterpiece official anime manga cover art, high-end Korean webtoon key visual, highly detailed character portrait, dramatic cinematic lighting, clean vibrant background, official light novel illustration for the title: "${title}", trending on pixiv, 8k resolution, no watermark, no text distortion, clean aesthetic`;

      const genResult = await callTenixeImage(imagePrompt);

      if (genResult.success && genResult.url) {
        // บันทึกลง KV Cache (เก็บไว้ 60 วัน ไม่ต้องเจนซ้ำ)
        if (env && env.CHAT_KV) {
          try {
            await env.CHAT_KV.put(cacheKey, genResult.url, {
              expirationTtl: 5184000 // 60 วัน
            });
          } catch (e) {}
        }

        return new Response(JSON.stringify({ success: true, coverUrl: genResult.url, cached: false }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(JSON.stringify({ 
        success: false, 
        reason: genResult.reason || 'failed',
        message: genResult.reason === 'quota_exceeded' 
          ? 'โควต้าเจนภาพชั่วคราวเต็ม (รอรอบรีเซ็ต)' 
          : 'ไม่สามารถสร้างภาพปกได้ในขณะนี้'
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 3.3 AI Manga Summary Endpoint (/api/ai/summary)
    if (url.pathname === '/api/ai/summary') {
      let title = url.searchParams.get('title') || '';
      let synopsis = url.searchParams.get('synopsis') || '';
      if (!title && request.method === 'POST') {
        try {
          const body = await request.json();
          title = body.title || '';
          synopsis = body.synopsis || synopsis;
        } catch (e) {}
      }
      title = String(title).trim().slice(0, 150);
      synopsis = String(synopsis).trim().slice(0, 1500);

      if (!title) {
        return new Response(JSON.stringify({ success: false, error: "กรุณาระบุชื่อเรื่องมังงะ" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const cacheKey = 'ai_summary_v2_' + encodeURIComponent(title.toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, '_').slice(0, 70));

      // ตรวจสอบ KV Cache (ข้ามถ้าเป็น template ซ้ำซากเดิม)
      if (env && env.CHAT_KV) {
        try {
          const cached = await env.CHAT_KV.get(cacheKey, { type: 'json' });
          if (cached && cached.summary && !cached.summary.includes('การเดินทางสุดเข้มข้นของ')) {
            return new Response(JSON.stringify({ success: true, ...cached, fromCache: true }), {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=2592000" }
            });
          }
        } catch (e) {}
      }

      // หากไม่มีเรื่องย่อส่งมา ให้ลองค้นหาจาก MangaDex API โดยตรง
      if (!synopsis || synopsis.length < 25) {
        try {
          const dexRes = await fetch(`https://api.mangadex.org/manga?title=${encodeURIComponent(title)}&limit=3`);
          if (dexRes.ok) {
            const dexJson = await dexRes.json();
            if (Array.isArray(dexJson.data) && dexJson.data.length > 0) {
              for (const item of dexJson.data) {
                const desc = item.attributes?.description?.th || item.attributes?.description?.en || Object.values(item.attributes?.description || {})[0];
                if (desc && desc.trim().length > 25) {
                  synopsis = desc.trim().slice(0, 1500);
                  break;
                }
              }
            }
          }
        } catch (e) {
          console.warn('MangaDex synopsis lookup error:', e);
        }
      }

      const summaryPrompt = `คุณคือผู้เชี่ยวชาญการ์ตูนและมังงะตัวจริง สรุปเนื้อเรื่องย่อของมังงะเรื่องนี้ให้กระชับ ดึงดูด ได้ใจความจริง ไม่สปอยล์จุดไคลแมกซ์
ความยาว 3 บรรทัดพอดี (แต่ละบรรทัดขึ้นต้นด้วย bullet •)
• บรรทัด 1: แนะนำตัวเอก ภูมิหลัง และจุดเริ่มต้นของเรื่อง
• บรรทัด 2: ปัญหา อุปสรรค พลังพิเศษ หรือความขัดแย้งหลัก
• บรรทัด 3: จุดเปลี่ยน เป้าหมาย หรือความน่าติดตามที่ห้ามพลาด
พร้อมแท็กอารมณ์เรื่อง (Mood Tags) 3 แท็ก และคำโปรย 1 ประโยค (oneLiner)
ข้อห้ามเด็ดขาด: ห้ามใช้ข้อความสำเร็จรูปทั่วไป เช่น "เรื่องราวการเดินทางสุดเข้มข้นของ..." หรือประโยคลอยๆ เด็ดขาด ต้องอิงเนื้อหาจริงของเรื่องนี้เท่านั้น
ตอบเป็น JSON เท่านั้นในรูปแบบ:
{"summary":"• บรรทัดที่ 1...\\n• บรรทัดที่ 2...\\n• บรรทัดที่ 3...","moodTags":["#แท็ก1","#แท็ก2","#แท็ก3"],"oneLiner":"คำโปรย 1 ประโยค"}`;

      const promptUserContent = `มังงะ: "${title}"${synopsis ? `\nเนื้อเรื่องย่อจริงจากต้นทาง:\n${synopsis}` : ''}`;
      const aiText = await callTenixeChat([
        { role: 'system', content: summaryPrompt },
        { role: 'user', content: promptUserContent }
      ], 700);

      let parsedResult = null;
      if (aiText) {
        try {
          const jsonMatch = aiText.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsedResult = JSON.parse(jsonMatch[0]);
        } catch (e) {}

        // กรณี JSON โดนตัดท้าย ให้ดึงฟิลด์ summary ออกมาด้วย regex
        if (!parsedResult || !parsedResult.summary) {
          const summaryMatch = aiText.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
          if (summaryMatch) {
            try {
              const extractedSummary = JSON.parse(`"${summaryMatch[1]}"`);
              const moodMatch = aiText.match(/"moodTags"\s*:\s*\[([\s\S]*?)\]/);
              let moodTags = ["#น่าติดตาม", "#เรื่องเด็ด", "#มังงะแนะนำ"];
              if (moodMatch) {
                try { moodTags = JSON.parse(`[${moodMatch[1]}]`); } catch (e) {}
              }
              const oneLinerMatch = aiText.match(/"oneLiner"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
              let oneLiner = oneLinerMatch ? JSON.parse(`"${oneLinerMatch[1]}"`) : `เรื่องราวของ ${title}`;
              parsedResult = { summary: extractedSummary, moodTags, oneLiner };
            } catch (e) {}
          }
        }
      }

      if (!parsedResult || !parsedResult.summary) {
        // หากมี bullet แต่ไม่ได้ JSON ให้ดึงเฉพาะบรรทัด bullet
        const bulletLines = (aiText || '').split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('•'))
          .map(l => l.replace(/^•\s*/, '• '));
        
        if (bulletLines.length > 0) {
          parsedResult = {
            summary: bulletLines.slice(0, 3).join('\n'),
            moodTags: ["#มังงะน่าอ่าน", "#เรื่องเด็ด", "#อัปเดตล่าสุด"],
            oneLiner: `เรื่องราวของ ${title}`
          };
        } else if (synopsis && synopsis.length > 30) {
          const sentences = synopsis.split(/[.\n]+/).map(s => s.trim()).filter(s => s.length > 10).slice(0, 3);
          parsedResult = {
            summary: sentences.map(s => `• ${s}`).join('\n'),
            moodTags: ["#เรื่องย่อ", "#แนะนำ", "#น่าติดตาม"],
            oneLiner: sentences[0] || `เรื่องราวของ ${title}`
          };
        } else {
          parsedResult = {
            summary: `• เรื่องย่อของ "${title}" ติดตามการผจญภัยและการต่อสู้สุดเข้มข้น\n• เผชิญกับศัตรูและปริศนาที่ท้าทายขีดจำกัดของตัวละคร\n• จุดเปลี่ยนสำคัญที่จะเปลี่ยนชะตากรรมของเรื่องราว`,
            moodTags: ["#การ์ตูน", "#น่าติดตาม", "#เรื่องฮิต"],
            oneLiner: `มังงะเรื่องดัง ${title}`
          };
        }
      }

      // บันทึกลง KV Cache (เก็บไว้ 30 วัน)
      if (env && env.CHAT_KV) {
        try {
          await env.CHAT_KV.put(cacheKey, JSON.stringify(parsedResult), {
            expirationTtl: 2592000 // 30 วัน
          });
        } catch (e) {}
      }

      return new Response(JSON.stringify({ success: true, ...parsedResult, fromCache: false }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=2592000" }
      });
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

      // ตรวจสอบ Cloudflare Edge Cache สำหรับคำขอแบบ GET ก่อนเสมอ
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const cacheKey = new Request(request.url, { method: "GET" });
      if (cache && request.method === "GET") {
        try {
          const cachedResponse = await cache.match(cacheKey);
          if (cachedResponse) {
            return cachedResponse;
          }
        } catch (_) {}
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
      } else if (origin.includes("mangablackcat") || targetUrl.includes("mangablackcat")) {
        refererHeader = "https://mangablackcat.com/";
      } else if (origin.includes("oremanga") || targetUrl.includes("oremanga")) {
        refererHeader = "https://www.oremanga.net/";
      } else if (origin.includes("duketoon") || targetUrl.includes("duketoon")) {
        refererHeader = "https://duketoon.com/";
      } else if (origin.includes("mangakimi") || targetUrl.includes("mangakimi")) {
        refererHeader = "https://www.mangakimi.com/";
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

      const xRequestedWith = request.headers.get("x-requested-with");
      if (xRequestedWith) {
        fetchOptions.headers["X-Requested-With"] = xRequestedWith;
      }
      if (targetUrl.includes("dongmanga.com") && targetUrl.includes("dong_wallet:pages")) {
        fetchOptions.headers["X-Requested-With"] = "XMLHttpRequest";
      }

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

      // รองรับการถอดรหัสรูปภาพอัตโนมัติสำหรับ DongManga (Discuz Dynamic Token Loader)
      if (request.method === "GET" && targetUrl.includes("dongmanga.com") && (targetUrl.includes("thread-") || targetUrl.includes("mod=viewthread"))) {
        try {
          let text = await response.text();
          const tokenMatch = text.match(/data-pg=["']([^"']+)["']/i);
          if (tokenMatch) {
            const token = tokenMatch[1];
            const pagesEndpoint = "https://dongmanga.com/plugin.php?id=dong_wallet:pages";
            const pagesResp = await fetch(pagesEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": targetUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              },
              body: "pg=" + encodeURIComponent(token)
            });
            if (pagesResp.ok) {
              const pData = await pagesResp.json();
              if (pData && pData.ok && Array.isArray(pData.img) && pData.img.length > 0) {
                const imgTags = pData.img.map(src => `<img src="${src}" class="dz8-injected-img" />`).join('\n');
                text = text.replace(/(<article[^>]*class=["'][^"']*dz8-pages[^"']*["'][^>]*>)/i, `$1\n<div class="injected-dz8-pages">\n${imgTags}\n</div>`);
              }
            }
          }
          headers.set("Content-Type", "text/html; charset=utf-8");
          headers.delete("content-length");
          return new Response(text, {
            status: response.status,
            headers: headers
          });
        } catch (e) {
          console.warn("Worker DongManga pages resolution error:", e);
        }
      }
      
      // เพิ่มการแคชสำหรับ GET เพื่อความเร็ว และป้องกันไม่ให้เบราว์เซอร์ส่ง Request ซ้ำ
      if (request.method === "GET" && response.status === 200) {
        const contentType = (headers.get("Content-Type") || "").toLowerCase();
        const isImage = contentType.startsWith("image/") || /\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(targetUrl);
        const cacheSeconds = isImage ? 604800 : 900; // 7 วันสำหรับรูปภาพ, 15 นาทีสำหรับเว็บเพจ

        // ลบ Headers ที่บล็อกการจำแคชจากเว็บต้นทาง
        headers.delete("pragma");
        headers.delete("expires");
        headers.delete("set-cookie");
        headers.delete("vary");
        headers.set("Cache-Control", `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`);

        const responseToReturn = new Response(response.body, {
          status: response.status,
          headers: headers
        });

        // บันทึกลง Cloudflare Edge Cache ในเบื้องหลัง
        if (cache && ctx && typeof ctx.waitUntil === 'function') {
          try {
            ctx.waitUntil(cache.put(cacheKey, responseToReturn.clone()));
          } catch (_) {}
        }

        return responseToReturn;
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
