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
const memoryAiCache = new Map(); // แคชในหน่วยความจำของ Worker ลดการใช้ KV put เป็น 0 สำหรับ AI
const memorySyncCache = new Map(); // แคชข้อมูลซิงก์ล่าสุดในหน่วยความจำ ป้องกันการเขียน KV ซ้ำซ้อน

async function getEdgeCacheJson(cacheKey) {
  if (memoryAiCache.has(cacheKey)) {
    const entry = memoryAiCache.get(cacheKey);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    memoryAiCache.delete(cacheKey);
  }
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const req = new Request(`https://edge-cache.cleanmanga.internal/${encodeURIComponent(cacheKey)}`);
      const res = await caches.default.match(req);
      if (res && res.ok) {
        const data = await res.json();
        memoryAiCache.set(cacheKey, { value: data, expiresAt: Date.now() + 3600 * 1000 });
        return data;
      }
    }
  } catch (e) {}
  return null;
}

async function putEdgeCacheJson(cacheKey, value, ttlSeconds = 86400) {
  memoryAiCache.set(cacheKey, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (memoryAiCache.size > 300) {
    const firstKey = memoryAiCache.keys().next().value;
    if (firstKey) memoryAiCache.delete(firstKey);
  }
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const req = new Request(`https://edge-cache.cleanmanga.internal/${encodeURIComponent(cacheKey)}`);
      const res = new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttlSeconds}`
        }
      });
      await caches.default.put(req, res);
    }
  } catch (e) {}
}

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

    const callTenixeChat = async (messages, maxTokens = 600) => {
      const models = ['claude-haiku-5-5', 'deepseek-v4-flash'];
      for (const model of models) {
        for (const key of TENIXE_KEYS) {
          try {
            const reqMaxTokens = model.includes('deepseek') ? Math.max(maxTokens, 3500) : maxTokens;
            const resp = await fetch('https://api.tenixe.com/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
              },
              body: JSON.stringify({
                model,
                messages,
                stream: false,
                max_tokens: reqMaxTokens
              }),
              signal: AbortSignal.timeout(15000)
            });

            if (!resp.ok) {
              if (resp.status === 429 || resp.status >= 500) break; // โมเดลต้นทางคิวเต็มหรือล่ม ให้ข้ามไปโมเดลถัดไปทันที
              continue;
            }

            const raw = await resp.text();
            if (raw.includes('"AI_PROVIDER_RATE_LIMITED"') || raw.includes('"upstream_rate_limited"') || raw.includes('"AI_PROVIDER_UNAVAILABLE"')) {
              break; // โมเดลต้นทางล่ม ข้ามไปโมเดลถัดไปทันที
            }
            if (raw.includes('"insufficient_quota"')) {
              continue; // คีย์นี้โควตาหมด ลองคีย์ถัดไป
            }

            try {
              const j = JSON.parse(raw);
              if (j.error) continue;
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
                    if (j.error) {
                      full = '';
                      break;
                    }
                    const delta = j.choices?.[0]?.delta?.content || '';
                    full += delta;
                  } catch (err) {}
                }
              }
              if (full.trim()) return full.trim();
            }
          } catch (e) {
            break; // Timeout หรือเครือข่ายผิดพลาด ข้ามไปโมเดลถัดไปทันที
          }
        }
      }

      // ด่านสำรองเมื่อ Tenixe API ปิดให้บริการหรือคีย์ทั้งหมดติดจำกัด: ใช้ Pollinations OpenAI-compatible ฟรีโดยไม่ต้องใช้คีย์
      try {
        const freeResp = await fetch('https://text.pollinations.ai/openai', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          },
          body: JSON.stringify({
            model: 'openai',
            messages
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (freeResp.ok) {
          const freeJson = await freeResp.json();
          const freeContent = freeJson.choices?.[0]?.message?.content;
          if (freeContent && freeContent.trim()) return freeContent.trim();
        }
      } catch (freeErr) {
        console.warn('Free AI fallback error:', freeErr);
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

          // ตรวจสอบการเรียกหรือเซสชันคุยเล่นกับ น้องมังงะ AI ✨ (ใช้ RAM + Edge Cache ไม่เปลือง KV put)
          const isBotNick = nickname.includes('น้องมังงะ') || nickname.includes('Bot') || nickname.includes('AI');
          const summonPattern = /(?:@ai|@บอท|\/ai|\bai\b|น้องมังงะ|บอท\s|เรียก\s*ai)/i;
          const isSummon = summonPattern.test(text);
          const stopPattern = /^(?:บาย|บ๊าย|ไปพัก|ไปนอน|เงียบก่อน|พอแล้ว|stop|\/stop|\/bye)/i;
          const isStop = stopPattern.test(text.trim());

          let now = Date.now();
          if (aiChatActiveUntil <= now) {
            const cachedUntil = await getEdgeCacheJson('ai_chat_active_until');
            if (cachedUntil && Number(cachedUntil) > now) {
              aiChatActiveUntil = Number(cachedUntil);
            }
          }
          const isAiSessionActive = aiChatActiveUntil > now;

          let needAiReply = false;
          if (isStop && (isSummon || isAiSessionActive)) {
            // สั่งให้น้องมังงะหยุดคุย / ไปพักผ่อน
            aiChatActiveUntil = 0;
            await putEdgeCacheJson('ai_chat_active_until', 0, 60);
            const byeMsg = {
              id: 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              nickname: 'น้องมังงะ AI ✨',
              text: 'โอเคเลยคับ ไว้เจอกันใหม่นะทุกคน พักผ่อนเยอะๆ น้า! 😴✨',
              mangaTitle: '',
              mangaUrl: '',
              time: Date.now()
            };
            updatedMessages = filterValidMessages([byeMsg, ...updatedMessages]);
          } else if (!isBotNick && (isSummon || isAiSessionActive)) {
            needAiReply = true;
            const newActiveUntil = Date.now() + 150000;
            aiChatActiveUntil = newActiveUntil;
            await putEdgeCacheJson('ai_chat_active_until', newActiveUntil, 300);
          }

          chatMessages = updatedMessages;
          await putEdgeCacheJson('chat_messages_edge', updatedMessages, 86400);

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
        await putEdgeCacheJson('chat_messages_edge', updatedMessages, 86400);

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
          const itemTouch = Math.max(Number(item.statusUpdatedAt || 0), itemSavedAt);
          const existTouch = Math.max(Number(existing.statusUpdatedAt || 0), existing.savedAt || 0);
          if (itemTouch >= existTouch) {
            map.set(itemKey, {
              ...existing,
              ...item,
              savedAt: Math.max(existing.savedAt || 0, itemSavedAt)
            });
          } else {
            map.set(itemKey, {
              ...item,
              ...existing,
              savedAt: Math.max(existing.savedAt || 0, itemSavedAt)
            });
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

    // สร้างลายเซ็นเปรียบเทียบข้อมูลซิงก์ เพื่อป้องกันการเขียน KV ซ้ำซ้อนเมื่อข้อมูลหลักไม่เปลี่ยน
    const computeSyncDigest = (d) => {
      if (!d) return '';
      return JSON.stringify({
        n: (d.nickname || '').trim(),
        f: (Array.isArray(d.favorites) ? d.favorites : []).map(x => [
          x.title || '',
          x.mangaUrl || '',
          x.savedAt || 0,
          x.readingStatus || 'reading',
          x.statusUpdatedAt || 0
        ]),
        h: (Array.isArray(d.history) ? d.history : []).map(x => [
          x.title || '',
          x.mangaUrl || '',
          x.lastChapterUrl || '',
          x.lastChapterTitle || '',
          Array.isArray(x.readChapters) ? x.readChapters.length : 0,
          x.lastReadPosition ? `${x.lastReadPosition.chapterUrl || ''}:${x.lastReadPosition.pageIndex || 0}` : ''
        ]),
        df: d.deletedFavorites || {},
        dh: d.deletedHistory || {},
        hc: Number(d.historyClearedAt || 0),
        sp: (Array.isArray(d.sourceProfiles) ? d.sourceProfiles : []).map(p => [p.id, p.updatedAt || 0, p.status || ''])
      });
    };

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

      let rawStored = memorySyncCache.get(key) || await getEdgeCacheJson(`sync_fallback_${key}`);

      if (env && env.CHAT_KV) {
        try {
          const kvStored = await env.CHAT_KV.get(`sync_data_${key}`, { type: 'json' });
          if (kvStored) {
            if (!rawStored || (Number(kvStored.lastSyncedAt || 0) >= Number(rawStored.lastSyncedAt || 0))) {
              rawStored = kvStored;
            }
          }
        } catch (e) {}
      }

      if (rawStored) {
        const delFavs = (typeof rawStored.deletedFavorites === 'object' && rawStored.deletedFavorites) ? rawStored.deletedFavorites : {};
        const delHist = (typeof rawStored.deletedHistory === 'object' && rawStored.deletedHistory) ? rawStored.deletedHistory : {};
        const clearedAt = Number(rawStored.historyClearedAt || 0);

        cloudData = {
          nickname: (rawStored.nickname || '').trim(),
          favorites: Array.isArray(rawStored.favorites) ? mergeFavoritesList(rawStored.favorites, [], delFavs) : [],
          history: Array.isArray(rawStored.history) ? mergeHistoryList(rawStored.history, [], delHist, clearedAt) : [],
          deletedFavorites: delFavs,
          deletedHistory: delHist,
          historyClearedAt: clearedAt,
          sourceProfiles: sanitizeSourceProfiles(rawStored.sourceProfiles),
          sourceSnapshots: sanitizeSourceSnapshots(rawStored.sourceSnapshots)
        };
      }

      return new Response(JSON.stringify({ success: true, data: cloudData }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
      });
    }

    // 2.4 บันทึกและ Smart Merge ข้อมูลข้ามอุปกรณ์ (ประหยัด KV put สูงสุด: เขียนเฉพาะเมื่อข้อมูลเปลี่ยนจริง)
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

        let rawStored = memorySyncCache.get(key) || await getEdgeCacheJson(`sync_fallback_${key}`);
        if (env && env.CHAT_KV) {
          try {
            const kvStored = await env.CHAT_KV.get(`sync_data_${key}`, { type: 'json' });
            if (kvStored) {
              if (!rawStored || (Number(kvStored.lastSyncedAt || 0) >= Number(rawStored.lastSyncedAt || 0))) {
                rawStored = kvStored;
              }
            }
          } catch (e) {}
        }

        if (rawStored) {
          existingData = {
            nickname: (rawStored.nickname || '').trim(),
            favorites: Array.isArray(rawStored.favorites) ? rawStored.favorites : [],
            history: Array.isArray(rawStored.history) ? rawStored.history : [],
            deletedFavorites: (typeof rawStored.deletedFavorites === 'object' && rawStored.deletedFavorites) ? rawStored.deletedFavorites : {},
            deletedHistory: (typeof rawStored.deletedHistory === 'object' && rawStored.deletedHistory) ? rawStored.deletedHistory : {},
            historyClearedAt: Number(rawStored.historyClearedAt || 0),
            sourceProfiles: sanitizeSourceProfiles(rawStored.sourceProfiles),
            sourceSnapshots: sanitizeSourceSnapshots(rawStored.sourceSnapshots)
          };
        }

        const beforeDigest = computeSyncDigest(existingData);

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

        const afterDigest = computeSyncDigest(resultData);

        // เก็บลงหน่วยความจำและ Edge Cache เสมอ (ฟรี 100% ไม่กินโควตา KV)
        memorySyncCache.set(key, resultData);
        if (memorySyncCache.size > 200) {
          const oldestKey = memorySyncCache.keys().next().value;
          if (oldestKey) memorySyncCache.delete(oldestKey);
        }
        await putEdgeCacheJson(`sync_fallback_${key}`, resultData, 172800);

        // เขียนลง KV เฉพาะเมื่อข้อมูลหลักมีการเปลี่ยนแปลงจากเดิมจริงๆ เท่านั้น!
        if (env && env.CHAT_KV && beforeDigest !== afterDigest) {
          try {
            await env.CHAT_KV.put(`sync_data_${key}`, JSON.stringify(resultData), {
              expirationTtl: TWO_YEARS_SECONDS // 730 วัน (2 ปี)
            });
          } catch (kvErr) {
            console.warn("Sync KV put skipped (quota or error):", kvErr.message);
          }
        }

        return new Response(JSON.stringify({ success: true, data: resultData, kvWritten: beforeDigest !== afterDigest }), {
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

    function repairTruncatedJson(str) {
      if (!str) return null;
      const jsonMatch = str.match(/\{[\s\S]*/);
      if (!jsonMatch) return null;
      let jsonStr = jsonMatch[0].trim();

      try {
        return JSON.parse(jsonStr);
      } catch (e) {}

      const lastColon = jsonStr.lastIndexOf(':');
      if (lastColon !== -1) {
        const afterColon = jsonStr.slice(lastColon + 1).trim();
        if (afterColon.startsWith('"')) {
          jsonStr = jsonStr + '"';
        } else if (afterColon.startsWith('[')) {
          jsonStr = jsonStr + ']';
        }
      }

      let openBraces = 0;
      let openBrackets = 0;
      let inString = false;
      let escape = false;

      for (let i = 0; i < jsonStr.length; i++) {
        const c = jsonStr[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (c === '\\') {
          escape = true;
          continue;
        }
        if (c === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (c === '{') openBraces++;
          else if (c === '}') openBraces--;
          else if (c === '[') openBrackets++;
          else if (c === ']') openBrackets--;
        }
      }

      if (inString) jsonStr += '"';
      while (openBrackets > 0) {
        jsonStr += ']';
        openBrackets--;
      }
      while (openBraces > 0) {
        jsonStr += '}';
        openBraces--;
      }

      try {
        return JSON.parse(jsonStr);
      } catch (err) {
        const coreKeywordsMatch = str.match(/"coreKeywords"\s*:\s*\[([\s\S]*?)\]/);
        const famousTitlesMatch = str.match(/"famousTitles"\s*:\s*\[([\s\S]*?)\]/);
        const keywordsMatch = str.match(/"keywords"\s*:\s*\[([\s\S]*?)\]/);
        const summaryMatch = str.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)/);

        const safeParseArray = (s) => {
          try { return JSON.parse(`[${s}]`); } catch (_) { return []; }
        };

        if (coreKeywordsMatch || famousTitlesMatch || keywordsMatch) {
          return {
            coreKeywords: safeParseArray(coreKeywordsMatch ? coreKeywordsMatch[1] : ''),
            famousTitles: safeParseArray(famousTitlesMatch ? famousTitlesMatch[1] : ''),
            keywords: safeParseArray(keywordsMatch ? keywordsMatch[1] : ''),
            summary: summaryMatch ? summaryMatch[1] : ''
          };
        }
      }
      return null;
    }

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

      const cacheKey = 'ai_search_v3_' + encodeURIComponent(query.toLowerCase().replace(/\s+/g, '_').slice(0, 70));

      // ตรวจสอบ Edge Cache / RAM (ใช้โควตา KV = 0)
      const cachedSearch = await getEdgeCacheJson(cacheKey);
      if (cachedSearch && Array.isArray(cachedSearch.keywords) && (Array.isArray(cachedSearch.coreKeywords) || Array.isArray(cachedSearch.famousTitles) || (cachedSearch.genres && cachedSearch.genres.length > 0))) {
        return new Response(JSON.stringify({ success: true, ...cachedSearch, fromCache: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" }
        });
      }

      const messages = [
        {
          role: 'system',
          content: `You are an expert manga semantic search engine.
The user searches for manga using story plots, character concepts, feelings, or tropes in Thai or English.
1. Extract "coreKeywords": The MUST-HAVE primary subject, tropes, or themes in BOTH English and Thai (e.g. if query has "พนัน", include ["gambling", "gamble", "casino", "พนัน", "การพนัน"]).
2. Extract "famousTitles": Famous manga titles matching this trope in English / Japanese Romaji (e.g. for "พนัน" / gambling, include ["Kakegurui", "Kaiji", "Liar Game", "Usogui", "Gamble Fish"]).
3. Extract "qualifiers": Secondary attributes, tropes, tags in BOTH English and Thai.
4. Extract "genres": High-level broad genres (e.g. ["Psychological", "Drama", "Seinen"]).
5. Set "isAdult": boolean true if query relates to 18+, sex, erotica, hentai, ecchi; false otherwise.
6. Provide "summary": 1-line punchy Thai summary.

Output ONLY valid JSON in format:
{
  "coreKeywords": ["gambling", "gamble", "พนัน", "การพนัน"],
  "famousTitles": ["Kakegurui", "Kaiji", "Liar Game"],
  "qualifiers": ["psychological", "mind games", "จิตวิทยา", "เดิมพัน"],
  "genres": ["Psychological", "Drama"],
  "keywords": ["gambling", "พนัน", "การพนัน", "kakegurui", "kaiji"],
  "isAdult": false,
  "summary": "มังงะแนวเดิมพันและการพนันสุดระทึก ชิงไหวชิงพริบ จิตวิทยา"
}`
        },
        {
          role: 'user',
          content: query
        }
      ];

      const aiText = await callTenixeChat(messages, 700);
      let parsedResult = null;
      if (aiText) {
        parsedResult = repairTruncatedJson(aiText);
      }

      if (!parsedResult) {
        const basicKeywords = query.split(/[\s,+/]+/).filter(w => w.length >= 2);
        parsedResult = {
          coreKeywords: basicKeywords,
          famousTitles: [],
          keywords: basicKeywords,
          genres: [],
          summary: query
        };
      }

      // บันทึกลง Edge Cache + RAM เฉพาะเมื่อได้ผลลัพธ์ที่มีคุณภาพ (ใช้โควตา KV put = 0)
      if (parsedResult.coreKeywords?.length > 1 || parsedResult.famousTitles?.length > 0 || parsedResult.genres?.length > 0) {
        await putEdgeCacheJson(cacheKey, parsedResult, 604800); // 7 วัน
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

      // ตรวจสอบ Edge Cache / RAM (ไม่กินโควตา KV)
      const cachedCover = await getEdgeCacheJson(cacheKey);
      if (cachedCover) {
        return new Response(JSON.stringify({ success: true, coverUrl: cachedCover, cached: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=2592000" }
        });
      }

      // Prompt Engineering สำหรับภาพปกการ์ตูนคุณภาพสูง
      const imagePrompt = `Masterpiece official anime manga cover art, high-end Korean webtoon key visual, highly detailed character portrait, dramatic cinematic lighting, clean vibrant background, official light novel illustration for the title: "${title}", trending on pixiv, 8k resolution, no watermark, no text distortion, clean aesthetic`;

      const genResult = await callTenixeImage(imagePrompt);

      if (genResult.success && genResult.url) {
        // บันทึกลง Edge Cache + RAM (เก็บไว้ 60 วัน ใช้โควตา KV put = 0)
        await putEdgeCacheJson(cacheKey, genResult.url, 5184000);

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
      let genre = url.searchParams.get('genre') || '';
      if (!title && request.method === 'POST') {
        try {
          const body = await request.json();
          title = body.title || '';
          synopsis = body.synopsis || synopsis;
          genre = body.genre || genre;
        } catch (e) {}
      }
      title = String(title).trim().slice(0, 150);
      synopsis = String(synopsis).trim().slice(0, 1500);
      genre = String(genre).trim().slice(0, 250);

      if (!title) {
        return new Response(JSON.stringify({ success: false, error: "กรุณาระบุชื่อเรื่องมังงะ" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const isFakeSummaryText = (txt) => {
        if (!txt) return true;
        return txt.includes('การเดินทางสุดเข้มข้นของ') ||
               txt.includes('• เรื่องย่อของ "') ||
               txt.includes('• เรื่องราวการเดินทาง') ||
               txt.includes('เผชิญกับศัตรูและปริศนาที่ท้าทายขีดจำกัด') ||
               txt.includes('ฉันไม่มีข้อมูล') ||
               txt.includes('ไม่สามารถสรุปเนื้อเรื่อง') ||
               txt.includes('หากคุณส่งเรื่องย่อ');
      };

      const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
      const cacheKey = 'ai_summary_v5_' + encodeURIComponent(title.toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, '_').slice(0, 70));

      // ตรวจสอบ Edge Cache / RAM (ข้ามถ้าสั่ง forceRefresh — ใช้โควตา KV = 0)
      if (!forceRefresh) {
        const cached = await getEdgeCacheJson(cacheKey);
        if (cached && cached.summary && !isFakeSummaryText(cached.summary)) {
          return new Response(JSON.stringify({ success: true, ...cached, fromCache: true }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=2592000" }
          });
        }
      }

      const summaryPrompt = `คุณคือผู้เชี่ยวชาญการ์ตูน มังงะ และมังฮวาเกาหลี สรุปแนะนำเนื้อเรื่องย่อ 3 บรรทัดเป็นภาษาไทยที่สละสลวย น่าอ่าน และดึงดูดใจ
ความยาว 3 บรรทัดพอดี (แต่ละบรรทัดสั้นกระชับ 1-2 ประโยค และขึ้นต้นด้วย bullet •)
• บรรทัด 1: แนะนำตัวเอก ภูมิหลัง และจุดเริ่มต้นของเรื่องราวหรือความสัมพันธ์
• บรรทัด 2: เหตุการณ์สำคัญ ความลับ ปัญหา หรือความขัดแย้งหลักที่เกิดขึ้น
• บรรทัด 3: จุดเปลี่ยน เป้าหมาย หรือเสน่ห์ความน่าติดตามของเรื่องนี้
พร้อมแท็กอารมณ์เรื่องภาษาไทย (Mood Tags) 3 แท็ก และคำโปรยภาษาไทย 1 ประโยค (oneLiner)
กฎสำคัญ:
1. หากมีเนื้อเรื่องย่ออ้างอิงแนบมา ให้สรุปจากเนื้อเรื่องย่ออ้างอิงนั้นโดยตรง
2. หากไม่มีเนื้อเรื่องย่ออ้างอิง ให้ใช้ความรู้เกี่ยวกับเรื่องนี้ หรือเรียบเรียงบทนำเรื่องย่อตามชื่อเรื่องและหมวดหมู่ที่ระบุให้ตรงแนวเรื่องจริง (หากไม่ทราบชื่อตัวละครที่แน่ชัด ห้ามตั้งชื่อตัวละครมั่วขึ้นมาเอง ให้ใช้คำว่า "ตัวเอก" หรือคำเรียกตามบทบาทแทน)
3. ห้ามตอบปฏิเสธเด็ดขาด (ห้ามพิมพ์คำว่า "ฉันไม่มีข้อมูล", "ไม่พบข้อมูล", "หากคุณส่งเรื่องย่อมาให้" หรือคำชี้แจงใดๆ) ให้เขียนสรุปเนื้อเรื่อง 3 บรรทัดทันที!
ตอบเป็น JSON เท่านั้นในรูปแบบ:
{"summary":"• บรรทัดที่ 1...\\n• บรรทัดที่ 2...\\n• บรรทัดที่ 3...","moodTags":["#แท็ก1","#แท็ก2","#แท็ก3"],"oneLiner":"คำโปรย 1 ประโยค"}`;

      const promptUserContent = `มังงะ/มังฮวา: "${title}"${genre ? `\nประเภท/หมวดหมู่: ${genre}` : ''}${synopsis ? `\nเนื้อเรื่องย่ออ้างอิง:\n${synopsis}` : ''}`;
      const aiText = await callTenixeChat([
        { role: 'system', content: summaryPrompt },
        { role: 'user', content: promptUserContent }
      ], 650);

      let parsedResult = null;
      if (aiText) {
        try {
          const jsonMatch = aiText.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsedResult = JSON.parse(jsonMatch[0]);
        } catch (e) {}

        if (!parsedResult || !parsedResult.summary) {
          parsedResult = repairTruncatedJson(aiText);
        }

        // กรณี JSON โดนตัดท้าย ให้ดึงฟิลด์ summary ออกมาด้วย regex
        if (!parsedResult || !parsedResult.summary) {
          const summaryMatch = aiText.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)/);
          if (summaryMatch) {
            try {
              const extractedSummary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
              const moodMatch = aiText.match(/"moodTags"\s*:\s*\[([\s\S]*?)\]/);
              let moodTags = ["#น่าติดตาม", "#เรื่องเด็ด", "#มังงะแนะนำ"];
              if (moodMatch) {
                try { moodTags = JSON.parse(`[${moodMatch[1]}]`); } catch (e) {}
              }
              const oneLinerMatch = aiText.match(/"oneLiner"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)/);
              let oneLiner = oneLinerMatch ? oneLinerMatch[1].replace(/\\"/g, '"').trim() : `เรื่องราวเข้มข้นของ ${title}`;
              parsedResult = { summary: extractedSummary, moodTags, oneLiner };
            } catch (e) {}
          }
        }
      }

      if (!parsedResult || !parsedResult.summary) {
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
        }
      }

      if (!parsedResult || !parsedResult.summary || isFakeSummaryText(parsedResult.summary)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'AI_UNAVAILABLE'
        }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
        });
      }

      // บันทึกลง Edge Cache + RAM เฉพาะเมื่อได้สรุปจริงเท่านั้น (เก็บไว้ 30 วัน ใช้โควตา KV put = 0)
      await putEdgeCacheJson(cacheKey, parsedResult, 2592000);

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

      // ตรวจสอบ Cloudflare Edge Cache เฉพาะคำขอรูปภาพ (ส่วนหน้าเว็บ HTML/JSON ดึงสดเสมอเพื่อให้อัปเดตตามเว็บต้นทางทันที)
      const isLikelyImageUrl = /\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(targetUrl);
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const cacheKey = new Request(request.url, { method: "GET" });
      if (cache && request.method === "GET" && isLikelyImageUrl) {
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
      if (origin.includes("osemocphoto") || targetUrl.includes("osemocphoto") || origin.includes("nekopost") || targetUrl.includes("nekopost")) {
        refererHeader = "https://www.nekopost.net/";
      } else if (customReferer) {
        refererHeader = customReferer;
      } else if (origin.includes("ntrnaja") || targetUrl.includes("ntrnaja")) {
        refererHeader = "https://ntrnaja.com/";
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
      } else if (origin.includes("whytoon") || targetUrl.includes("whytoon")) {
        refererHeader = "https://whytoon.com/";
      } else if (origin.includes("dongmanga") || targetUrl.includes("dongmanga")) {
        refererHeader = "https://dongmanga.com/";
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
      
      // แคชเฉพาะรูปภาพ (7 วัน) ส่วนหน้าเว็บ HTML/JSON ไม่แคชเพื่อให้รายการมังงะอัปเดตสดตามเว็บต้นทางเสมอ
      if (request.method === "GET" && response.status === 200) {
        const contentType = (headers.get("Content-Type") || "").toLowerCase();
        const isImage = contentType.startsWith("image/") || isLikelyImageUrl;

        headers.delete("pragma");
        headers.delete("expires");
        headers.delete("set-cookie");
        headers.delete("vary");

        if (isImage) {
          const cacheSeconds = 604800; // 7 วันสำหรับรูปภาพ
          headers.set("Cache-Control", `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`);

          const responseToReturn = new Response(response.body, {
            status: response.status,
            headers: headers
          });

          if (cache && ctx && typeof ctx.waitUntil === 'function') {
            try {
              ctx.waitUntil(cache.put(cacheKey, responseToReturn.clone()));
            } catch (_) {}
          }

          return responseToReturn;
        } else {
          headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
          return new Response(response.body, {
            status: response.status,
            headers: headers
          });
        }
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
