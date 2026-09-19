// Clean Manga Reader - Mega Aggregator & Reader Engine

let allMangaList = [];          // คลังรวมมังงะทุกเรื่องจากทุกเว็บ
let filteredList = [];          // มังงะที่ผ่านการค้นหาหรือฟิลเตอร์
let currentSourceFilter = 'all';// แหล่งที่เลือก ('all' หรือ id เช่น 'go-manga', 'slow-manga')
let currentTagFilter = 'all';   // หมวดหมู่ที่เลือก ('all', 'manhwa', 'action', ...)
let currentSearchQuery = '';    // ข้อความค้นหา
let currentDisplayCount = 40;   // แสดงครั้งละ 40 เรื่อง
let loadedPagesPerSource = 1;

// ตัวช่วยสร้าง URL ผ่าน Proxy (รองรับการส่ง Referer ข้ามเว็บ เช่น webtoon168 ของ Ped-Manga)
function getProxyUrl(targetUrl, referer = '') {
  if (!targetUrl) return '';
  let url = `${CONFIG.PROXY_URL}${encodeURIComponent(targetUrl)}`;
  if (referer) {
    url += `&referer=${encodeURIComponent(referer)}`;
  } else if (targetUrl.includes('webtoon168')) {
    url += `&referer=${encodeURIComponent('https://ped-manga.com/')}`;
  } else if (targetUrl.includes('chibi-manga')) {
    url += `&referer=${encodeURIComponent('https://chibi-manga.com/')}`;
  }
  return url;
}

// 1. ดึงข้อมูลผ่าน Proxy พร้อม Timeout และรองรับ GET / POST
async function fetchViaProxy(targetUrl, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proxyUrl = getProxyUrl(targetUrl);
    const fetchOpts = {
      signal: controller.signal,
      ...options
    };
    const response = await fetch(proxyUrl, fetchOpts);
    clearTimeout(id);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    return await response.text();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// 2. แกะรูปภาพอย่างละเอียดทุก attribute ป้องกันรูปบั๊ก (รองรับ WP Fastest Cache, WP Rocket, LiteSpeed ฯลฯ)
function extractCoverUrl(imgEl, baseUrl) {
  if (!imgEl) return '';
  let src = imgEl.getAttribute('data-wpfc-original-src') || 
            imgEl.getAttribute('data-src') || 
            imgEl.getAttribute('data-lazy-src') || 
            imgEl.getAttribute('data-original') || 
            imgEl.getAttribute('data-orig-file') ||
            imgEl.getAttribute('data-cfsrc') ||
            imgEl.getAttribute('data-lazy') ||
            imgEl.getAttribute('data-url') ||
            imgEl.getAttribute('src') || '';

  // หาก src เป็น data:image (base64 ว่าง) หรือ blank.gif ให้ลองดึงจาก srcset
  if (!src || src.startsWith('data:image') || src.includes('blank.gif')) {
    const srcset = imgEl.getAttribute('data-wpfc-original-srcset') || 
                   imgEl.getAttribute('data-lazy-srcset') || 
                   imgEl.getAttribute('srcset') || '';
    if (srcset) {
      const candidates = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
      const valid = candidates.find(c => !c.startsWith('data:image') && !c.includes('blank.gif'));
      if (valid) src = valid;
    }
  }

  // ปรับ decode HTML entity เช่น &amp;
  src = src.replace(/&amp;/g, '&').trim();

  if (src.includes('data:image') || src.includes('blank.gif') || src.includes('gravatar')) {
    src = '';
  }

  if (src.startsWith('//')) {
    src = 'https:' + src;
  } else if (baseUrl && baseUrl.includes('whytoon') && (src.startsWith('content/') || src.startsWith('/content/'))) {
    src = 'https://gd.whytoon.com/' + src.replace(/^\/+/, '');
  } else if (baseUrl && baseUrl.includes('readtoon') && (src.startsWith('content/') || src.startsWith('/content/'))) {
    src = 'https://w.nobuild.pro/' + src.replace(/^\/+/, '');
  } else if (src.startsWith('/')) {
    src = baseUrl.replace(/\/$/, '') + src;
  }

  return src;
}

// 3. แกะข้อมูลมังงะจากเว็บตระกูล MangaReader (Go, Fin, Dark, Up, Slow, NTR-Manga, Ped-Manga, MangaStep, Ecchi-Doujin)
function parseMangaReaderHtml(html, sourceInfo) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];
  const seenUrls = new Set();

  const cards = doc.querySelectorAll('.bsx, .animposx, .listupd .uta, .ntr-upd-card, .top10manga li');
  cards.forEach(card => {
    const linkEl = card.querySelector('a.ntr-upd-title, a.ntr-upd-cover, a.series, a');
    const titleEl = card.querySelector('.ntr-upd-title h3, .tt, h2, h3, .title, h4');
    const imgEl = card.querySelector('img');
    const epNumEl = card.querySelector('.ntr-upd-epnum');
    const epEl = card.querySelector('.epxs, .eggchap, .fivchap, .chfiv li a, .ntr-upd-ep, .luf ul li a, ul li a');
    const typeEl = card.querySelector('.typename, .type');

    if (linkEl && (titleEl || linkEl.getAttribute('title'))) {
      let mangaUrl = linkEl.getAttribute('href') || '';
      let title = titleEl ? titleEl.textContent.trim() : (linkEl.getAttribute('title') || '').trim();
      let latestEp = 'ตอนล่าสุด';

      if (epNumEl) {
        latestEp = epNumEl.textContent.trim();
      } else if (epEl) {
        const clone = epEl.cloneNode(true);
        clone.querySelectorAll('.ntr-upd-eptime, .date, .time, time, i, span').forEach(t => t.remove());
        latestEp = clone.textContent.trim();
      }

      // กรองคำระบุเวลาออก เช่น "2 ชั่วโมงที่แล้ว", "3 วันที่แล้ว" เพื่อไม่ให้เลขเวลามาซ้อนทับกับเลขตอน
      latestEp = latestEp.replace(/\s*\d+\s*(?:ชั่วโมง|นาที|วัน|วินาที|ชม\.|วัน|เดือน|ปี|hours?|mins?|days?|ago)\s*(?:ที่แล้ว|ago)?/gi, '').trim() || latestEp;

      let type = typeEl ? typeEl.textContent.trim() : (sourceInfo.name.includes('Doujin') || sourceInfo.name.includes('Ecchi') ? '18+ / Doujin' : 'Manga');
      let cover = extractCoverUrl(imgEl, sourceInfo.url);

      if (mangaUrl.startsWith('/')) mangaUrl = sourceInfo.url + mangaUrl;

      if (title && mangaUrl && !seenUrls.has(mangaUrl)) {
        seenUrls.add(mangaUrl);
        items.push({
          title,
          mangaUrl,
          cover,
          latestEp,
          type,
          sourceId: sourceInfo.id,
          sourceName: sourceInfo.name,
          sourceUrl: sourceInfo.url,
          sourceType: 'mangareader',
          readable: sourceInfo.readable !== false,
          isCoin: !!sourceInfo.isCoin,
          icon: sourceInfo.icon || '⚡'
        });
      }
    }
  });

  return items;
}

// 4. แกะข้อมูลจาก WhyToon
function parseWhyToonHtml(html, sourceInfo) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];

  const contentCards = doc.querySelectorAll('a[href^="/content/"]');
  contentCards.forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === '/content' || href.includes('/chapter-') || href.match(/\/content\/[^/]+\/\d+/)) return;

    const imgEl = a.querySelector('img');
    const titleEl = a.querySelector('h3, .font-bold');
    const epEl = a.querySelector('.content-card-episode, span');

    if (titleEl) {
      let title = titleEl.textContent.trim();
      let mangaUrl = sourceInfo.url + href;
      let cover = extractCoverUrl(imgEl, sourceInfo.url);
      
      if (!cover) {
        const slug = href.replace(/^\/content\//, '').replace(/\/$/, '');
        const rscMatch = html.match(new RegExp(`"slug":"${slug}"[^{}]*?"thumbnailImage":"([^"]+)"`));
        if (rscMatch) {
          cover = 'https://gd.whytoon.com/' + rscMatch[1].replace(/^\/+/, '');
        }
      }

      let latestEp = epEl ? epEl.textContent.trim().replace(/\s+/g, ' ') : 'ตอนล่าสุด';

      items.push({
        title,
        mangaUrl,
        cover,
        latestEp,
        type: 'Webtoon',
        sourceId: sourceInfo.id,
        sourceName: sourceInfo.name,
        sourceUrl: sourceInfo.url,
        sourceType: 'whytoon',
        readable: sourceInfo.readable !== false,
        isCoin: !!sourceInfo.isCoin,
        icon: sourceInfo.icon || '📱'
      });
    }
  });

  return items;
}

// 5. แกะข้อมูลจาก ReadToon
function parseReadToonHtml(html, sourceInfo) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];
  const seenUrls = new Set();

  const cards = doc.querySelectorAll('a[href^="/content/"]');
  cards.forEach(a => {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || href === '/content' || href.match(/\/content\/[^/]+\/\d+/)) return;
    if (seenUrls.has(href)) return;
    seenUrls.add(href);

    const imgEl = a.querySelector('img');
    const altTitle = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
    const titleEl = a.parentElement ? a.parentElement.querySelector('h3, .font-bold, .title') : null;
    let title = (titleEl ? titleEl.textContent.trim() : '') || altTitle;

    if (!title) {
      title = href.replace(/^\/content\//, '').replace(/\/$/, '');
    }

    let cover = extractCoverUrl(imgEl, sourceInfo.url);
    if (!cover && imgEl && imgEl.getAttribute('src')) {
      cover = imgEl.getAttribute('src');
    }

    const mangaUrl = sourceInfo.url.replace(/\/$/, '') + href;

    items.push({
      title,
      mangaUrl,
      cover,
      latestEp: 'ตอนล่าสุด',
      type: 'Webtoon',
      sourceId: sourceInfo.id,
      sourceName: sourceInfo.name,
      sourceUrl: sourceInfo.url,
      sourceType: 'readtoon',
      readable: sourceInfo.readable !== false,
      isCoin: !!sourceInfo.isCoin,
      icon: sourceInfo.icon || '🔒'
    });
  });

  return items;
}

// 6. แกะข้อมูลจาก NTRnaja
function parseNtrNajaHtml(html, sourceInfo) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];
  const seenUrls = new Set();

  const cards = doc.querySelectorAll('a.ntr-genre-card, .ntr-genre-card, a[href*="/manga/m-"]');
  cards.forEach(card => {
    let mangaUrl = card.getAttribute('href') || '';
    if (!mangaUrl || seenUrls.has(mangaUrl)) return;
    seenUrls.add(mangaUrl);

    let title = card.getAttribute('data-title') || '';
    const titleEl = card.querySelector('.ntr-genre-card__title, h2, h3');
    if (titleEl && !title) title = titleEl.textContent.trim();

    const metaEl = card.querySelector('.ntr-genre-card__meta');
    const ntrCache = getNtrChapterCache();
    let latestEp = ntrCache[mangaUrl] || 'ตอนล่าสุด';
    if (!latestEp || latestEp === 'ตอนล่าสุด') {
      if (metaEl) {
        const metaText = metaEl.textContent.trim();
        // หากเป็นวันที่ เช่น "อัปเดต 2026-09-18" ห้ามนำมาเป็นชื่อตอน ให้ใช้ "ตอนล่าสุด"
        if (!/อัปเดต|อัพเดต|\b\d{4}-\d{2}-\d{2}\b/i.test(metaText)) {
          latestEp = metaText;
        }
      }
    }

    const imgEl = card.querySelector('img.ntr-genre-thumb__img, img');
    let cover = extractCoverUrl(imgEl, sourceInfo.url);

    if (mangaUrl.startsWith('/')) mangaUrl = sourceInfo.url + mangaUrl;

    if (title) {
      items.push({
        title,
        mangaUrl,
        cover,
        latestEp,
        type: 'Manhwa',
        sourceId: sourceInfo.id,
        sourceName: sourceInfo.name,
        sourceUrl: sourceInfo.url,
        sourceType: 'ntrnaja',
        readable: sourceInfo.readable !== false,
        isCoin: !!sourceInfo.isCoin,
        icon: sourceInfo.icon || '🔒'
      });
    }
  });

  return items;
}

// ระบบแคชและสแกนเลขตอนล่าสุดของ NTRnaja เบื้องหลังแบบ Progressive (ให้หน้าแรกโชว์เลขตอนจริง ไม่หน่วง)
const NTR_CH_CACHE_KEY = 'clean_manga_ntrnaja_ch_cache';
function getNtrChapterCache() {
  try {
    return JSON.parse(localStorage.getItem(NTR_CH_CACHE_KEY) || sessionStorage.getItem(NTR_CH_CACHE_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveNtrChapterCache(url, epTitle) {
  if (!url || !epTitle) return;
  try {
    const cache = getNtrChapterCache();
    cache[url] = epTitle;
    const json = JSON.stringify(cache);
    sessionStorage.setItem(NTR_CH_CACHE_KEY, json);
    localStorage.setItem(NTR_CH_CACHE_KEY, json);
  } catch (e) {}
}

function updateCardLatestEpInDom(mangaUrl, title, newEp) {
  if (!newEp) return;
  const cards = document.querySelectorAll('.manga-card');
  cards.forEach(card => {
    if ((mangaUrl && card.dataset.url === mangaUrl) || (title && card.dataset.title === title)) {
      const epEl = card.querySelector('.manga-latest-ep, .manga-latest span:first-child');
      if (epEl) {
        epEl.textContent = newEp;
      }
    }
  });
}

async function probeNtrnajaChapters(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const cache = getNtrChapterCache();

  // กรองเฉพาะเรื่องที่ยังไม่มีเลขตอน (เช่น ยังเป็น 'ตอนล่าสุด')
  const toProbe = items.filter(m => {
    if (!m.mangaUrl) return false;
    if (cache[m.mangaUrl]) {
      m.latestEp = cache[m.mangaUrl];
      return false;
    }
    return !m.latestEp || !m.latestEp.startsWith('ตอนที่');
  });

  if (toProbe.length === 0) return;

  const queue = [...toProbe];
  const BATCH_SIZE = 3;
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);
    await Promise.allSettled(batch.map(async (m) => {
      try {
        const html = await fetchViaProxy(m.mangaUrl, {}, 6000);
        const matchTitle = html.match(/class="ss-ch-title">\s*(ตอนที่\s*\d+(?:\.\d+)?)/i);
        const matchTotal = html.match(/id="ss-total">\s*(\d+)\s*<\/span>\s*ตอน/i);
        const matchBtn = html.match(/class="ss-btn[^"]*"[^>]*chapter=-?(\d+(?:\.\d+)?)/i);

        let foundEp = '';
        if (matchTitle) {
          foundEp = matchTitle[1];
        } else if (matchTotal) {
          foundEp = `ตอนที่ ${matchTotal[1]}`;
        } else if (matchBtn) {
          foundEp = `ตอนที่ ${matchBtn[1]}`;
        }

        if (foundEp) {
          m.latestEp = foundEp;
          saveNtrChapterCache(m.mangaUrl, foundEp);
          updateCardLatestEpInDom(m.mangaUrl, m.title, foundEp);
        }
      } catch (err) {}
    }));
  }
}

// 7. แกะข้อมูลจาก Kairew
function parseKairewHtml(html, sourceInfo) {
  const items = [];
  try {
    const m = html.match(/data-page="([^"]+)"/);
    if (m) {
      const decoded = m[1].replace(/&quot;/g, '"');
      const data = JSON.parse(decoded);
      const list = data?.props?.manga_list || data?.props?.featured_list || data?.props?.banner_list || [];
      list.forEach(item => {
        if (item.title || item.name) {
          items.push({
            title: item.title || item.name,
            mangaUrl: `${sourceInfo.url}/manga/${item.slug || item.id}`,
            cover: item.cover_url || item.thumbnail || '',
            latestEp: item.latest_chapter ? `ตอนที่ ${item.latest_chapter}` : 'ตอนล่าสุด',
            type: item.type || 'Manga',
            sourceId: sourceInfo.id,
            sourceName: sourceInfo.name,
            sourceUrl: sourceInfo.url,
            sourceType: 'kairew',
            readable: sourceInfo.readable !== false,
            isCoin: !!sourceInfo.isCoin,
            icon: sourceInfo.icon || '🔒'
          });
        }
      });
    }
  } catch (e) {
    console.warn("Kairew parse error:", e);
  }
  return items;
}

// 7. แกะข้อมูลมังงะจากเว็บตระกูล WordPress Madara Theme (Du-Manga, Manga-LC)
function parseMadaraHtml(html, sourceInfo) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];
  const seenUrls = new Set();

  const cards = doc.querySelectorAll('.page-item-detail, .c-tabs-item__content, .page-listing-item, .col-6.col-md-3, .col-6.col-md-2, .badge-pos-1');

  cards.forEach(card => {
    const titleEl = card.querySelector('.post-title a, h3 a, h5 a, .item-summary a');
    const imgEl = card.querySelector('img');
    const epEl = card.querySelector('.chapter a, .chapter-item a, .font-meta a, .list-chapter a');
    const typeEl = card.querySelector('.manga-type, .type, .genres');

    if (titleEl) {
      let mangaUrl = titleEl.getAttribute('href') || '';
      let title = titleEl.textContent.trim();
      let latestEp = epEl ? epEl.textContent.trim() : 'ตอนล่าสุด';
      let type = typeEl ? typeEl.textContent.trim() : 'Manhwa / Manga';
      let cover = extractCoverUrl(imgEl, sourceInfo.url);

      if (mangaUrl.startsWith('/')) mangaUrl = sourceInfo.url.replace(/\/$/, '') + mangaUrl;

      if (title && mangaUrl && !seenUrls.has(mangaUrl)) {
        seenUrls.add(mangaUrl);
        items.push({
          title,
          mangaUrl,
          cover,
          latestEp,
          type,
          sourceId: sourceInfo.id,
          sourceName: sourceInfo.name,
          sourceUrl: sourceInfo.url,
          sourceType: 'madara',
          readable: sourceInfo.readable !== false,
          isCoin: !!sourceInfo.isCoin,
          icon: sourceInfo.icon || '📖'
        });
      }
    }
  });

  return items;
}

// 7.1 แกะข้อมูลมังงะจาก MangaTown (ภาษาอังกฤษ)
function parseMangaTownHtml(html, sourceInfo) {
  if (!html) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];
  const seenUrls = new Set();
  const listItems = doc.querySelectorAll('.manga_pic_list li');

  listItems.forEach(li => {
    try {
      const titleLink = li.querySelector('.title a');
      if (!titleLink) return;
      const title = titleLink.getAttribute('title') || titleLink.textContent.trim();
      let mangaUrl = titleLink.getAttribute('href') || '';
      if (!mangaUrl) return;
      if (mangaUrl.startsWith('/')) mangaUrl = 'https://www.mangatown.com' + mangaUrl;

      if (seenUrls.has(mangaUrl)) return;
      seenUrls.add(mangaUrl);

      const coverImg = li.querySelector('.manga_cover img');
      let cover = coverImg ? (coverImg.getAttribute('src') || '') : '';
      if (cover.startsWith('//')) cover = 'https:' + cover;

      const chLink = li.querySelector('.new_chapter a');
      let latestEp = chLink ? chLink.textContent.trim() : 'ตอนล่าสุด (EN)';

      const kwLinks = Array.from(li.querySelectorAll('.keyWord a')).map(a => a.textContent.trim());
      let type = 'Manga';
      if (kwLinks.some(k => /manhwa/i.test(k))) type = 'Manhwa';
      else if (kwLinks.some(k => /manhua/i.test(k))) type = 'Manhua';

      items.push({
        title,
        mangaUrl,
        cover,
        latestEp,
        type,
        tags: kwLinks,
        sourceId: sourceInfo.id,
        sourceName: sourceInfo.name,
        sourceUrl: sourceInfo.url,
        sourceType: 'mangatown',
        readable: true,
        isCoin: false,
        icon: sourceInfo.icon || '🏙️',
        lang: 'en'
      });
    } catch (e) {}
  });

  return items;
}

// 7.2 แกะข้อมูลมังงะจาก Asura Scans (ภาษาอังกฤษ)
function parseAsuraScansHtml(html, sourceInfo) {
  if (!html) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];
  const seenUrls = new Set();

  const comicLinks = doc.querySelectorAll('a[href*="/comics/"]');
  comicLinks.forEach(a => {
    try {
      let href = (a.getAttribute('href') || '').trim();
      if (!href || href === '/comics' || href.includes('/browse/') || href.includes('/bookmarks/')) return;
      if (href.startsWith('/')) href = 'https://asurascans.com' + href;

      if (seenUrls.has(href)) return;

      const img = a.querySelector('img');
      const cover = img ? (img.getAttribute('src') || '') : '';
      let title = img ? (img.getAttribute('alt') || '') : '';
      if (!title) {
        const titleEl = a.querySelector('.font-bold, h2, h3, h4, span.font-medium, .text-white');
        title = titleEl ? titleEl.textContent.trim() : '';
      }
      if (!title) {
        const slug = href.split('/comics/')[1] || '';
        title = decodeURIComponent(slug.replace(/-[a-f0-9]{8}$/i, '').replace(/[-_]/g, ' ')).trim();
      }

      if (!title || title.length < 2) return;
      seenUrls.add(href);

      // ตรวจสอบตอนล่าสุดถ้ามีระบุใน card
      const epEl = a.parentElement ? a.parentElement.querySelector('a[href*="/chapter/"], span:contains("Chapter")') : null;
      let latestEp = epEl ? epEl.textContent.trim() : 'ตอนล่าสุด (EN)';

      let type = 'Manhwa';
      if (/manga/i.test(title)) type = 'Manga';

      items.push({
        title,
        mangaUrl: href,
        cover,
        latestEp,
        type,
        sourceId: sourceInfo.id,
        sourceName: sourceInfo.name,
        sourceUrl: sourceInfo.url,
        sourceType: 'asurascans',
        readable: true,
        isCoin: false,
        icon: sourceInfo.icon || '⚔️',
        lang: 'en'
      });
    } catch (e) {}
  });

  return items;
}


// รายชื่อจับคู่เรื่องข้ามเว็บที่เป็นเรื่องเดียวกันแต่ชื่อต่างกัน (Aliases Map)
const KNOWN_MANGA_ALIASES = [
  {
    keys: ['ผมแต่งงานกับมังกรที่ผมเคยฆ่า', 'ข้าแต่งงานกับมังกรที่ข้าฆ่า', 'imarriedthedragonikilled', 'แต่งงานกับมังกรฆ่า'],
    sources: [
      {
        title: 'I married the dragon I killed - ข้าแต่งงานกับมังกรที่ข้าฆ่า',
        mangaUrl: 'https://whytoon.com/content/i-married-the-dragon-i-killed',
        sourceId: 'whytoon',
        sourceName: 'WhyToon',
        sourceUrl: 'https://whytoon.com',
        sourceType: 'whytoon',
        readable: true,
        isCoin: false,
        icon: '📱'
      },
      {
        title: 'ผมแต่งงานกับมังกรที่ผมเคยฆ่า',
        mangaUrl: 'https://ntrnaja.com/manga/m-hhgkmar0/',
        sourceId: 'ntrnaja',
        sourceName: 'NTRnaja (ติดเหรียญ)',
        sourceUrl: 'https://ntrnaja.com',
        sourceType: 'ntrnaja',
        readable: false,
        isCoin: true,
        icon: '🔒'
      }
    ]
  }
];

// ==========================================================
// ระบบเชื่อมต่อ MangaDex API (การ์ตูนภาษาอังกฤษระดับโลก)
// รองรับการดึงรายการมังงะ, รายชื่อตอน, รูปภาพตอนอ่าน และการค้นหา
// ==========================================================
// การตั้งค่าและจัดการข้อมูลจาก MangaDex (ภาษาอังกฤษ, ญี่ปุ่น, เกาหลี)
// ==========================================================
let mangadexLoading = false;
const mangadexLoadedLangs = new Set();

// 1. ดึงรายการมังงะยอดนิยม/อัปเดตล่าสุดจาก MangaDex (รองรับ en, ja, ko)
async function fetchMangaDexBatch(limit = 40, page = 1, lang = 'en') {
  try {
    const offset = (page - 1) * limit;
    let url = '';
    if (lang === 'ja') {
      url = `https://api.mangadex.org/manga?limit=${limit}&offset=${offset}&availableTranslatedLanguage[]=ja&order[latestUploadedChapter]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    } else if (lang === 'ko') {
      url = `https://api.mangadex.org/manga?limit=${limit}&offset=${offset}&availableTranslatedLanguage[]=ko&order[latestUploadedChapter]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    } else {
      url = `https://api.mangadex.org/manga?limit=${limit}&offset=${offset}&availableTranslatedLanguage[]=en&order[latestUploadedChapter]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    }
    
    let json = null;
    try {
      const res = await fetch(url);
      if (res.ok) json = await res.json();
    } catch (e) {}

    if (!json) {
      try {
        const proxyRes = await fetchViaProxy(url, {}, 8000);
        json = JSON.parse(proxyRes);
      } catch (e) {}
    }

    if (!json || !Array.isArray(json.data)) return [];

    const items = json.data.map(item => {
      const coverRel = (item.relationships || []).find(r => r.type === 'cover_art');
      const coverFile = coverRel?.attributes?.fileName;
      const coverUrl = coverFile 
        ? `https://uploads.mangadex.org/covers/${item.id}/${coverFile}.256.jpg`
        : '';
      
      let title = '';
      if (lang === 'ja') {
        title = item.attributes?.title?.ja || item.attributes?.title?.['ja-ro'] || item.attributes?.title?.en || (item.attributes?.title ? Object.values(item.attributes.title)[0] : '') || 'Untitled Manga';
      } else if (lang === 'ko') {
        title = item.attributes?.title?.ko || item.attributes?.title?.['ko-ro'] || item.attributes?.title?.en || (item.attributes?.title ? Object.values(item.attributes.title)[0] : '') || 'Untitled Manga';
      } else {
        title = item.attributes?.title?.en || 
                (item.attributes?.title ? Object.values(item.attributes.title)[0] : '') || 
                (item.attributes?.altTitles && item.attributes.altTitles.find(t => t.en)?.en) || 
                'Untitled Manga';
      }
      
      const tags = (item.attributes?.tags || []).map(t => t.attributes?.name?.en || '').filter(Boolean);
      let type = 'Manga';
      if (item.attributes?.originalLanguage === 'ko' || tags.some(t => t.toLowerCase().includes('manhwa'))) {
        type = 'Manhwa';
      } else if (item.attributes?.originalLanguage === 'zh' || tags.some(t => t.toLowerCase().includes('manhua'))) {
        type = 'Manhua';
      }

      let epLabel = `ตอนล่าสุด (${lang.toUpperCase()})`;
      if (item.attributes?.lastChapter) {
        epLabel = `ตอนที่ ${item.attributes.lastChapter}`;
      }

      return {
        title,
        mangaUrl: `https://mangadex.org/title/${item.id}`,
        mangaId: item.id,
        cover: coverUrl,
        latestEp: epLabel,
        type,
        tags,
        sourceId: 'mangadex',
        sourceName: 'MangaDex',
        sourceUrl: 'https://mangadex.org',
        sourceType: 'mangadex',
        readable: true,
        isCoin: false,
        icon: '🌐',
        lang: lang
      };
    });

    return items;
  } catch (err) {
    console.warn("MangaDex fetch error:", err);
    return [];
  }
}

// 2. ดึงรายชื่อตอนของเรื่องจาก MangaDex
async function fetchMangaDexChapters(mangaId, targetLang = '') {
  try {
    let langFilter = targetLang;
    if (!langFilter) {
      if (selectedLanguages.has('en')) langFilter = 'en';
      else if (selectedLanguages.has('ja')) langFilter = 'ja';
      else if (selectedLanguages.has('ko')) langFilter = 'ko';
    }

    let url = `https://api.mangadex.org/manga/${mangaId}/feed?order[chapter]=desc&limit=300&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    if (langFilter && langFilter !== 'th') {
      url += `&translatedLanguage[]=${langFilter}`;
    }

    let json = null;
    try {
      const res = await fetch(url);
      if (res.ok) json = await res.json();
    } catch (e) {}

    if (!json) {
      try {
        const proxyRes = await fetchViaProxy(url, {}, 8000);
        json = JSON.parse(proxyRes);
      } catch (e) {}
    }

    // หากไม่พบตอนในภาษานั้น ให้ลองดึงเฉพาะภาษาอังกฤษ (en) เป็น Fallback ถ้ามี (ไม่ดึงภาษาอื่นที่ไม่เกี่ยวข้อง เช่น เวียดนาม vi หรือ รัสเซีย ru)
    if (!json || !Array.isArray(json.data) || json.data.length === 0) {
      if (langFilter && langFilter !== 'en') {
        try {
          const enFallbackUrl = `https://api.mangadex.org/manga/${mangaId}/feed?order[chapter]=desc&limit=300&translatedLanguage[]=en&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
          const res2 = await fetch(enFallbackUrl);
          if (res2.ok) json = await res2.json();
          if (!json) {
            const proxyRes2 = await fetchViaProxy(enFallbackUrl, {}, 8000);
            json = JSON.parse(proxyRes2);
          }
        } catch (e) {}
      }
    }

    if (!json || !Array.isArray(json.data)) return [];

    const rawChapters = json.data.map(ch => {
      const chNum = ch.attributes?.chapter || '';
      const chTitle = ch.attributes?.title ? ` - ${ch.attributes.title}` : '';
      const displayTitle = chNum ? `ตอนที่ ${chNum}${chTitle}` : (ch.attributes?.title || 'ตอนพิเศษ');
      const isExternal = !!ch.attributes?.externalUrl;
      const chapterUrl = isExternal ? ch.attributes.externalUrl : `mangadex://${ch.id}`;
      const chLang = (ch.attributes?.translatedLanguage || 'en').toUpperCase();
      return {
        title: displayTitle,
        url: chapterUrl,
        badge: isExternal ? '↗ เว็บนอก' : `✨ ฟรี (${chLang})`,
        isExternal: isExternal,
        externalUrl: ch.attributes?.externalUrl,
        chapterNum: chNum || '0',
        lang: ch.attributes?.translatedLanguage || 'en'
      };
    });

    // กรองตอนซ้ำจากกลุ่มแปลซ้ำซ้อน
    const seen = new Set();
    const cleanChapters = [];
    rawChapters.forEach(c => {
      const key = (c.chapterNum && c.chapterNum !== '0') ? `${c.chapterNum}_${c.lang}` : c.url;
      if (!seen.has(key)) {
        seen.add(key);
        cleanChapters.push(c);
      }
    });

    return cleanChapters;
  } catch (err) {
    console.warn("fetchMangaDexChapters error:", err);
    return [];
  }
}

// 3. ดึงรูปภาพสำหรับ Vertical Reader จาก MangaDex@Home
async function fetchMangaDexReaderImages(chapterId) {
  try {
    const url = `https://api.mangadex.org/at-home/server/${chapterId}`;
    let json = null;
    try {
      const res = await fetch(url);
      if (res.ok) json = await res.json();
    } catch (e) {}

    if (!json) {
      try {
        const proxyRes = await fetchViaProxy(url, {}, 8000);
        json = JSON.parse(proxyRes);
      } catch (e) {}
    }

    if (json && json.result === 'ok') {
      const baseUrl = json.baseUrl;
      const hash = json.chapter.hash;
      const fileNames = (json.chapter.data && json.chapter.data.length > 0) ? json.chapter.data : (json.chapter.dataSaver || []);
      const images = fileNames.map(fn => `${baseUrl}/data/${hash}/${fn}`);
      return {
        prevUrl: '',
        nextUrl: '',
        images
      };
    }
  } catch (err) {
    console.warn("fetchMangaDexReaderImages error:", err);
  }
  return { prevUrl: '', nextUrl: '', images: [] };
}

// 4. ค้นหามังงะจาก MangaDex API (รองรับทั้งชื่อเรื่อง, ลิงก์เต็ม และรหัส UUID เช่น Gundam Hathaway)
async function searchMangaDex(query, limit = 25) {
  if (!query || !query.trim()) return [];
  const rawQ = query.trim();

  // 1. ตรวจสอบว่าเป็นการวาง UUID หรือ URL เต็มของ MangaDex หรือไม่
  const uuidMatch = rawQ.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (uuidMatch) {
    const uuid = uuidMatch[1];
    try {
      const directUrl = `https://api.mangadex.org/manga/${uuid}?includes[]=cover_art`;
      let json = null;
      try {
        const res = await fetch(directUrl);
        if (res.ok) json = await res.json();
      } catch (e) {}
      if (!json) {
        try {
          const proxyRes = await fetchViaProxy(directUrl, {}, 8000);
          json = JSON.parse(proxyRes);
        } catch (e) {}
      }

      if (json && json.data) {
        const item = json.data;
        const coverRel = (item.relationships || []).find(r => r.type === 'cover_art');
        const coverFile = coverRel?.attributes?.fileName;
        const coverUrl = coverFile 
          ? `https://uploads.mangadex.org/covers/${item.id}/${coverFile}.256.jpg`
          : '';
        
        const title = item.attributes?.title?.en || 
                      item.attributes?.title?.ja || 
                      item.attributes?.title?.['ja-ro'] || 
                      (item.attributes?.title ? Object.values(item.attributes.title)[0] : '') || 
                      (item.attributes?.altTitles && item.attributes.altTitles.find(t => t.en)?.en) || 
                      'Untitled Manga';
        
        const tags = (item.attributes?.tags || []).map(t => t.attributes?.name?.en || '').filter(Boolean);
        let type = 'Manga';
        if (item.attributes?.originalLanguage === 'ko' || tags.some(t => t.toLowerCase().includes('manhwa'))) {
          type = 'Manhwa';
        } else if (item.attributes?.originalLanguage === 'zh' || tags.some(t => t.toLowerCase().includes('manhua'))) {
          type = 'Manhua';
        }

        let detectedLang = 'en';
        if (item.attributes?.originalLanguage === 'ja' && !item.attributes?.title?.en) detectedLang = 'ja';
        if (item.attributes?.originalLanguage === 'ko' && !item.attributes?.title?.en) detectedLang = 'ko';

        return [{
          title,
          mangaUrl: `https://mangadex.org/title/${item.id}`,
          mangaId: item.id,
          cover: coverUrl,
          latestEp: item.attributes?.lastChapter ? `ตอนที่ ${item.attributes.lastChapter}` : 'ตอนล่าสุด',
          type,
          tags,
          sourceId: 'mangadex',
          sourceName: 'MangaDex',
          sourceUrl: 'https://mangadex.org',
          sourceType: 'mangadex',
          readable: true,
          isCoin: false,
          icon: '🌐',
          lang: detectedLang,
          _searchQuery: rawQ.toLowerCase()
        }];
      }
    } catch (e) {
      console.warn("searchMangaDex UUID fetch error:", e);
    }
  }

  // 2. ถ้าเป็นข้อความค้นหาทั่วไป (ทำความสะอาด slug ที่มีเครื่องหมาย - หรือ URL)
  let cleanQ = rawQ;
  if (cleanQ.includes('mangadex.org/title/')) {
    const slugPart = cleanQ.split('mangadex.org/title/')[1] || '';
    cleanQ = slugPart.replace(/^[a-f0-9-]+\/?/, '').replace(/[-_]/g, ' ').trim();
  } else if (cleanQ.includes('-') && !cleanQ.includes(' ')) {
    cleanQ = cleanQ.replace(/[-_]/g, ' ').trim();
  }

  try {
    const fetchSearch = async (searchTerm) => {
      const url = `https://api.mangadex.org/manga?title=${encodeURIComponent(searchTerm)}&limit=${limit}&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
      let json = null;
      try {
        const res = await fetch(url);
        if (res.ok) json = await res.json();
      } catch (e) {}

      if (!json) {
        try {
          const proxyRes = await fetchViaProxy(url, {}, 8000);
          json = JSON.parse(proxyRes);
        } catch (e) {}
      }
      return json;
    };

    let json = await fetchSearch(cleanQ);

    // ถ้าไม่พบผลลัพธ์ และข้อความค้นหามีหลายคำ ลองตัดคำสร้อยหรือค้นหาคำหลัก
    if ((!json || !Array.isArray(json.data) || json.data.length === 0) && cleanQ.includes(' ')) {
      const words = cleanQ.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 1) {
        // เช่น "mobile suit gundam hathaway" -> ลองค้น "hathaway" หรือคำท้ายสุดที่เป็นเอกลักษณ์
        const keyword = words[words.length - 1];
        if (keyword && keyword.length > 3) {
          const fallbackJson = await fetchSearch(keyword);
          if (fallbackJson && Array.isArray(fallbackJson.data) && fallbackJson.data.length > 0) {
            json = fallbackJson;
          }
        }
      }
    }

    if (!json || !Array.isArray(json.data)) return [];

    return json.data.map(item => {
      const coverRel = (item.relationships || []).find(r => r.type === 'cover_art');
      const coverFile = coverRel?.attributes?.fileName;
      const coverUrl = coverFile 
        ? `https://uploads.mangadex.org/covers/${item.id}/${coverFile}.256.jpg`
        : '';
      
      const title = item.attributes?.title?.en || 
                    item.attributes?.title?.ja || 
                    item.attributes?.title?.['ja-ro'] || 
                    (item.attributes?.title ? Object.values(item.attributes.title)[0] : '') || 
                    (item.attributes?.altTitles && item.attributes.altTitles.find(t => t.en)?.en) || 
                    'Untitled Manga';
      
      const tags = (item.attributes?.tags || []).map(t => t.attributes?.name?.en || '').filter(Boolean);
      let type = 'Manga';
      if (item.attributes?.originalLanguage === 'ko' || tags.some(t => t.toLowerCase().includes('manhwa'))) {
        type = 'Manhwa';
      } else if (item.attributes?.originalLanguage === 'zh' || tags.some(t => t.toLowerCase().includes('manhua'))) {
        type = 'Manhua';
      }

      let detectedLang = 'en';
      if (item.attributes?.originalLanguage === 'ja' && !item.attributes?.title?.en) detectedLang = 'ja';
      if (item.attributes?.originalLanguage === 'ko' && !item.attributes?.title?.en) detectedLang = 'ko';

      return {
        title,
        mangaUrl: `https://mangadex.org/title/${item.id}`,
        mangaId: item.id,
        cover: coverUrl,
        latestEp: item.attributes?.lastChapter ? `ตอนที่ ${item.attributes.lastChapter}` : 'ตอนล่าสุด',
        type,
        tags,
        sourceId: 'mangadex',
        sourceName: 'MangaDex',
        sourceUrl: 'https://mangadex.org',
        sourceType: 'mangadex',
        readable: true,
        isCoin: false,
        icon: '🌐',
        lang: detectedLang,
        _searchQuery: rawQ.toLowerCase()
      };
    });
  } catch (e) {
    console.warn("searchMangaDex error:", e);
    return [];
  }
}

// ดึงคีย์สำหรับจับคู่มังงะเรื่องเดียวกันข้ามเว็บไซต์ (รองรับชื่อไทยต่างสำนวน, ชื่ออังกฤษ + ชื่อไทย, คำสรรพนาม ฯลฯ)
function getMangaTitleKeys(title) {
  if (!title) return [];
  const keys = new Set();

  const thaiStopwords = /ผม|ฉัน|ข้า|กู|เรา|นาย|เธอ|เขา|พวกเรา|ตัวผม|ตัวข้า|เคย|ได้|แล้ว|อัน|เหล่า|แห่ง|คือ|เรื่อง|การ|ความ|ที่|จะ|ก็/g;
  const cleanStr = (s) => (s || '').toLowerCase()
    .replace(/แปลไทย|manga|manhwa|ตอนที่|ch\.|season|[^\u0E00-\u0E7Fa-zA-Z0-9]/g, '')
    .trim();

  // 1. คีย์เต็มแบบคลีน
  const fullClean = cleanStr(title);
  if (fullClean) keys.add(fullClean);

  // 2. คีย์เต็มตัดคำสรรพนามและคำสร้อยไทย
  const fullNoStop = fullClean.replace(thaiStopwords, '').trim();
  if (fullNoStop && fullNoStop.length >= 3) keys.add(fullNoStop);

  // 3. แยกส่วนชื่อกรณีมีเครื่องหมายคั่น (เช่น "A - B")
  const parts = title.split(/[-–—/|:()[\]~]+/).map(p => p.trim()).filter(Boolean);
  parts.forEach(part => {
    const partClean = cleanStr(part);
    if (partClean && partClean.length >= 2) {
      keys.add(partClean);
    }
    const partNoStop = partClean.replace(thaiStopwords, '').trim();
    if (partNoStop && partNoStop.length >= 3) {
      keys.add(partNoStop);
    }
  });

  // 4. ตรวจจับและแยกบล็อกภาษาอังกฤษและภาษาไทยที่อยู่ด้วยกัน (เช่น "Reincarnator's Stream การไลฟ์สดของผู้หวนคืน")
  const enBlocks = title.match(/[a-zA-Z0-9'’]+(?:\s+[a-zA-Z0-9'’]+)*/g);
  if (enBlocks) {
    enBlocks.forEach(b => {
      const bClean = cleanStr(b);
      if (bClean && bClean.length >= 3) keys.add(bClean);
    });
  }

  const thBlocks = title.match(/[\u0E00-\u0E7F]+(?:\s+[\u0E00-\u0E7F]+)*/g);
  if (thBlocks) {
    thBlocks.forEach(b => {
      const bClean = cleanStr(b);
      if (bClean && bClean.length >= 3) {
        keys.add(bClean);
        const bNoStop = bClean.replace(thaiStopwords, '').trim();
        if (bNoStop && bNoStop.length >= 3) keys.add(bNoStop);
      }
    });
  }

  return Array.from(keys);
}

// ฟังก์ชันทำความสะอาดชื่อตอนให้อ่านง่าย กระชับ ตัดวันที่และตัดชื่อเรื่องซ้ำซ้อนออก 100%
function cleanMangaChapterTitle(chapterTitle, mangaTitle, chapterUrl) {
  let s = (chapterTitle || '').trim();

  // 1. ตัดชื่อเรื่องออกถ้าปนมาในชื่อตอน
  if (mangaTitle) {
    s = s.split(mangaTitle).join('').trim();
  }

  // 2. ตัดวันที่ภาษาไทยและสากลทุกรูปแบบ (เช่น กันยายน 7, 2026 หรือ 7 กันยายน 2026 หรือ 2026-09-07)
  const thaiMonths = 'มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|ม\\.ค\\.|ก\\.พ\\.|มี\\.ค\\.|เม\\.ย\\.|พ\\.ค\\.|มิ\\.ย\\.|ก\\.ค\\.|ส\\.ค\\.|ก\\.ย\\.|ต\\.ค\\.|พ\\.ย\\.|ธ\\.ค\\.';
  const engMonths = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  s = s.replace(new RegExp(`\\b\\d{1,2}\\s+(?:${thaiMonths}|${engMonths})\\s*,?\\s*\\d{2,4}\\b`, 'gi'), '');
  s = s.replace(new RegExp(`(?:${thaiMonths}|${engMonths})\\s+\\d{1,2},?\\s*\\d{2,4}\\b`, 'gi'), '');
  s = s.replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '');
  s = s.replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, '');
  s = s.replace(/\b202\d\b/g, '');
  s = s.replace(/^[- :|]+|[- :|]+$/g, '').trim();

  // 3. ตรวจสอบว่ามีเลขตอนระบุชัดเจนหรือไม่
  const numMatch = s.match(/(?:ตอนที่|ตอน|ch(?:apter)?\.?|ep(?:isode)?\.?)\s*(\d+(?:\.\d+)?)/i) ||
                   s.match(/\b(\d+(?:\.\d+)?)\b/);
  if (numMatch) {
    return `ตอนที่ ${numMatch[1]}`;
  }

  // 4. ถ้าไม่มีเลขในชื่อ หรือเหลือแต่ข้อความว่าง ให้แกะจาก URL
  if (chapterUrl) {
    const decodedUrl = decodeURIComponent(chapterUrl);
    const m = decodedUrl.match(/ตอนที่[-_ ]*(\d+(?:\.\d+)?)/i) ||
              decodedUrl.match(/ch(?:apter)?[-_ ]*(\d+(?:\.\d+)?)/i) ||
              decodedUrl.match(/\/(\d+(?:\.\d+)?)\/?$/) ||
              decodedUrl.match(/-(\d+(?:\.\d+)?)\/?$/);
    if (m) {
      return `ตอนที่ ${m[1]}`;
    }
  }

  return s || 'ตอนล่าสุด';
}

// ==========================================================
// ระบบประวัติการอ่าน (Reading History) และเรื่องโปรด (Favorites)
// รองรับ Local Storage + Cloudflare KV Multi-Device Sync
// ==========================================================
const STORAGE_HISTORY = 'clean_manga_reading_history';
const STORAGE_FAVORITES = 'clean_manga_favorites';
const STORAGE_DELETED_FAVORITES = 'clean_manga_deleted_favs';
const STORAGE_DELETED_HISTORY = 'clean_manga_deleted_hist';
const STORAGE_HISTORY_CLEARED_AT = 'clean_manga_hist_cleared_at';
const SYNC_STORAGE_KEY = 'clean_manga_sync_key';

let currentSyncKey = localStorage.getItem(SYNC_STORAGE_KEY) || '';
let syncDebounceTimer = null;

// ดึงรายการที่ถูกลบ (Tombstones) เพื่อป้องกันการฟื้นคืนชีพจากการซิงก์
function getDeletedFavorites() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_DELETED_FAVORITES) || '{}');
  } catch (e) {
    return {};
  }
}

function getDeletedHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_DELETED_HISTORY) || '{}');
  } catch (e) {
    return {};
  }
}

function getHistoryClearedAt() {
  try {
    return parseInt(localStorage.getItem(STORAGE_HISTORY_CLEARED_AT) || '0', 10);
  } catch (e) {
    return 0;
  }
}

// บันทึก Tombstone เมื่อลบเรื่องโปรด
function recordFavoriteDeletion(manga) {
  if (!manga) return;
  const title = (manga.title || '').trim();
  const url = (manga.mangaUrl || '').trim();
  const deletedFavs = getDeletedFavorites();
  const now = Date.now();
  if (title) deletedFavs[title] = now;
  if (url) deletedFavs[url] = now;

  const keys = Object.keys(deletedFavs);
  if (keys.length > 250) {
    keys.sort((a, b) => deletedFavs[a] - deletedFavs[b]);
    keys.slice(0, keys.length - 250).forEach(k => delete deletedFavs[k]);
  }
  try {
    localStorage.setItem(STORAGE_DELETED_FAVORITES, JSON.stringify(deletedFavs));
  } catch (e) {}
}

// บันทึก Tombstone เมื่อลบประวัติ
function recordHistoryDeletion(itemIdentifier) {
  if (!itemIdentifier) return;
  const deletedHist = getDeletedHistory();
  const now = Date.now();
  if (typeof itemIdentifier === 'object') {
    if (itemIdentifier.title) deletedHist[itemIdentifier.title.trim()] = now;
    if (itemIdentifier.mangaUrl) deletedHist[itemIdentifier.mangaUrl.trim()] = now;
  } else {
    deletedHist[String(itemIdentifier).trim()] = now;
  }

  const keys = Object.keys(deletedHist);
  if (keys.length > 250) {
    keys.sort((a, b) => deletedHist[a] - deletedHist[b]);
    keys.slice(0, keys.length - 250).forEach(k => delete deletedHist[k]);
  }
  try {
    localStorage.setItem(STORAGE_DELETED_HISTORY, JSON.stringify(deletedHist));
  } catch (e) {}
}

// ฟังก์ชันหา URL สำหรับเรียก Sync API ข้ามอุปกรณ์ (รองรับ GitHub Pages และ Cloudflare Worker)
function getSyncApiUrl(endpoint) {
  const base = (typeof CONFIG !== 'undefined' && CONFIG.SYNC_API_BASE)
    ? CONFIG.SYNC_API_BASE
    : 'https://clean-manga-reader.mosstep.workers.dev/api/sync';
  return `${base}${endpoint}`;
}

// ดึงรหัสซิงก์ปัจจุบัน
function getSyncKey() {
  if (!currentSyncKey) {
    currentSyncKey = localStorage.getItem(SYNC_STORAGE_KEY) || '';
  }
  return currentSyncKey;
}

// เริ่มต้นระบบซิงก์ (สุ่มรหัสให้อัตโนมัติหากยังไม่มี)
async function initSyncEngine() {
  let key = getSyncKey();
  if (!key) {
    try {
      const res = await fetch(getSyncApiUrl('/generate-key'), { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.key) {
          key = data.key.toUpperCase();
          currentSyncKey = key;
          localStorage.setItem(SYNC_STORAGE_KEY, key);
          // ส่งข้อมูลเดิมที่มีอยู่ในเครื่องขึ้นคลาวด์ก้อนแรกทันที
          pushSyncData();
        }
      }
    } catch (e) {
      console.warn("Generate sync key error:", e);
    }
  }

  // อัปเดตรหัสบน UI
  updateSyncKeyUI();

  // ดึงข้อมูลจากคลาวด์มาซิงก์กับในเครื่อง
  if (key) {
    pullAndMergeSyncData();
  }
}

// ส่งข้อมูลประวัติและเรื่องโปรดไปซิงก์บนคลาวด์ (Debounced 500ms) พร้อมส่ง Tombstones
function pushSyncData() {
  const key = getSyncKey();
  if (!key) return;

  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    try {
      const favorites = getFavorites();
      const history = getReadingHistory();
      const deletedFavorites = getDeletedFavorites();
      const deletedHistory = getDeletedHistory();
      const historyClearedAt = getHistoryClearedAt();
      const nickInput = document.getElementById('chatNicknameInput');
      const nickname = (nickInput ? nickInput.value : (localStorage.getItem(CHAT_STORAGE_NICKNAME) || '')).trim();

      const res = await fetch(getSyncApiUrl('/data'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          favorites,
          history,
          nickname,
          deletedFavorites,
          deletedHistory,
          historyClearedAt
        })
      });
      if (res.ok) {
        const result = await res.json();
        if (result.success && result.data) {
          const curDelFavs = getDeletedFavorites();
          const curDelHist = getDeletedHistory();
          const curClearedAt = getHistoryClearedAt();

          if (Array.isArray(result.data.favorites)) {
            // กรองรายการที่ถูกลบออก เพื่อไม่ให้เรื่องที่ลบไปแล้วฟื้นคืนชีพกลับมา
            const cleanFavs = result.data.favorites.filter(f => {
              if (!f || !f.title) return false;
              const delTime = Math.max(curDelFavs[f.title.trim()] || 0, curDelFavs[(f.mangaUrl || '').trim()] || 0);
              return !delTime || (f.savedAt || 0) > delTime;
            });
            localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(cleanFavs));
          }
          if (Array.isArray(result.data.history)) {
            // กรองรายการที่ถูกลบออก หรือเวลาเก่ากว่าการสั่งล้างทั้งหมด
            const cleanHist = result.data.history.filter(h => {
              if (!h || !h.title) return false;
              if (curClearedAt && (h.updatedAt || 0) <= curClearedAt) return false;
              const delTime = Math.max(curDelHist[h.title.trim()] || 0, curDelHist[(h.mangaUrl || '').trim()] || 0);
              return !delTime || (h.updatedAt || 0) > delTime;
            });
            localStorage.setItem(STORAGE_HISTORY, JSON.stringify(cleanHist));
          }
          if (result.data.deletedFavorites) {
            localStorage.setItem(STORAGE_DELETED_FAVORITES, JSON.stringify({ ...curDelFavs, ...result.data.deletedFavorites }));
          }
          if (result.data.deletedHistory) {
            localStorage.setItem(STORAGE_DELETED_HISTORY, JSON.stringify({ ...curDelHist, ...result.data.deletedHistory }));
          }
          if (result.data.historyClearedAt) {
            localStorage.setItem(STORAGE_HISTORY_CLEARED_AT, String(Math.max(curClearedAt, result.data.historyClearedAt)));
          }
          if (result.data.nickname) {
            localStorage.setItem(CHAT_STORAGE_NICKNAME, result.data.nickname);
            if (nickInput && !nickInput.value) nickInput.value = result.data.nickname;
          }
          updateHistoryAndFavCounts();
          if (currentTagFilter === 'favorites' || currentTagFilter === 'history') {
            applyFilters();
          }
        }
      }
    } catch (e) {
      console.warn("Push sync data error:", e);
    }
  }, 500);
}

// ดึงข้อมูลจากคลาวด์และรวมกับข้อมูลในเครื่องอย่างชาญฉลาด (Smart Multi-Device Merge พร้อมเคารพการลบ)
async function pullAndMergeSyncData() {
  const key = getSyncKey();
  if (!key) return;

  try {
    const res = await fetch(getSyncApiUrl(`/data?key=${encodeURIComponent(key)}`));
    if (res.ok) {
      const result = await res.json();
      if (result.success && result.data) {
        // ผสานชื่อเล่นในห้องแชท
        if (result.data.nickname) {
          const cloudNick = result.data.nickname.trim();
          if (cloudNick) {
            localStorage.setItem(CHAT_STORAGE_NICKNAME, cloudNick);
            const nickInput = document.getElementById('chatNicknameInput');
            if (nickInput) nickInput.value = cloudNick;
          }
        }

        // ผสาน Tombstones
        if (result.data.deletedFavorites) {
          const curDelFavs = getDeletedFavorites();
          localStorage.setItem(STORAGE_DELETED_FAVORITES, JSON.stringify({ ...curDelFavs, ...result.data.deletedFavorites }));
        }
        if (result.data.deletedHistory) {
          const curDelHist = getDeletedHistory();
          localStorage.setItem(STORAGE_DELETED_HISTORY, JSON.stringify({ ...curDelHist, ...result.data.deletedHistory }));
        }
        if (result.data.historyClearedAt) {
          const curCleared = getHistoryClearedAt();
          localStorage.setItem(STORAGE_HISTORY_CLEARED_AT, String(Math.max(curCleared, result.data.historyClearedAt)));
        }

        const delFavs = getDeletedFavorites();
        const delHist = getDeletedHistory();
        const histClearedAt = getHistoryClearedAt();

        // 1. รวมเรื่องโปรด: กรองรายการที่ถูกลบออก
        const cloudFavs = (result.data.favorites || []).filter(cf => {
          const delTime = Math.max(delFavs[cf.title] || 0, delFavs[cf.mangaUrl] || 0);
          return !delTime || (cf.savedAt || 0) > delTime;
        });
        const localFavs = getFavorites().filter(lf => {
          const delTime = Math.max(delFavs[lf.title] || 0, delFavs[lf.mangaUrl] || 0);
          return !delTime || (lf.savedAt || 0) > delTime;
        });

        const mergedFavs = [...localFavs];
        cloudFavs.forEach(cf => {
          const cfKeys = getMangaTitleKeys(cf.title);
          const isDup = mergedFavs.some(lf => {
            if (lf.title === cf.title || (lf.mangaUrl && cf.mangaUrl && lf.mangaUrl === cf.mangaUrl)) return true;
            const lfKeys = getMangaTitleKeys(lf.title);
            return cfKeys.some(k => lfKeys.includes(k));
          });
          if (!isDup) {
            mergedFavs.push(cf);
          }
        });
        localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(mergedFavs));

        // 2. รวมประวัติการอ่าน: กรองรายการที่ถูกลบออก หรือเวลาเก่ากว่าคำสั่งล้างทั้งหมด
        const cloudHist = (result.data.history || []).filter(ch => {
          if (histClearedAt && (ch.updatedAt || 0) <= histClearedAt) return false;
          const delTime = Math.max(delHist[ch.title] || 0, delHist[ch.mangaUrl] || 0);
          return !delTime || (ch.updatedAt || 0) > delTime;
        });
        const localHist = getReadingHistory().filter(lh => {
          if (histClearedAt && (lh.updatedAt || 0) <= histClearedAt) return false;
          const delTime = Math.max(delHist[lh.title] || 0, delHist[lh.mangaUrl] || 0);
          return !delTime || (lh.updatedAt || 0) > delTime;
        });

        const mergedHist = [...localHist];
        cloudHist.forEach(ch => {
          const chKeys = getMangaTitleKeys(ch.title);
          const existIdx = mergedHist.findIndex(lh => {
            if (lh.title === ch.title || (lh.mangaUrl && ch.mangaUrl && lh.mangaUrl === ch.mangaUrl)) return true;
            const lhKeys = getMangaTitleKeys(lh.title);
            return chKeys.some(k => lhKeys.includes(k));
          });
          if (existIdx >= 0) {
            const exist = mergedHist[existIdx];
            const readChapters = Array.from(new Set([
              ...(Array.isArray(exist.readChapters) ? exist.readChapters : []),
              ...(Array.isArray(ch.readChapters) ? ch.readChapters : [])
            ]));
            const newer = (ch.updatedAt || 0) >= (exist.updatedAt || 0) ? ch : exist;
            mergedHist[existIdx] = {
              ...newer,
              readChapters,
              updatedAt: Math.max(exist.updatedAt || 0, ch.updatedAt || 0)
            };
          } else {
            mergedHist.push(ch);
          }
        });

        // จำกัด 500 เรื่อง เรียงตามเวลาอ่านล่าสุด
        mergedHist.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        localStorage.setItem(STORAGE_HISTORY, JSON.stringify(mergedHist.slice(0, 500)));

        updateHistoryAndFavCounts();
        pushSyncData(); // อัปโหลดข้อมูลล่าสุดกลับไปยืนยันบน KV

        if (currentTagFilter === 'favorites' || currentTagFilter === 'history') {
          applyFilters();
        }
      }
    }
  } catch (e) {
    console.warn("Pull sync data error:", e);
  }
}

// สลับไปใช้รหัสเดิมจากเครื่องอื่น (เชื่อมต่อข้ามอุปกรณ์)
async function switchSyncKey(newKey) {
  const cleanKey = (newKey || '').trim().toUpperCase();
  if (!cleanKey || cleanKey.length < 3) {
    alert('กรุณาใส่รหัสซิงก์ที่ถูกต้อง');
    return;
  }

  const oldKey = getSyncKey();
  const statusMsg = document.getElementById('syncStatusMsg');
  if (statusMsg) statusMsg.textContent = '⏳ กำลังเชื่อมต่อ...';

  try {
    // ถ้ามีรหัสเก่าชั่วคราวและยังไม่มีข้อมูล ให้คืนคีย์เก่าเพื่อไม่ให้เปลืองโควตา
    if (oldKey && oldKey !== cleanKey) {
      try {
        await fetch(getSyncApiUrl('/release-key'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: oldKey })
        });
      } catch (e) {}
    }

    // บันทึกรหัสใหม่ลงเครื่องนี้ถาวร
    currentSyncKey = cleanKey;
    localStorage.setItem(SYNC_STORAGE_KEY, cleanKey);
    updateSyncKeyUI();

    // ดึงข้อมูลจากรหัสใหม่มาซิงก์ทันที
    await pullAndMergeSyncData();
    // ส่งข้อมูลรวมกลับขึ้นคลาวด์
    pushSyncData();

    if (statusMsg) {
      statusMsg.textContent = '✓ เชื่อมต่อสำเร็จ!';
      setTimeout(() => { statusMsg.textContent = ''; }, 3000);
    }
  } catch (err) {
    if (statusMsg) statusMsg.textContent = 'เชื่อมต่อไม่สำเร็จ';
  }
}

// อัปเดต UI ของแถบซิงก์
function updateSyncKeyUI() {
  const badge = document.getElementById('syncCodeBadge');
  const copyBtn = document.getElementById('btnCopySyncKey');
  const applyBtn = document.getElementById('btnApplySyncKey');
  const keyInput = document.getElementById('syncKeyInput');
  const key = getSyncKey();

  if (badge) {
    badge.textContent = key || 'กำลังสุ่ม...';
    badge.onclick = () => copySyncKey();
  }

  if (copyBtn && !copyBtn.dataset.bound) {
    copyBtn.dataset.bound = "1";
    copyBtn.onclick = () => copySyncKey();
  }

  if (applyBtn && !applyBtn.dataset.bound) {
    applyBtn.dataset.bound = "1";
    applyBtn.onclick = () => {
      if (keyInput) switchSyncKey(keyInput.value);
    };
  }

  if (keyInput && !keyInput.dataset.bound) {
    keyInput.dataset.bound = "1";
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        switchSyncKey(keyInput.value);
      }
    });
  }
}

// คัดลอกรหัสซิงก์
function copySyncKey() {
  const key = getSyncKey();
  if (!key) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(key).then(() => {
      const statusMsg = document.getElementById('syncStatusMsg');
      if (statusMsg) {
        statusMsg.textContent = `✓ คัดลอก ${key} แล้ว`;
        setTimeout(() => { statusMsg.textContent = ''; }, 2500);
      }
    });
  } else {
    prompt('คัดลอกรหัสของคุณ:', key);
  }
}

// ดึงประวัติการอ่าน พร้อมระบบตัดและรวมเรื่องซ้ำอัตโนมัติ (Smart Deduplication ข้ามเว็บต้นทาง)
function getReadingHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]');
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const map = new Map();
    const result = [];
    let hasMerged = false;

    raw.forEach(item => {
      if (!item || !item.title) return;
      const keys = getMangaTitleKeys(item.title);
      let foundKey = null;
      for (const k of keys) {
        if (map.has(k)) {
          foundKey = k;
          break;
        }
      }

      if (foundKey) {
        hasMerged = true;
        const existing = map.get(foundKey);
        const existingRead = Array.isArray(existing.readChapters) ? existing.readChapters : [];
        const itemRead = Array.isArray(item.readChapters) ? item.readChapters : [];
        const mergedRead = Array.from(new Set([...existingRead, ...itemRead]));

        // เลือกรายการที่อ่านล่าสุดกว่า
        const newer = (item.updatedAt || 0) >= (existing.updatedAt || 0) ? item : existing;
        const older = newer === item ? existing : item;

        // รวมรายการเว็บสำรอง (altSources)
        const combinedAlt = [
          ...(newer.altSources || []),
          ...(older.altSources || []),
          ...(older.mangaUrl && older.mangaUrl !== newer.mangaUrl ? [older] : [])
        ];

        const merged = {
          ...newer,
          readChapters: mergedRead,
          altSources: combinedAlt,
          updatedAt: Math.max(existing.updatedAt || 0, item.updatedAt || 0)
        };

        const idx = result.indexOf(existing);
        if (idx !== -1) result[idx] = merged;
        keys.forEach(k => map.set(k, merged));
      } else {
        keys.forEach(k => map.set(k, item));
        result.push(item);
      }
    });

    if (hasMerged) {
      try {
        localStorage.setItem(STORAGE_HISTORY, JSON.stringify(result.slice(0, 500)));
      } catch (e) {}
    }
    result.forEach(item => {
      if (!item.lang) {
        if (item.sourceId === 'mangadex' || (item.mangaUrl && item.mangaUrl.includes('mangadex.org')) || (item.lastChapterUrl && item.lastChapterUrl.includes('mangadex'))) {
          item.lang = 'en';
        } else {
          item.lang = 'th';
        }
      }
    });
    return result;
  } catch (e) {
    return [];
  }
}

// ดึงรายการโปรด
function getFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_FAVORITES) || '[]');
    if (!Array.isArray(list)) return [];
    return list.map(item => {
      if (!item.lang) {
        if (item.sourceId === 'mangadex' || (item.mangaUrl && item.mangaUrl.includes('mangadex.org'))) {
          item.lang = 'en';
        } else {
          item.lang = 'th';
        }
      }
      return item;
    });
  } catch (e) {
    return [];
  }
}

// ตรวจสอบว่าเป็นเรื่องโปรดหรือไม่
function isFavorite(mangaTitle) {
  if (!mangaTitle) return false;
  const favs = getFavorites();
  const keys = getMangaTitleKeys(mangaTitle);
  return favs.some(f => {
    if (f.title === mangaTitle) return true;
    const fKeys = getMangaTitleKeys(f.title);
    return keys.some(k => fKeys.includes(k));
  });
}

// สลับสถานะเรื่องโปรด (Toggle Favorite)
function toggleFavorite(manga) {
  if (!manga || !manga.title) return false;
  let favs = getFavorites();
  const keys = getMangaTitleKeys(manga.title);
  const existingIdx = favs.findIndex(f => {
    if (f.title === manga.title || (manga.mangaUrl && f.mangaUrl === manga.mangaUrl)) return true;
    const fKeys = getMangaTitleKeys(f.title);
    return keys.some(k => fKeys.includes(k));
  });

  let nowFav = false;
  if (existingIdx >= 0) {
    // ลบออกจากเรื่องโปรด: บันทึก Tombstone ป้องกันการดึงกลับมาซิงก์
    recordFavoriteDeletion(manga);
    favs.splice(existingIdx, 1);
    nowFav = false;
  } else {
    // เพิ่มเข้าเรื่องโปรด: ยกเลิก Tombstone (ถ้ามี)
    const delFavs = getDeletedFavorites();
    delete delFavs[manga.title.trim()];
    if (manga.mangaUrl) delete delFavs[manga.mangaUrl.trim()];
    try {
      localStorage.setItem(STORAGE_DELETED_FAVORITES, JSON.stringify(delFavs));
    } catch (e) {}

    const mangaLang = manga.lang || (manga.sourceId === 'mangadex' ? 'en' : 'th');
    favs.unshift({
      title: manga.title,
      cover: manga.cover || '',
      type: manga.type || 'Manga',
      latestEp: manga.latestEp || 'ตอนล่าสุด',
      mangaUrl: manga.mangaUrl || '',
      sourceId: manga.sourceId || '',
      sourceName: manga.sourceName || 'Online',
      sourceUrl: manga.sourceUrl || '',
      sourceType: manga.sourceType || 'mangareader',
      readable: manga.readable !== false,
      lang: mangaLang,
      savedAt: Date.now()
    });
    nowFav = true;
  }

  try {
    localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(favs));
  } catch (e) {}

  updateHistoryAndFavCounts();
  pushSyncData(); // ซิงก์ขึ้น Cloudflare KV

  // อัปเดตปุ่มดาวบนการ์ดทุกใบ
  document.querySelectorAll('.btn-card-fav').forEach(btn => {
    const title = decodeURIComponent(btn.getAttribute('data-title') || '');
    if (title === manga.title) {
      if (nowFav) {
        btn.classList.add('active');
        btn.textContent = '★';
        btn.title = 'นำออกจากเรื่องโปรด';
      } else {
        btn.classList.remove('active');
        btn.textContent = '⭐';
        btn.title = 'บันทึกเป็นเรื่องโปรด';
      }
    }
  });

  // อัปเดตปุ่มดาวใน Modal ถ้าเปิดอยู่
  updateModalFavButton(manga);

  // ถ้ารับชมอยู่ในแท็บ favorites ให้รีเฟรชรายการ
  if (currentTagFilter === 'favorites') {
    applyFilters();
  }

  return nowFav;
}

// ลบเรื่องโปรดโดยตรง (เช่น กดปุ่มกากบาทสีแดงบนการ์ดเรื่องโปรด)
function deleteFavoriteItem(manga) {
  if (!manga || !manga.title) return;
  recordFavoriteDeletion(manga);
  let favs = getFavorites();
  const keys = getMangaTitleKeys(manga.title);
  favs = favs.filter(f => {
    if (f.title === manga.title || (manga.mangaUrl && f.mangaUrl === manga.mangaUrl)) return false;
    const fKeys = getMangaTitleKeys(f.title);
    return !keys.some(k => fKeys.includes(k));
  });

  try {
    localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(favs));
  } catch (e) {}

  updateHistoryAndFavCounts();
  pushSyncData();

  document.querySelectorAll('.btn-card-fav').forEach(btn => {
    const title = decodeURIComponent(btn.getAttribute('data-title') || '');
    if (title === manga.title) {
      btn.classList.remove('active');
      btn.textContent = '⭐';
      btn.title = 'บันทึกเป็นเรื่องโปรด';
    }
  });

  updateModalFavButton(manga);

  if (currentTagFilter === 'favorites') {
    applyFilters();
  }
}

// ล้างเรื่องโปรดทั้งหมด
function clearAllFavorites() {
  const favs = getFavorites();
  if (favs.length === 0) return;
  if (confirm('คุณต้องการล้างรายการเรื่องโปรดทั้งหมดใช่หรือไม่?')) {
    favs.forEach(f => recordFavoriteDeletion(f));
    try {
      localStorage.removeItem(STORAGE_FAVORITES);
    } catch (e) {}
    updateHistoryAndFavCounts();
    pushSyncData();
    if (currentTagFilter === 'favorites') {
      applyFilters();
    }
  }
}

// บันทึกประวัติการอ่านอัตโนมัติ (เรียกใช้อัตโนมัติเมื่อกดอ่านตอน)
function recordReadingHistory(manga, chapterTitle, chapterUrl) {
  if (!manga || !manga.title || !chapterUrl) return;
  try {
    let history = getReadingHistory();
    const keys = getMangaTitleKeys(manga.title);

    // ถ้านำเรื่องนี้กลับมาอ่านใหม่ ให้ยกเลิก Tombstone การลบ
    const delHist = getDeletedHistory();
    delete delHist[manga.title.trim()];
    if (manga.mangaUrl) delete delHist[manga.mangaUrl.trim()];
    try {
      localStorage.setItem(STORAGE_DELETED_HISTORY, JSON.stringify(delHist));
    } catch (e) {}
    
    // หาเรื่องเดิมถ้าเคยอ่าน
    let existing = history.find(h => {
      if (h.title === manga.title || h.mangaUrl === manga.mangaUrl) return true;
      const hKeys = getMangaTitleKeys(h.title);
      return keys.some(k => hKeys.includes(k));
    });

    const readChapters = existing && Array.isArray(existing.readChapters) ? [...existing.readChapters] : [];
    if (!readChapters.includes(chapterUrl)) {
      readChapters.push(chapterUrl);
    }

    // ทำความสะอาดชื่อตอนให้อ่านง่าย ชัดเจน ไม่ซ้ำกับชื่อเรื่อง ตัดวันที่ทิ้ง 100%
    const cleanChapterTitle = cleanMangaChapterTitle(chapterTitle, manga.title, chapterUrl);

    // ตรวจสอบเลขตอน เพื่อไม่ให้เลขตอนล่าสุดต่ำกว่าตอนที่อ่านจริง
    const readEpNum = extractEpNumberFromText(cleanChapterTitle);
    const curLatestNum = extractEpNumberFromText(manga.latestEp || (existing ? existing.latestEp : ''));
    const finalLatestEp = (readEpNum > curLatestNum && readEpNum > 0) 
      ? `ตอนที่ ${readEpNum}` 
      : (manga.latestEp || (existing ? existing.latestEp : cleanChapterTitle));

    // กู้คืนหรือสกัดภาพปกอัตโนมัติหากปกเดิมว่าง
    let resolvedCover = manga.cover || (existing ? existing.cover : '');
    if (!resolvedCover && allMangaList && allMangaList.length > 0) {
      const match = allMangaList.find(am => am.title === manga.title || getMangaTitleKeys(am.title).some(k => keys.includes(k)));
      if (match && match.cover) {
        resolvedCover = match.cover;
      }
    }
    if (!resolvedCover && manga.altSources && manga.altSources.length > 0) {
      const altWithCover = manga.altSources.find(a => a.cover);
      if (altWithCover) resolvedCover = altWithCover.cover;
    }

    // สร้างหรืออัปเดตข้อมูลเรื่อง
    const item = {
      title: manga.title,
      cover: resolvedCover,
      type: manga.type || (existing ? existing.type : 'Manga'),
      latestEp: finalLatestEp,
      mangaUrl: manga.mangaUrl || (existing ? existing.mangaUrl : ''),
      sourceId: manga.sourceId || (existing ? existing.sourceId : ''),
      sourceName: manga.sourceName || (existing ? existing.sourceName : 'Online'),
      sourceUrl: manga.sourceUrl || (existing ? existing.sourceUrl : ''),
      sourceType: manga.sourceType || (existing ? existing.sourceType : 'mangareader'),
      readable: manga.readable !== false,
      lang: manga.lang || (existing ? existing.lang : (manga.sourceId === 'mangadex' ? 'en' : 'th')),
      altSources: (manga.altSources && manga.altSources.length > 0) ? manga.altSources : (existing && existing.altSources ? existing.altSources : []),
      lastChapterTitle: cleanChapterTitle,
      lastChapterUrl: chapterUrl,
      readChapters: readChapters,
      updatedAt: Date.now()
    };

    // ลบอันเก่าออกแล้วเอาอันใหม่ขึ้นบนสุด (เรียงตามเวลาอ่านล่าสุด)
    history = history.filter(h => {
      if (h.title === manga.title || h.mangaUrl === manga.mangaUrl) return false;
      const hKeys = getMangaTitleKeys(h.title);
      return !keys.some(k => hKeys.includes(k));
    });

    history.unshift(item);
    if (history.length > 500) history.pop(); // เก็บประวัติสูงสุด 500 เรื่อง

    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
    updateHistoryAndFavCounts();
    pushSyncData(); // ซิงก์ขึ้น Cloudflare KV
  } catch (e) {
    console.warn("Could not save history:", e);
  }
}

// ลบประวัติเรื่องใดเรื่องหนึ่ง
function deleteHistoryItem(itemIdentifier) {
  recordHistoryDeletion(itemIdentifier);
  let history = getReadingHistory();
  const targetKey = typeof itemIdentifier === 'object' ? (itemIdentifier.mangaUrl || itemIdentifier.title) : itemIdentifier;
  const targetTitle = typeof itemIdentifier === 'object' ? itemIdentifier.title : itemIdentifier;
  const targetKeys = targetTitle ? getMangaTitleKeys(targetTitle) : [];

  history = history.filter(h => {
    if (h.mangaUrl === targetKey || h.title === targetTitle) return false;
    if (targetKeys.length > 0) {
      const hKeys = getMangaTitleKeys(h.title);
      if (targetKeys.some(k => hKeys.includes(k))) return false;
    }
    return true;
  });

  try {
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
  } catch (e) {}
  updateHistoryAndFavCounts();
  pushSyncData(); // ซิงก์ขึ้น Cloudflare KV
  if (currentTagFilter === 'history') {
    applyFilters();
  }
}

// ล้างประวัติทั้งหมด
function clearAllHistory() {
  if (confirm('คุณต้องการล้างประวัติการอ่านทั้งหมดในเครื่องใช่หรือไม่?')) {
    const now = Date.now();
    try {
      localStorage.removeItem(STORAGE_HISTORY);
      localStorage.setItem(STORAGE_HISTORY_CLEARED_AT, String(now));
    } catch (e) {}
    updateHistoryAndFavCounts();
    pushSyncData(); // ซิงก์ขึ้น Cloudflare KV
    if (currentTagFilter === 'history') {
      applyFilters();
    }
  }
}

// แปลงเวลาเป็นภาษาไทยแบบสวยงาม เช่น "5 นาทีที่แล้ว"
function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return 'เมื่อสักครู่';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ชม. ที่แล้ว`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} วันที่แล้ว`;
  return new Date(timestamp).toLocaleDateString('th-TH', { month: 'short', day: 'numeric' });
}

// อัปเดตตัวเลขบนปุ่มแท็บ
function updateHistoryAndFavCounts() {
  const tagHist = document.getElementById('tagHistory');
  const tagFav = document.getElementById('tagFavorites');
  const histCount = getReadingHistory().length;
  const favCount = getFavorites().length;
  if (tagHist) tagHist.textContent = `🕒 ประวัติอ่านล่าสุด (${histCount})`;
  if (tagFav) tagFav.textContent = `⭐ เรื่องโปรด (${favCount})`;
}

// อัปเดตปุ่มดาวใน Modal
function updateModalFavButton(manga) {
  const btn = document.getElementById('btnModalFav');
  if (!btn || !manga) return;
  const fav = isFavorite(manga.title);
  if (fav) {
    btn.classList.add('active');
    btn.innerHTML = `<span class="fav-icon">★</span> <span class="fav-text">เป็นเรื่องโปรดแล้ว</span>`;
    btn.title = 'คลิกเพื่อนำออกจากเรื่องโปรด';
  } else {
    btn.classList.remove('active');
    btn.innerHTML = `<span class="fav-icon">⭐</span> <span class="fav-text">บันทึกเป็นเรื่องโปรด</span>`;
    btn.title = 'คลิกเพื่อบันทึกเป็นเรื่องโปรด';
  }
}

// ฟังก์ชันดึงเลขตอนสูงสุดจากข้อความ เช่น "ตอนที่ 177", "Ch. 174" (ตัดวันที่ออกเพื่อป้องกันบั๊กปี ค.ศ.)
function extractEpNumberFromText(text) {
  if (!text) return 0;
  let str = String(text);
  str = str.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
  str = str.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '');
  str = str.replace(/\b202\d\b/g, '');
  str = str.replace(/(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{1,2},?\s+\d{4}/gi, '');
  str = str.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi, '');
  str = str.replace(/อัปเดต|อัพเดต/gi, '');

  const m = str.match(/ตอนที่\s*(\d+(?:\.\d+)?)/i) ||
            str.match(/ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)/i) ||
            str.match(/ep(?:isode)?\.?\s*(\d+(?:\.\d+)?)/i) ||
            str.match(/\b(\d+(?:\.\d+)?)\s*ตอน\b/i) ||
            str.match(/\b(\d+(?:\.\d+)?)\b/);
  return m ? parseFloat(m[1]) : 0;
}

// 8. รวมข้อมูลและตัดเรื่องซ้ำ (Deduplication)
// กฎเหล็ก: "เอาเว็บฟรีขึ้นก่อน" + "ถ้าสถานะเหมือนกัน ให้เอาเว็บที่มีตอนมากที่สุดขึ้นนำ" + ระบบตรวจจับชื่อเรื่องข้ามค่าย
function mergeAndDeduplicate(list) {
  const map = new Map();
  const keyToManga = new Map();

  list.forEach(m => {
    let keys = getMangaTitleKeys(m.title);
    if (!keys || keys.length === 0) {
      keys = [ (m.title || m.mangaUrl || Math.random().toString()).trim().toLowerCase() ];
    }

    // ตรวจสอบ alias พิเศษ
    const matchedAlias = KNOWN_MANGA_ALIASES.find(a => 
      a.keys.some(ak => keys.includes(ak)) || a.sources.some(s => s.mangaUrl === m.mangaUrl)
    );
    if (matchedAlias) {
      matchedAlias.sources.forEach(src => {
        if (src.mangaUrl !== m.mangaUrl) {
          if (!m.altSources) m.altSources = [];
          if (!m.altSources.some(a => a.sourceId === src.sourceId)) {
            m.altSources.push({ ...src });
          }
        }
      });
    }

    // ตรวจสอบว่าเคยมีเรื่องนี้ในฐานข้อมูลหรือยัง
    let existing = null;
    for (const k of keys) {
      if (keyToManga.has(k)) {
        existing = keyToManga.get(k);
        break;
      }
    }

    if (!existing) {
      m.altSources = m.altSources || [];
      keys.forEach(k => keyToManga.set(k, m));
      map.set(keys[0], m);
    } else {
      if (!existing.cover && m.cover) existing.cover = m.cover;
      if (m._searchQuery) existing._searchQuery = m._searchQuery;

      const isNewFree = m.readable !== false;
      const isExistingFree = existing.readable !== false;
      const newEp = extractEpNumberFromText(m.latestEp);
      const existingEp = extractEpNumberFromText(existing.latestEp);

      // เงื่อนไขสลับเว็บใหม่ขึ้นเป็นตัวหลัก:
      // 1. เรื่องเดิมติดเหรียญ/อ่านไม่ได้ แต่เรื่องใหม่เป็นเว็บฟรี 100%
      // 2. ทั้งคู่ฟรี (หรือทั้งคู่ติดเหรียญ) แต่เรื่องใหม่มีจำนวนตอนมากกว่า! (เช่น 177 ชนะ 174)
      const shouldPromoteNew = (!isExistingFree && isNewFree) ||
                               ((isNewFree === isExistingFree) && newEp > existingEp);

      if (shouldPromoteNew) {
        const oldAlts = existing.altSources || [];
        existing.altSources = [];
        
        const mergedAlts = [existing, ...oldAlts.filter(a => a.sourceId !== m.sourceId && a.sourceId !== existing.sourceId)];
        m.altSources = mergedAlts;
        if (existing._searchQuery && !m._searchQuery) {
          m._searchQuery = existing._searchQuery;
        }

        // เชื่อมคีย์ทั้งหมดไปยังตัวหลักใหม่
        const allKeys = [...getMangaTitleKeys(existing.title), ...keys];
        allKeys.forEach(k => keyToManga.set(k, m));

        for (const [mk, val] of map.entries()) {
          if (val === existing) {
            map.delete(mk);
            break;
          }
        }
        map.set(keys[0], m);
      } else {
        if (!existing.altSources) existing.altSources = [];
        if (existing.sourceId !== m.sourceId && !existing.altSources.some(a => a.sourceId === m.sourceId)) {
          existing.altSources.push(m);
        }
        // อัปเดต latestEp ให้โชว์ตอนสูงสุดเสมอหากเรื่องใหม่มีตอนมากกว่า
        if (newEp > existingEp && m.latestEp) {
          existing.latestEp = m.latestEp;
        }
        keys.forEach(k => keyToManga.set(k, existing));
      }
    }
  });

  return Array.from(map.values());
}

// ฟังก์ชันสลับรายการเรื่องแบบ Round-Robin เพื่อให้เรื่องที่อัปเดตล่าสุดของแต่ละเว็บขึ้นมาอยู่หน้าแรกเหมือนเว็บการ์ตูนจริง
function interleaveSources(arrays) {
  const result = [];
  let maxLen = 0;
  arrays.forEach(a => {
    if (a.length > maxLen) maxLen = a.length;
  });

  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrays) {
      if (i < arr.length) {
        result.push(arr[i]);
      }
    }
  }
  return result;
}

// สถานะสุขภาพการเชื่อมต่อของแต่ละเว็บ (Health Status)
// ถ้าเว็บไหนไม่สามารถเชื่อมต่อได้ จะขึ้นสถานะสีแดงแจ้งเตือนให้ผู้ใช้ทราบ
let sourceHealthStatus = {};

// 9. ดึงข้อมูลมังงะเดี่ยวของแต่ละเว็บ พร้อม Timeout 15 วินาที
async function fetchSingleSource(source, page = 1, timeoutMs = 15000) {
  try {
    let targetUrl = source.url;
    if (source.type === 'mangareader') {
      targetUrl = page > 1 ? `${source.url}/page/${page}/` : source.url;
    } else if (source.type === 'madara') {
      targetUrl = page > 1 ? `${source.url}/page/${page}/` : source.url;
    } else if (source.type === 'whytoon') {
      targetUrl = page > 1 ? `${source.url}/browse/page/${page}` : `${source.url}/browse`;
    } else if (source.type === 'readtoon') {
      targetUrl = page > 1 ? `${source.url}/discover/manga?page=${page}` : `${source.url}/discover/manga`;
    } else if (source.type === 'ntrnaja') {
      targetUrl = page > 1 ? `${source.url}/manga/page/${page}/?sort=update` : `${source.url}/manga/?sort=update`;
    } else if (source.type === 'kairew') {
      targetUrl = `${source.url}/manga`;
    } else if (source.type === 'mangatown') {
      targetUrl = page > 1 ? `${source.url}/new/${page}.htm` : `${source.url}/new/`;
    } else if (source.type === 'asurascans') {
      targetUrl = page > 1 ? `${source.url}/comics?page=${page}` : `${source.url}/`;
    }

    const html = await fetchViaProxy(targetUrl, {}, timeoutMs);
    let items = [];
    if (source.type === 'whytoon') {
      items = parseWhyToonHtml(html, source);
    } else if (source.type === 'readtoon') {
      items = parseReadToonHtml(html, source);
    } else if (source.type === 'ntrnaja') {
      items = parseNtrNajaHtml(html, source);
      probeNtrnajaChapters(items);
    } else if (source.type === 'kairew') {
      items = parseKairewHtml(html, source);
    } else if (source.type === 'madara') {
      items = parseMadaraHtml(html, source);
    } else if (source.type === 'mangatown') {
      items = parseMangaTownHtml(html, source);
    } else if (source.type === 'asurascans') {
      items = parseAsuraScansHtml(html, source);
    } else {
      items = parseMangaReaderHtml(html, source);
    }

    if (items.length > 0) {
      sourceHealthStatus[source.id] = { ok: true, count: items.length };
    } else {
      if (!sourceHealthStatus[source.id]) {
        sourceHealthStatus[source.id] = { ok: true };
      }
    }
    return items;
  } catch (e) {
    console.warn(`Fetch error for ${source.name} page ${page}:`, e.message);
    const isOriginDead = /HTTP (?:404|500|502|503)|ENOTFOUND|getaddrinfo/i.test(e.message);
    if (isOriginDead && !source.isCoin) {
      sourceHealthStatus[source.id] = { ok: false, error: e.message };
    } else {
      sourceHealthStatus[source.id] = { ok: true };
    }
    return [];
  }
}

// ดึงข้อมูลมังงะแบบรวมทุกเว็บ (สำหรับปุ่มโหลดเรื่องเพิ่มเติม หรือรีเฟรชทั้งหมด)
async function fetchMangaBatch(page = 1) {
  const promises = CONFIG.SOURCES.map(source => fetchSingleSource(source, page));
  const results = await Promise.allSettled(promises);
  const sourceArrays = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
      sourceArrays.push(r.value);
    }
  });

  updateSourceHealthUi();
  return interleaveSources(sourceArrays);
}

// ==========================================================
// ระบบตัวกรองภาษาย่อย (Language Sub-Filter Controller)
// ค่าเริ่มต้น: ไทยเป็นหลัก ('th')
// กฎ: เลือกได้ทั้งสอง หรืออย่างใดอย่างหนึ่ง ถ้าไม่เลือกเลยจะถือว่าเลือกทั้งหมด
// ==========================================================
// ระบบตัวกรองภาษาย่อย (Language Sub-Filter Controller)
// ค่าเริ่มต้น: ไทยเป็นหลัก ('th')
// กฎ: เลือกได้หลายภาษา หรืออย่างใดอย่างหนึ่ง ถ้าไม่เลือกเลยจะถือว่าเลือกทั้งหมด
// ==========================================================
const ALL_SUPPORTED_LANGS = ['th', 'en', 'ja', 'ko'];
let selectedLanguages = new Set(['th']);

function getSelectedLanguages() {
  if (!selectedLanguages || selectedLanguages.size === 0) {
    return new Set(ALL_SUPPORTED_LANGS);
  }
  return selectedLanguages;
}

function updateLanguageFilterUI() {
  const btnTh = document.getElementById('btnLangTh');
  const btnEn = document.getElementById('btnLangEn');
  const btnJa = document.getElementById('btnLangJa');
  const btnKo = document.getElementById('btnLangKo');
  const btnAll = document.getElementById('btnLangAll');

  if (btnTh) btnTh.classList.toggle('active', selectedLanguages.has('th'));
  if (btnEn) btnEn.classList.toggle('active', selectedLanguages.has('en'));
  if (btnJa) btnJa.classList.toggle('active', selectedLanguages.has('ja'));
  if (btnKo) btnKo.classList.toggle('active', selectedLanguages.has('ko'));

  const isAll = ALL_SUPPORTED_LANGS.every(l => selectedLanguages.has(l));
  if (btnAll) btnAll.classList.toggle('active', isAll);
}

async function ensureMangaDexLoaded(lang = 'en') {
  if (mangadexLoadedLangs.has(lang) || mangadexLoading) return;
  mangadexLoading = true;
  try {
    const mdItems = await fetchMangaDexBatch(40, 1, lang);
    if (Array.isArray(mdItems) && mdItems.length > 0) {
      const existingUrls = new Set(allMangaList.map(m => m.mangaUrl));
      const newItems = mdItems.filter(m => !existingUrls.has(m.mangaUrl));
      allMangaList = [...allMangaList, ...newItems];
      mangadexLoadedLangs.add(lang);
      updateSourceCounts();
      try {
        sessionStorage.setItem('cached_all_manga', JSON.stringify(allMangaList));
      } catch (e) {}
    }
  } catch (err) {
    console.warn("Error loading MangaDex items for " + lang + ":", err);
  } finally {
    mangadexLoading = false;
  }
}

function setupLanguageFilter() {
  const btnTh = document.getElementById('btnLangTh');
  const btnEn = document.getElementById('btnLangEn');
  const btnJa = document.getElementById('btnLangJa');
  const btnKo = document.getElementById('btnLangKo');
  const btnAll = document.getElementById('btnLangAll');

  const onLangChange = async () => {
    updateLanguageFilterUI();
    const needed = ['en', 'ja', 'ko'].filter(l => selectedLanguages.has(l) && !mangadexLoadedLangs.has(l));
    if (needed.length > 0) {
      const bgBadge = document.getElementById('bgLoadingBadge');
      const bgText = document.getElementById('bgLoadingText');
      if (bgBadge && bgText) {
        bgBadge.style.display = 'inline-flex';
        bgText.textContent = 'กำลังดึงการ์ตูน MangaDex...';
      }
      for (const l of needed) {
        await ensureMangaDexLoaded(l);
      }
      if (bgBadge) bgBadge.style.display = 'none';
    }
    applyFilters();
  };

  const bindLangBtn = (btn, langKey) => {
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener('click', () => {
      if (selectedLanguages.has(langKey)) {
        selectedLanguages.delete(langKey);
        if (selectedLanguages.size === 0) {
          ALL_SUPPORTED_LANGS.forEach(l => selectedLanguages.add(l));
        }
      } else {
        selectedLanguages.add(langKey);
      }
      onLangChange();
    });
  };

  bindLangBtn(btnTh, 'th');
  bindLangBtn(btnEn, 'en');
  bindLangBtn(btnJa, 'ja');
  bindLangBtn(btnKo, 'ko');

  if (btnAll && !btnAll.dataset.bound) {
    btnAll.dataset.bound = "1";
    btnAll.addEventListener('click', () => {
      ALL_SUPPORTED_LANGS.forEach(l => selectedLanguages.add(l));
      onLangChange();
    });
  }

  updateLanguageFilterUI();
}

// 10. ระบบกรองข้อมูล (Filter Engine)
function applyFilters() {
  const historyToolbar = document.getElementById('historyToolbar');
  if (historyToolbar) {
    historyToolbar.style.display = currentTagFilter === 'history' ? 'flex' : 'none';
  }

  const favoritesToolbar = document.getElementById('favoritesToolbar');
  if (favoritesToolbar) {
    favoritesToolbar.style.display = currentTagFilter === 'favorites' ? 'flex' : 'none';
  }

  const cloudSyncBar = document.getElementById('cloudSyncBar');
  if (cloudSyncBar) {
    cloudSyncBar.style.display = (currentTagFilter === 'history' || currentTagFilter === 'favorites') ? 'flex' : 'none';
  }

  let baseList = allMangaList;
  if (currentTagFilter === 'history') {
    baseList = getReadingHistory();
  } else if (currentTagFilter === 'favorites') {
    baseList = getFavorites();
  }

  const allowedLangs = getSelectedLanguages();

  filteredList = baseList.filter(m => {
    // 0. Language filter (กรองภาษาตามปุ่มที่เลือก ทั้งตอนดูปกติและตอนค้นหา)
    const mangaLang = m.lang || 'th';
    if (currentSourceFilter === 'all') {
      if (!allowedLangs.has(mangaLang)) return false;
    }

    // 1. Source filter (แยกตามเว็บต้นทาง)
    if (currentSourceFilter !== 'all') {
      const matchSource = m.sourceId === currentSourceFilter || 
                          (m.altSources && m.altSources.some(alt => alt.sourceId === currentSourceFilter));
      if (!matchSource) return false;
    }

    // 2. Tag filter (หมวดหมู่ทั่วไป)
    if (currentTagFilter !== 'all' && currentTagFilter !== 'history' && currentTagFilter !== 'favorites') {
      const typeLower = (m.type || '').toLowerCase();
      const tagsLower = Array.isArray(m.tags) ? m.tags.map(t => t.toLowerCase()) : [];
      if (currentTagFilter === 'manhwa') {
        if (!typeLower.includes('manhwa') && !m.title.includes('เกาหลี') && !tagsLower.includes('manhwa')) return false;
      } else if (currentTagFilter === 'manhua') {
        if (!typeLower.includes('manhua') && !m.title.includes('จีน') && !tagsLower.includes('manhua')) return false;
      } else if (currentTagFilter === 'manga') {
        if (!typeLower.includes('manga') && !tagsLower.includes('manga')) return false;
      } else if (currentTagFilter === 'romance') {
        if (!m.sourceName.includes('Fin') && !m.title.includes('รัก') && !m.title.includes('สาว') && !m.title.includes('ภรรยา') && !tagsLower.includes('romance')) return false;
      } else if (currentTagFilter === 'action') {
        if (!m.title.includes('เทพ') && !m.title.includes('จุติ') && !m.title.includes('เลเวล') && !m.title.includes('ดาบ') && !m.title.includes('ราชา') && !m.title.includes('ยุทธ') && !tagsLower.includes('action')) return false;
      } else if (currentTagFilter === 'doujin') {
        if (!m.sourceName.includes('Ecchi') && !m.sourceName.includes('Doujin') && !typeLower.includes('doujin') && !typeLower.includes('18+') && !tagsLower.includes('doujinshi')) return false;
      }
    }

    // 3. Search query (ค้นหา - รองรับชื่อเรื่อง, คำค้นหาแยกคำ, รหัส UUID และ URL เต็ม เช่น Gundam Hathaway)
    if (currentSearchQuery) {
      const q = currentSearchQuery.trim().toLowerCase();
      const isFromSearch = m._searchQuery && (m._searchQuery === q || q.includes(m._searchQuery) || m._searchQuery.includes(q));

      // ตรวจสอบ UUID / URL เต็ม
      const uuidMatch = q.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      const targetUuid = uuidMatch ? uuidMatch[1].toLowerCase() : '';
      const matchUuid = targetUuid && (m.mangaId === targetUuid || (m.mangaUrl && m.mangaUrl.toLowerCase().includes(targetUuid)));

      // แยกคำและตัดเครื่องหมายวรรคตอน (Tokenized Match เช่น Gundam: Hathaway's -> gundam hathaway)
      const normQ = q.replace(/https?:\/\/[^\s]+/g, '').replace(/[^a-z0-9\u0E00-\u0E7F\s]/gi, ' ').trim();
      const normTitle = (m.title || '').toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F\s]/gi, ' ');
      const qWords = normQ.split(/\s+/).filter(w => w.length > 1);
      const matchAllWords = qWords.length > 0 && qWords.every(w => normTitle.includes(w));

      const matchSearch = isFromSearch ||
                          matchUuid ||
                          matchAllWords ||
                          (m.title && m.title.toLowerCase().includes(q)) || 
                          (m.mangaUrl && m.mangaUrl.toLowerCase().includes(q)) ||
                          (m.type && m.type.toLowerCase().includes(q)) || 
                          (m.latestEp && m.latestEp.toLowerCase().includes(q)) ||
                          (m.lastChapterTitle && m.lastChapterTitle.toLowerCase().includes(q)) ||
                          (m.sourceName && m.sourceName.toLowerCase().includes(q));
      if (!matchSearch) return false;
    }

    return true;
  });

  // จัดการลำดับการแสดงผล:
  if (currentSearchQuery) {
    // กรณีพิมพ์ค้นหา: ให้การ์ตูนไทยขึ้นนำก่อนเสมอ
    if (allowedLangs.has('th')) {
      filteredList.sort((a, b) => {
        const aTh = (a.lang || 'th') === 'th';
        const bTh = (b.lang || 'th') === 'th';
        if (aTh && !bTh) return -1;
        if (!aTh && bTh) return 1;
        return 0;
      });
    }
  } else if (allowedLangs.size > 1 && currentTagFilter === 'all' && currentSourceFilter === 'all') {
    // กรณีเลือกหลายภาษาหรือทั้งหมดในหน้าแรก: สลับกันขึ้น (Interleave) เพื่อให้มังงะสากล (EN/JA/KO) ปรากฏร่วมกับมังงะไทยในหน้าแรก
    const thList = filteredList.filter(m => (m.lang || 'th') === 'th');
    const foreignList = filteredList.filter(m => (m.lang || 'th') !== 'th');
    if (thList.length > 0 && foreignList.length > 0) {
      const interleaved = [];
      let thIdx = 0;
      let fIdx = 0;
      // สลับอัตราส่วน: การ์ตูนไทย 2-3 เรื่อง ต่อ การ์ตูนสากล 1 เรื่อง
      while (thIdx < thList.length || fIdx < foreignList.length) {
        for (let i = 0; i < 3 && thIdx < thList.length; i++) {
          interleaved.push(thList[thIdx++]);
        }
        if (fIdx < foreignList.length) {
          interleaved.push(foreignList[fIdx++]);
        }
      }
      filteredList = interleaved;
    }
  } else if (allowedLangs.has('th') && allowedLangs.size > 1) {
    // ในหมวดอื่นๆ ที่ไม่ใช่หน้าแรก ให้การ์ตูนไทยนำหน้า
    filteredList.sort((a, b) => {
      const aTh = (a.lang || 'th') === 'th';
      const bTh = (b.lang || 'th') === 'th';
      if (aTh && !bTh) return -1;
      if (!aTh && bTh) return 1;
      return 0;
    });
  }

  currentDisplayCount = 40;
  renderMangaCards();
  updateSourceCounts();
  updateHistoryAndFavCounts();
}

// ฟังก์ชันจัดการปุ่มย่อ/ขยายรายการเว็บต้นทาง (Collapsible Source Bar)
function initSourceBarToggle() {
  const toggleBtn = document.getElementById('btnToggleSources');
  const sourceTabs = document.getElementById('sourceTabs');
  const toggleIcon = document.getElementById('toggleSourcesIcon');
  const toggleText = document.getElementById('toggleSourcesText');

  if (!toggleBtn || !sourceTabs) return;

  // ถ้าเป็นหน้าจอมือถือ (ความกว้าง <= 768px) ให้ย่อรายการไว้เป็นค่าเริ่มต้นเพื่อไม่ให้บังหน้าจอ
  const isMobile = window.innerWidth <= 768;
  let isCollapsed = isMobile;

  const updateUi = () => {
    if (isCollapsed) {
      sourceTabs.classList.add('collapsed');
      if (toggleIcon) toggleIcon.textContent = '▼';
      if (toggleText) toggleText.textContent = `เลือกเว็บ (${CONFIG.SOURCES.length})`;
    } else {
      sourceTabs.classList.remove('collapsed');
      if (toggleIcon) toggleIcon.textContent = '▲';
      if (toggleText) toggleText.textContent = 'ย่อรายการเว็บ';
    }
  };

  updateUi();

  toggleBtn.onclick = (e) => {
    e.preventDefault();
    isCollapsed = !isCollapsed;
    updateUi();
  };
}

// อัปเดตแถบแจ้งเตือนและป้ายสถานะสีแดงเมื่อมีเว็บต้นทางขัดข้อง
function updateSourceHealthUi() {
  const alertBar = document.getElementById('sourceAlertBar');
  const offlineSources = CONFIG.SOURCES.filter(s => !s.isCoin && sourceHealthStatus[s.id] && sourceHealthStatus[s.id].ok === false);

  if (alertBar) {
    if (offlineSources.length > 0) {
      const names = offlineSources.map(s => s.name).join(', ');
      alertBar.style.display = 'block';
      alertBar.innerHTML = `
        <div class="source-alert-banner">
          <span class="source-alert-icon">⚠️</span>
          <span><strong>ตรวจพบเว็บต้นทางขัดข้อง (${names}):</strong> ต้นทางอาจปิดปรับปรุง ล่มชั่วคราว หรือเปลี่ยนระบบรักษาความปลอดภัย คุณยังสามารถอ่านเรื่องจากเว็บอื่นๆ ได้ตามปกติ</span>
        </div>
      `;
    } else {
      alertBar.style.display = 'none';
      alertBar.innerHTML = '';
    }
  }

  // อัปเดตสถานะสีแดงบนปุ่มแท็บ
  CONFIG.SOURCES.forEach(source => {
    const btn = document.querySelector(`.source-tag[data-source="${source.id}"]`);
    if (btn) {
      const isOffline = !source.isCoin && sourceHealthStatus[source.id] && sourceHealthStatus[source.id].ok === false;
      const existingBadge = btn.querySelector('.source-status-badge');
      if (isOffline) {
        btn.classList.add('offline');
        if (!existingBadge) {
          const badge = document.createElement('span');
          badge.className = 'source-status-badge error';
          badge.textContent = '🔴 ขัดข้อง';
          btn.appendChild(badge);
        }
      } else {
        btn.classList.remove('offline');
        if (existingBadge) existingBadge.remove();
      }
    }
  });
}

// สร้างปุ่มแยกเว็บต้นทาง (Source Tabs)
function renderSourceTabs() {
  const container = document.getElementById('sourceTabs');
  if (!container) return;

  container.innerHTML = `
    <button class="source-tag ${currentSourceFilter === 'all' ? 'active' : ''}" data-source="all">
      <span class="source-icon">✨</span>
      <span class="source-name">ทั้งหมด (รวมทุกเว็บ)</span>
      <span class="source-count" id="count-all">${allMangaList.length}</span>
    </button>
  `;

  const allAvailableSources = [...CONFIG.SOURCES];
  if (CONFIG.MANGADEX && !allAvailableSources.some(s => s.id === CONFIG.MANGADEX.id)) {
    allAvailableSources.push(CONFIG.MANGADEX);
  }

  allAvailableSources.forEach(source => {
    const isOffline = !source.isCoin && sourceHealthStatus[source.id] && sourceHealthStatus[source.id].ok === false;
    const btn = document.createElement('button');
    btn.className = `source-tag ${currentSourceFilter === source.id ? 'active' : ''} ${isOffline ? 'offline' : ''}`;
    btn.setAttribute('data-source', source.id);
    btn.innerHTML = `
      <span class="source-icon">${source.icon || '🌐'}</span>
      <span class="source-name">${source.name}</span>
      <span class="source-count" id="count-${source.id}">0</span>
      ${isOffline ? '<span class="source-status-badge error">🔴 ขัดข้อง</span>' : ''}
    `;
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.source-tag').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      currentSourceFilter = source.id;

      if (source.id === 'mangadex' || source.lang === 'en') {
        selectedLanguages.add(source.lang || 'en');
        updateLanguageFilterUI();
      }

      if (source.id === 'mangadex') {
        const bgBadge = document.getElementById('bgLoadingBadge');
        const bgText = document.getElementById('bgLoadingText');
        if (bgBadge && bgText) {
          bgBadge.style.display = 'inline-flex';
          bgText.textContent = 'กำลังดึงการ์ตูน MangaDex...';
        }
        await ensureMangaDexLoaded('en');
        if (bgBadge) bgBadge.style.display = 'none';
      }

      applyFilters();
    });
    container.appendChild(btn);
  });

  const allBtn = container.querySelector('[data-source="all"]');
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      document.querySelectorAll('.source-tag').forEach(t => t.classList.remove('active'));
      allBtn.classList.add('active');
      currentSourceFilter = 'all';
      applyFilters();
    });
  }

  updateSourceCounts();
  updateSourceHealthUi();
}

function updateSourceCounts() {
  const allCountEl = document.getElementById('count-all');
  if (allCountEl) allCountEl.textContent = allMangaList.length;

  const allAvailableSources = [...CONFIG.SOURCES];
  if (CONFIG.MANGADEX && !allAvailableSources.some(s => s.id === CONFIG.MANGADEX.id)) {
    allAvailableSources.push(CONFIG.MANGADEX);
  }

  allAvailableSources.forEach(source => {
    const el = document.getElementById(`count-${source.id}`);
    if (el) {
      const count = allMangaList.filter(m => 
        m.sourceId === source.id || (m.altSources && m.altSources.some(alt => alt.sourceId === source.id))
      ).length;
      el.textContent = count;
    }
  });

  updateSourceHealthUi();
}

// ==========================================================
// ระบบแชทส่วนกลาง (Community Chat System)
// ==========================================================
const CHAT_STORAGE_NICKNAME = 'clean_manga_chat_nickname';

// ตัวช่วย Escape HTML ป้องกัน XSS
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// เปิดมังงะจากการแตะแท็กในแชท
function openMangaFromChat(mangaTitle, mangaUrl) {
  if (!mangaTitle) return;

  // 1. ลองหาใน allMangaList ก่อน
  let matched = (allMangaList || []).find(m => m.title === mangaTitle || (mangaUrl && m.mangaUrl === mangaUrl));
  if (!matched) {
    const keys = getMangaTitleKeys(mangaTitle);
    matched = (allMangaList || []).find(m => {
      const mKeys = getMangaTitleKeys(m.title);
      return keys.some(k => mKeys.includes(k));
    });
  }

  if (matched) {
    openChapterModal(matched);
  } else {
    // ถ้าไม่เจอในรายการที่โหลดมา ให้สร้างการ์ดชั่วคราวเปิดขึ้นมาอ่านได้ทันที
    const tempManga = {
      title: mangaTitle,
      mangaUrl: mangaUrl || '',
      sourceName: 'Online',
      sourceType: 'mangareader',
      readable: true
    };
    openChapterModal(tempManga);
  }
}

// ดึงข้อความแชท
async function fetchChatMessages() {
  const container = document.getElementById('chatMessagesList');
  const countEl = document.getElementById('chatMessageCount');
  if (!container) return;

  try {
    const apiUrl = CONFIG.CHAT_API_URL || '/api/chat';
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const messages = data.messages || [];

    if (countEl) countEl.textContent = `${messages.length} ข้อความล่าสุด`;

    if (messages.length === 0) {
      container.innerHTML = '<div class="chat-empty-text">ยังไม่มีข้อความ เริ่มพิมพ์พูดคุยหรือป้ายยาเป็นคนแรกได้เลย! ✨</div>';
      return;
    }

    container.innerHTML = '';
    messages.forEach(msg => {
      const item = document.createElement('div');
      const isBot = (msg.nickname || '').includes('Bot') || (msg.nickname || '').includes('บอท');
      item.className = isBot ? 'chat-item chat-item-bot' : 'chat-item';

      const botBadgeHtml = isBot ? '<span class="chat-bot-badge">BOT</span>' : '';
      const nameClass = isBot ? 'chat-user-name bot-name' : 'chat-user-name';

      let storyTagHtml = '';
      if (msg.mangaTitle) {
        storyTagHtml = `
          <button type="button" class="chat-story-tag" data-title="${encodeURIComponent(msg.mangaTitle)}" data-url="${encodeURIComponent(msg.mangaUrl || '')}" title="แตะเพื่อเปิดอ่านเรื่องนี้">
            <span>📖</span> ${escapeHtml(msg.mangaTitle)} ↗
          </button>
        `;
      }

      item.innerHTML = `
        <div class="chat-item-header">
          <span class="${nameClass}">${escapeHtml(msg.nickname || 'สหายมังงะ')}</span>
          ${botBadgeHtml}
          <span class="chat-time">${formatTimeAgo(msg.time)}</span>
          ${storyTagHtml}
        </div>
        <div class="chat-item-body">${escapeHtml(msg.text)}</div>
      `;

      const tagBtn = item.querySelector('.chat-story-tag');
      if (tagBtn) {
        tagBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetTitle = decodeURIComponent(tagBtn.getAttribute('data-title') || '');
          const targetUrl = decodeURIComponent(tagBtn.getAttribute('data-url') || '');
          openMangaFromChat(targetTitle, targetUrl);
        });
      }

      container.appendChild(item);
    });
  } catch (err) {
    console.warn("Fetch chat error:", err);
    if (container && container.children.length === 0) {
      container.innerHTML = '<div class="chat-empty-text" style="color:#ff7777;">ไม่สามารถเชื่อมต่อห้องแชทได้ชั่วคราว</div>';
    }
  }
}

// เริ่มต้นระบบแชท
function initChatComponent(currentMangaContext = null) {
  const form = document.getElementById('chatForm');
  const nickInput = document.getElementById('chatNicknameInput');
  const textInput = document.getElementById('chatTextInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const refreshBtn = document.getElementById('chatRefreshBtn');
  const randomBtn = document.getElementById('chatRandomBtn');
  const badgeEl = document.getElementById('chatCurrentMangaBadge');

  if (!form) return;

  // จำชื่อเล่นเดิม
  try {
    const savedNick = localStorage.getItem(CHAT_STORAGE_NICKNAME);
    if (savedNick && nickInput) {
      nickInput.value = savedNick;
    }
  } catch (err) {}

  // เมื่อผู้ใช้เปลี่ยนชื่อเล่น ให้บันทึกและซิงก์ขึ้นคลาวด์ทันที
  if (nickInput && !nickInput.dataset.syncBound) {
    nickInput.dataset.syncBound = "1";
    nickInput.addEventListener('change', () => {
      const val = nickInput.value.trim();
      if (val) {
        localStorage.setItem(CHAT_STORAGE_NICKNAME, val);
        pushSyncData();
      }
    });
  }

  // แสดงแท็กเรื่องปัจจุบัน
  if (badgeEl && currentMangaContext && currentMangaContext.title) {
    badgeEl.style.display = 'inline-block';
    badgeEl.textContent = `📖 ตอนนี้: ${currentMangaContext.title}`;
    badgeEl.title = currentMangaContext.title;
  }

  // ปุ่มรีเฟรช
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "1";
    refreshBtn.onclick = () => fetchChatMessages();
  }

  // ฟังก์ชันให้บอทสุ่มแนะนำการ์ตูน
  const triggerBotRandom = async () => {
    let pool = (typeof allMangaList !== 'undefined' && Array.isArray(allMangaList) && allMangaList.length > 0)
      ? allMangaList
      : [];

    if (pool.length === 0) {
      try {
        const cached = sessionStorage.getItem('cached_all_manga');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) pool = parsed;
        }
      } catch (e) {}
    }

    const fallbackList = [
      { title: "Solo Leveling", mangaUrl: "" },
      { title: "Omniscient Reader's Viewpoint", mangaUrl: "" },
      { title: "The Beginning After the End", mangaUrl: "" },
      { title: "Cosmic Heavenly Demon 3077", mangaUrl: "" },
      { title: "Magic Emperor", mangaUrl: "" },
      { title: "Nano Machine", mangaUrl: "" },
      { title: "Return of the Mount Hua Sect", mangaUrl: "" },
      { title: "Pick Me Up, Infinite Gacha", mangaUrl: "" },
      { title: "Reincarnation of the Suicidal Battle God", mangaUrl: "" },
      { title: "Damn Reincarnation", mangaUrl: "" }
    ];

    const targetList = pool.length > 0 ? pool : fallbackList;
    const picked = targetList[Math.floor(Math.random() * targetList.length)];

    const botPhrases = [
      "🎲 สุ่มได้เรื่องนี้เลย! ใครหาเรื่องอ่านอยู่ ลองจัดเรื่องนี้ดูครับ",
      "⚡ บอทขอป้ายยาเรื่องนี้ เนื้อเรื่องเดือด น่าติดตามมาก!",
      "📖 หยิบเรื่องนี้มาฝาก ลองแตะแท็กเพื่อเปิดอ่านได้ทันทีนะ",
      "🔥 สุ่มให้แล้ว! เรื่องนี้อ่านเพลิน ไม่ควรพลาด"
    ];
    const phrase = botPhrases[Math.floor(Math.random() * botPhrases.length)];

    try {
      const apiUrl = CONFIG.CHAT_API_URL || '/api/chat';
      await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: "CleanManga Bot ⚡",
          text: phrase,
          mangaTitle: picked.title || 'มังงะแนะนำ',
          mangaUrl: picked.mangaUrl || ''
        })
      });
      await fetchChatMessages();
    } catch (err) {
      console.warn("Bot random post error:", err);
    }
  };

  // ปุ่มให้บอทสุ่มแนะนำการ์ตูน
  if (randomBtn && !randomBtn.dataset.bound) {
    randomBtn.dataset.bound = "1";
    randomBtn.onclick = async () => {
      randomBtn.disabled = true;
      const origText = randomBtn.textContent;
      randomBtn.textContent = '⏳ กำลังสุ่ม...';
      try {
        await triggerBotRandom();
      } finally {
        randomBtn.disabled = false;
        randomBtn.textContent = origText;
      }
    };
  }

  // ส่งข้อความ
  if (!form.dataset.bound) {
    form.dataset.bound = "1";
    form.onsubmit = async (e) => {
      e.preventDefault();
      const nickname = (nickInput ? nickInput.value : '').trim() || 'สหายมังงะ';
      const text = (textInput ? textInput.value : '').trim();

      if (!text) return;

      // ตรวจสอบคำสั่งบอท
      const isRandomCommand = /^\/(?:random|สุ่ม|แนะนํา|แนะนำ)/i.test(text);
      const isHelpCommand = /^\/(?:help|คำสั่ง|วิธีใช้)/i.test(text);

      // บันทึกชื่อเล่นไว้ใช้ครั้งต่อไป
      try {
        localStorage.setItem(CHAT_STORAGE_NICKNAME, nickname);
        pushSyncData();
      } catch (err) {}

      if (sendBtn) sendBtn.disabled = true;

      try {
        const payload = {
          nickname,
          text,
          mangaTitle: currentMangaContext ? currentMangaContext.title : '',
          mangaUrl: currentMangaContext ? (currentMangaContext.mangaUrl || '') : ''
        };

        const apiUrl = CONFIG.CHAT_API_URL || '/api/chat';
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (textInput) textInput.value = '';
        await fetchChatMessages();

        // คำสั่งบอทตอบสนองอัตโนมัติ
        if (isRandomCommand) {
          setTimeout(async () => {
            await triggerBotRandom();
          }, 400);
        } else if (isHelpCommand) {
          setTimeout(async () => {
            try {
              await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  nickname: "CleanManga Bot ⚡",
                  text: "🤖 คำสั่งที่ใช้ได้: กดปุ่ม [🎲 สุ่มการ์ตูน] หรือพิมพ์ /random เพื่อให้บอทสุ่มมังงะน่าอ่าน หรือพิมพ์คุย/ป้ายยาตามสบายได้เลยครับ!",
                  mangaTitle: '',
                  mangaUrl: ''
                })
              });
              await fetchChatMessages();
            } catch (e) {}
          }, 400);
        }
      } catch (err) {
        alert('ส่งข้อความไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      } finally {
        if (sendBtn) sendBtn.disabled = false;
      }
    };
  }

  // ดึงข้อความทันที
  fetchChatMessages();
}

// ==========================================================
// ค้นหาคลังใหญ่ข้ามเว็บ (Global Live Search)
// ==========================================================
async function performGlobalLiveSearch(query) {
  if (!query || query.trim().length < 2) return;
  const q = query.trim();
  const btn = document.getElementById('btnGlobalSearch');
  const btnText = document.getElementById('globalSearchBtnText');
  if (btn) btn.disabled = true;
  if (btnText) btnText.innerHTML = `⏳ กำลังค้นหา "${escapeHtml(q)}" ในคลังใหญ่ของทุกเว็บ...`;

  const sourcesToSearch = CONFIG.SOURCES;
  const promises = sourcesToSearch.map(async (source) => {
    try {
      let searchUrl = `${source.url}/?s=${encodeURIComponent(q)}`;
      if (source.type === 'madara') {
        searchUrl += '&post_type=wp-manga';
      } else if (source.type === 'ntrnaja') {
        searchUrl = `${source.url}/manga/?q=${encodeURIComponent(q)}`;
      } else if (source.type === 'mangatown') {
        searchUrl = `${source.url}/search?name=${encodeURIComponent(q)}`;
      } else if (source.type === 'asurascans') {
        searchUrl = `${source.url}/comics?search=${encodeURIComponent(q)}`;
      }
      const html = await fetchViaProxy(searchUrl, {}, 10000);
      let items = [];
      if (source.type === 'madara') {
        items = parseMadaraHtml(html, source);
      } else if (source.type === 'ntrnaja') {
        items = parseNtrNajaHtml(html, source);
        probeNtrnajaChapters(items);
      } else if (source.type === 'mangatown') {
        items = parseMangaTownHtml(html, source);
      } else if (source.type === 'asurascans') {
        items = parseAsuraScansHtml(html, source);
      } else {
        items = parseMangaReaderHtml(html, source);
      }
      return items;
    } catch (e) {
      console.warn(`Global search error for ${source.name}:`, e.message);
      return [];
    }
  });
  const results = await Promise.allSettled(promises);
  let foundItems = [];
  
  // ค้นหาใน MangaDex เพิ่มเติมถ้าเปิดภาษาอังกฤษหรือคำค้นหามีภาษาอังกฤษ
  if (selectedLanguages.has('en') || /[a-zA-Z]/.test(q)) {
    try {
      const mdSearchResults = await searchMangaDex(q, 25);
      if (Array.isArray(mdSearchResults) && mdSearchResults.length > 0) {
        foundItems.push(...mdSearchResults);
      }
    } catch (e) {}
  }
  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      foundItems.push(...r.value);
    }
  });

  if (btn) btn.disabled = false;

  if (foundItems.length > 0) {
    // กำหนด _searchQuery ให้ทุกรายการที่ค้นพบ เพื่อให้ผ่านการคัดกรองใน applyFilters
    foundItems.forEach(item => {
      item._searchQuery = q.toLowerCase();
    });

    // นำรายการที่ค้นพบขึ้นมาอยู่ด้านหน้า เพื่อให้เห็นทันที
    allMangaList = mergeAndDeduplicate([...foundItems, ...allMangaList]);
    try {
      sessionStorage.setItem('cached_all_manga', JSON.stringify(allMangaList));
    } catch (e) {}

    // คัดกรองและแสดงผลทันที
    applyFilters();

    if (btnText) {
      btnText.innerHTML = `✓ พบ ${filteredList.length} เรื่อง (${foundItems.length} แหล่ง) ในคลังใหญ่! แสดงผลเรียบร้อย`;
    }
    setTimeout(() => {
      if (btnText && currentSearchQuery) {
        btnText.textContent = `ค้นหา "${currentSearchQuery}" ในคลังใหญ่ของทุกเว็บ (หาเรื่องเก่า/จบแล้ว) ➔`;
      }
    }, 4000);
  } else {
    if (btnText) btnText.innerHTML = `ไม่พบเรื่องที่ตรงกับ "${escapeHtml(q)}" เพิ่มเติมในคลังใหญ่`;
    setTimeout(() => {
      if (btnText && currentSearchQuery) {
        btnText.textContent = `ค้นหา "${currentSearchQuery}" ในคลังใหญ่ของทุกเว็บ (หาเรื่องเก่า/จบแล้ว) ➔`;
      }
    }, 3500);
  }
}

// ==========================================================
// นำเข้ามังงะโดยตรงจากลิงก์เว็บอื่น (Direct URL Import)
// ==========================================================
async function importMangaByDirectUrl(urlStr) {
  if (!urlStr) return;
  const rawUrl = urlStr.trim();
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    alert('กรุณากรอก URL ที่ถูกต้อง (เช่น https://...)');
    return;
  }

  const btn = document.getElementById('btnDirectImport');
  const input = document.getElementById('directImportInput');
  const origBtnText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ กำลังเปิดอ่าน...';
  }

  try {
    const parsedUrl = new URL(rawUrl);
    const domain = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');

    // รองรับลิงก์ตรงจาก MangaDex ทันที 100%
    if (domain.includes('mangadex.org')) {
      const mdResults = await searchMangaDex(rawUrl, 1);
      if (mdResults && mdResults.length > 0) {
        if (input) input.value = '';
        if (btn) {
          btn.disabled = false;
          btn.textContent = origBtnText;
        }
        openChapterModal(mdResults[0]);
        return;
      }
    }
    
    // ค้นหาว่าตรงกับ SOURCES ที่มีอยู่หรือไม่
    const matchedSource = CONFIG.SOURCES.find(s => {
      try {
        const sDomain = new URL(s.url).hostname.toLowerCase().replace(/^www\./, '');
        return domain.includes(sDomain) || sDomain.includes(domain);
      } catch (e) {
        return false;
      }
    });

    let sourceId = matchedSource ? matchedSource.id : ('ext-' + domain.replace(/[^a-z0-9]/gi, '-'));
    let sourceName = matchedSource ? matchedSource.name : domain;
    let sourceType = matchedSource ? matchedSource.type : 'mangareader';
    let sourceUrl = matchedSource ? matchedSource.url : parsedUrl.origin;

    let mangaTitle = '';
    let mangaCover = '';
    try {
      const html = await fetchViaProxy(rawUrl, {}, 10000);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      if (!matchedSource) {
        if (doc.querySelector('.wp-manga-chapter, .listing-chapters_sub-head') || html.includes('wp-manga')) {
          sourceType = 'madara';
        }
      }

      // ดึงชื่อเรื่อง
      const titleEl = doc.querySelector('h1.entry-title, h1, .post-title h1, .series-title, title');
      if (titleEl) {
        mangaTitle = titleEl.textContent.trim().replace(/\s*-\s*.*$/, '').replace(/\|.*$/, '').trim();
      }

      // ดึงภาพปก
      const coverEl = doc.querySelector('.thumb img, .summary_image img, .series-thumb img, img');
      if (coverEl) {
        mangaCover = extractCoverUrl(coverEl, sourceUrl);
      }
    } catch (e) {
      console.warn("Could not pre-fetch direct manga page:", e);
    }

    if (!mangaTitle) {
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      mangaTitle = pathParts[pathParts.length - 1] || domain;
      mangaTitle = decodeURIComponent(mangaTitle).replace(/[-_]/g, ' ');
    }

    const mangaObj = {
      title: mangaTitle,
      mangaUrl: rawUrl,
      sourceId,
      sourceName,
      sourceUrl,
      sourceType,
      readable: true,
      cover: mangaCover || '',
      type: 'Manga',
      latestEp: 'เรื่องนำเข้า'
    };

    if (input) input.value = '';
    if (btn) {
      btn.disabled = false;
      btn.textContent = origBtnText;
    }

    openChapterModal(mangaObj);
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการเปิดลิงก์: ' + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = origBtnText;
    }
  }
}

// 11. หน้าแรก Aggregator (Progressive Background Streaming)
async function initAggregatorPage() {
  const statusEl = document.getElementById('statusMsg');
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const filterTags = document.querySelectorAll('.filter-tags .tag');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const bgBadge = document.getElementById('bgLoadingBadge');
  const bgText = document.getElementById('bgLoadingText');

  // ฟังก์ชันแสดงความคืบหน้าการดึงข้อมูลเบื้องหลัง
  const updateBgProgress = (done, total) => {
    if (!bgBadge || !bgText) return;
    if (done >= total) {
      bgText.textContent = `✓ อัปเดตครบ ${total} เว็บ`;
      setTimeout(() => {
        bgBadge.style.display = 'none';
      }, 2500);
    } else {
      bgBadge.style.display = 'inline-flex';
      bgText.textContent = `ดึงข้อมูลเบื้องหลัง (${done}/${total} เว็บ)...`;
    }
  };

  // ============================================================
  // 1. ปลดล็อกปุ่มและ Event Listener ทั้งหมดทันทีใน 0.01 วินาที (Instant UI Unlock)
  // ให้ผู้ใช้สามารถกดคลิกแท็บ "🕒 ประวัติ" หรือ "⭐ เรื่องโปรด" ได้ทันที ไม่ต้องรอเครือข่ายภายนอกแม้แต่เสี้ยววิ
  // ============================================================
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    let searchDebounceTimer = null;

    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.trim();
      if (clearSearchBtn) clearSearchBtn.style.display = currentSearchQuery ? 'block' : 'none';

      // แสดงปุ่มค้นหาคลังใหญ่ข้ามเว็บเมื่อพิมพ์ตั้งแต่ 2 ตัวอักษรขึ้นไป
      const globalSearchBanner = document.getElementById('globalSearchBanner');
      const globalSearchBtnText = document.getElementById('globalSearchBtnText');
      if (globalSearchBanner) {
        if (currentSearchQuery.length >= 2) {
          globalSearchBanner.style.display = 'block';
          if (globalSearchBtnText) {
            globalSearchBtnText.textContent = `ค้นหา "${currentSearchQuery}" ในคลังใหญ่ของทุกเว็บ (หาเรื่องเก่า/จบแล้ว) ➔`;
          }
        } else {
          globalSearchBanner.style.display = 'none';
        }
      }

      applyFilters();

      // ระบบค้นหา MangaDex อัตโนมัติเบื้องหลังแบบ Debounce (400ms)
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      if (currentSearchQuery.length >= 2) {
        const queryToSearch = currentSearchQuery;
        searchDebounceTimer = setTimeout(async () => {
          if (currentSearchQuery !== queryToSearch) return;
          // ถ้ามี URL, รหัส UUID หรือคำภาษาอังกฤษ ให้ค้นใน MangaDex อัตโนมัติทันที
          if (queryToSearch.includes('mangadex.org') || /[a-f0-9]{8}-[a-f0-9]{4}/i.test(queryToSearch) || /[a-zA-Z]/.test(queryToSearch)) {
            try {
              const mdResults = await searchMangaDex(queryToSearch, 20);
              if (Array.isArray(mdResults) && mdResults.length > 0) {
                mdResults.forEach(item => {
                  item._searchQuery = queryToSearch.toLowerCase();
                  if (item.lang) selectedLanguages.add(item.lang);
                });
                allMangaList = mergeAndDeduplicate([...mdResults, ...allMangaList]);
                updateLanguageFilterUI();
                updateSourceCounts();
                applyFilters();
              }
            } catch (e) {}
          }
        }, 400);
      }
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (currentSearchQuery) {
          performGlobalLiveSearch(currentSearchQuery);
        }
      }
    });
  }

  if (clearSearchBtn && !clearSearchBtn.dataset.bound) {
    clearSearchBtn.dataset.bound = "1";
    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      currentSearchQuery = '';
      const globalSearchBanner = document.getElementById('globalSearchBanner');
      if (globalSearchBanner) globalSearchBanner.style.display = 'none';
      applyFilters();
    });
  }

  // ผูกปุ่มค้นหาคลังใหญ่ข้ามเว็บ (Global Live Search)
  const btnGlobalSearch = document.getElementById('btnGlobalSearch');
  if (btnGlobalSearch && !btnGlobalSearch.dataset.bound) {
    btnGlobalSearch.dataset.bound = "1";
    btnGlobalSearch.addEventListener('click', () => {
      performGlobalLiveSearch(currentSearchQuery);
    });
  }

  // ผูกระบบนำเข้าลิงก์ตรงจากเว็บอื่น (Direct URL Import)
  const btnDirectImport = document.getElementById('btnDirectImport');
  const directImportInput = document.getElementById('directImportInput');
  if (btnDirectImport && !btnDirectImport.dataset.bound) {
    btnDirectImport.dataset.bound = "1";
    btnDirectImport.addEventListener('click', () => {
      if (directImportInput) importMangaByDirectUrl(directImportInput.value);
    });
  }
  if (directImportInput && !directImportInput.dataset.bound) {
    directImportInput.dataset.bound = "1";
    directImportInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        importMangaByDirectUrl(directImportInput.value);
      }
    });
  }

  // ผูกแท็บหมวดหมู่, ประวัติ, เรื่องโปรด (คลิกแล้วตอบสนองทันที 0 วินาที!)
  filterTags.forEach(btn => {
    if (!btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener('click', () => {
        filterTags.forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        currentTagFilter = btn.getAttribute('data-filter') || 'all';
        applyFilters();
      });
    }
  });

  // ผูกตัวกรองภาษาย่อย (Language Sub-Filter: ไทย / อังกฤษ)
  setupLanguageFilter();

  // ผูกปุ่มโหลดเรื่องเพิ่มเติม
  if (loadMoreBtn && !loadMoreBtn.dataset.bound) {
    loadMoreBtn.dataset.bound = "1";
    loadMoreBtn.addEventListener('click', async () => {
      if (currentTagFilter === 'history' || currentTagFilter === 'favorites') {
        currentDisplayCount += 40;
        renderMangaCards();
        return;
      }
      if (currentDisplayCount < filteredList.length) {
        currentDisplayCount += 40;
        renderMangaCards();
      } else {
        loadedPagesPerSource++;
        loadMoreBtn.disabled = true;
        loadMoreBtn.querySelector('span').textContent = 'กำลังโหลดมังงะเพิ่ม...';
        const newBatch = await fetchMangaBatch(loadedPagesPerSource);
        allMangaList = mergeAndDeduplicate([...allMangaList, ...newBatch]);
        try {
          sessionStorage.setItem('cached_all_manga', JSON.stringify(allMangaList));
        } catch (e) {}
        applyFilters();
        loadMoreBtn.disabled = false;
        loadMoreBtn.querySelector('span').textContent = 'โหลดเรื่องเพิ่มเติม';
      }
    });
  }

  // ผูกปุ่มล้างประวัติทั้งหมด
  const btnClearAllHistory = document.getElementById('btnClearAllHistory');
  if (btnClearAllHistory && !btnClearAllHistory.dataset.bound) {
    btnClearAllHistory.dataset.bound = "1";
    btnClearAllHistory.onclick = clearAllHistory;
  }

  // ผูกปุ่มล้างเรื่องโปรดทั้งหมด
  const btnClearAllFavorites = document.getElementById('btnClearAllFavorites');
  if (btnClearAllFavorites && !btnClearAllFavorites.dataset.bound) {
    btnClearAllFavorites.dataset.bound = "1";
    btnClearAllFavorites.onclick = clearAllFavorites;
  }

  // สร้างแท็บแหล่งเว็บและอัปเดตตัวเลข
  renderSourceTabs();
  initSourceBarToggle();
  updateHistoryAndFavCounts();

  // เริ่มต้นระบบ Private Sync Key ข้ามอุปกรณ์
  initSyncEngine();

  // เริ่มต้นระบบแชทส่วนกลางหน้าแรก
  initChatComponent(null);

  // คืนค่าหน้าต่างเลือกตอนเมื่อกลับมาจาก reader (?restore=1)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('restore') === '1') {
    restoreActiveModal();
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch (e) {}
  }

  // ============================================================
  // 2. ตรวจสอบแคชในเครื่อง หากมีข้อมูลอยู่แล้ว ให้แสดงทันทีใน 0 วินาที
  // ============================================================
  let hasRenderedFromCache = false;
  try {
    const cached = sessionStorage.getItem('cached_all_manga');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        allMangaList = parsed;
        filteredList = [...allMangaList];
        setupHeroSpotlight(allMangaList);
        renderMangaCards();
        if (statusEl) statusEl.style.display = 'none';
        hasRenderedFromCache = true;
      }
    }
  } catch (e) {}

  if (!hasRenderedFromCache && statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = `<div class="spinner"></div>กำลังรวบรวมเรื่องอัปเดตล่าสุดจาก ${CONFIG.SOURCES.length} เว็บชั้นนำ...`;
  }

  // ============================================================
  // 3. ปรับระบบรอหน้าแรกเหลือ 1 วินาที แล้วปล่อยโหลดเบื้องหลัง (1s Fast-Release)
  // Timeout สูงสุดคงไว้ 15 วินาทีเท่าเดิมในเบื้องหลัง เพื่อให้ดึงข้อมูลได้ครบถ้วน
  // ============================================================
  let isUiInitialized = hasRenderedFromCache;
  let completedSources = 0;
  const totalSources = CONFIG.SOURCES.length;
  const loadedSourceMap = new Map();
  updateBgProgress(completedSources, totalSources);

  let notifyFirstSourceReady = null;
  const firstSourceReadyPromise = new Promise(resolve => {
    notifyFirstSourceReady = resolve;
  });

  const fetchPromises = CONFIG.SOURCES.map(async (source) => {
    try {
      const items = await fetchSingleSource(source, 1, 15000); // 15 วิในเบื้องหลัง
      completedSources++;
      updateBgProgress(completedSources, totalSources);

      if (items && items.length > 0) {
        loadedSourceMap.set(source.id, items);

        // นำทุกเว็บที่ดึงเสร็จแล้วมาสลับไขว้แบบ Round-Robin
        const interleaved = interleaveSources(Array.from(loadedSourceMap.values()));
        allMangaList = mergeAndDeduplicate(interleaved);

        if (notifyFirstSourceReady) {
          notifyFirstSourceReady();
          notifyFirstSourceReady = null;
        }

        if (!isUiInitialized) {
          isUiInitialized = true;
          if (statusEl) statusEl.style.display = 'none';
          setupHeroSpotlight(allMangaList);
          applyFilters();
        } else {
          updateSourceCounts();
          updateSourceHealthUi();
          // ถ้ากำลังดูหน้า 'all' และยังไม่ได้เลื่อนจอลงไปลึก ให้อัปเดตการ์ดต่อเนื่อง
          if (currentTagFilter === 'all' && currentSourceFilter === 'all' && !currentSearchQuery && window.scrollY < 400) {
            applyFilters();
          }
        }

        try {
          sessionStorage.setItem('cached_all_manga', JSON.stringify(allMangaList));
        } catch (e) {}
      } else {
        updateSourceHealthUi();
      }
      return items;
    } catch (e) {
      completedSources++;
      updateBgProgress(completedSources, totalSources);
      updateSourceHealthUi();
      return [];
    }
  });

  // รอสูงสุด 1 วินาที หรือจนกว่าเว็บแรกจะตอบกลับ เพื่อปลด Spinner และเปิดหน้าแรกให้เร็วที่สุด
  await Promise.race([
    firstSourceReadyPromise,
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);

  // ปลดล็อกหน้าจอทันทีเมื่อครบ 1 วินาที
  if (statusEl) statusEl.style.display = 'none';
  if (!isUiInitialized && allMangaList.length > 0) {
    isUiInitialized = true;
    setupHeroSpotlight(allMangaList);
    applyFilters();
  }

  // ปล่อยให้ทุกเว็บที่เหลือทำงานในเบื้องหลังต่อไปอย่างเงียบๆ โดยไม่บล็อกผู้ใช้
  Promise.allSettled(fetchPromises).then(() => {
    updateBgProgress(totalSources, totalSources);
    if (loadedSourceMap.size > 0) {
      const finalInterleaved = interleaveSources(Array.from(loadedSourceMap.values()));
      allMangaList = mergeAndDeduplicate(finalInterleaved);
      try {
        sessionStorage.setItem('cached_all_manga', JSON.stringify(allMangaList));
      } catch (e) {}
      updateSourceCounts();
      updateSourceHealthUi();
      if (currentTagFilter === 'all' && currentSourceFilter === 'all' && !currentSearchQuery && window.scrollY < 400) {
        applyFilters();
      }
    }
  });
}

// ฟังก์ชันคืนค่าหน้าต่างเลือกตอน (Restore Chapter Modal) เมื่อกลับมาจากหน้า Reader
function restoreActiveModal() {
  try {
    const saved = sessionStorage.getItem('currentManga');
    const savedSource = sessionStorage.getItem('currentSource');
    if (saved) {
      const manga = JSON.parse(saved);
      const activeSource = savedSource ? JSON.parse(savedSource) : null;
      const scrollPos = sessionStorage.getItem('scrollPos');
      if (scrollPos) {
        setTimeout(() => {
          window.scrollTo({ top: parseInt(scrollPos), behavior: 'instant' });
        }, 80);
      }
      openChapterModal(manga, activeSource);
    }
  } catch (e) {
    console.warn("Cannot restore modal:", e);
  }
}

window.addEventListener('pageshow', (e) => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('restore') === '1') {
    const grid = document.getElementById('mangaGrid');
    if (grid && grid.children.length > 0) {
      restoreActiveModal();
      try {
        window.history.replaceState({}, '', window.location.pathname);
      } catch (err) {}
    }
  }
});

// Hero Spotlight
function setupHeroSpotlight(list) {
  const thaiList = list.filter(m => (m.lang || 'th') === 'th');
  const pool = thaiList.length > 0 ? thaiList : list;
  const spotlight = pool.find(m => m.cover && (m.title.includes('Solo') || m.title.includes('Nano') || m.title.includes('Magic') || m.title.includes('Lookism') || m.title.includes('Demon') || m.title.includes('Knight'))) || pool[0];
  if (!spotlight) return;

  const titleEl = document.getElementById('heroTitle');
  const backdropEl = document.getElementById('heroBackdrop');
  const posterImg = document.getElementById('heroPosterImg');
  const readBtn = document.getElementById('heroReadBtn');
  const chaptersBtn = document.getElementById('heroChaptersBtn');

  if (titleEl) titleEl.textContent = spotlight.title;
  const isMangaDex = spotlight.sourceId === 'mangadex' || (spotlight.lang && spotlight.lang !== 'th');
  const heroCover = spotlight.cover ? (isMangaDex ? spotlight.cover : getProxyUrl(spotlight.cover)) : '';
  if (backdropEl && heroCover) {
    backdropEl.style.backgroundImage = `url('${heroCover}')`;
  }
  if (posterImg && heroCover) {
    posterImg.src = heroCover;
    posterImg.alt = spotlight.title;
    posterImg.style.display = 'block';
    posterImg.onclick = () => openChapterModal(spotlight);
    posterImg.style.cursor = 'pointer';
  }

  if (chaptersBtn) chaptersBtn.onclick = () => openChapterModal(spotlight);
  if (readBtn) readBtn.onclick = (e) => { e.preventDefault(); openChapterModal(spotlight); };
}

// Helper แสดง Badge ภาษา
function renderLangBadge(lang) {
  switch (lang) {
    case 'en': return '<span class="manga-lang-badge lang-en">🇬🇧 EN</span>';
    case 'ja': return '<span class="manga-lang-badge lang-ja">🇯🇵 JA</span>';
    case 'ko': return '<span class="manga-lang-badge lang-ko">🇰🇷 KO</span>';
    default: return '<span class="manga-lang-badge lang-th">🇹🇭 TH</span>';
  }
}

// Render การ์ดมังงะ
function renderMangaCards() {
  const grid = document.getElementById('mangaGrid');
  const mangaCountEl = document.getElementById('mangaCount');
  const loadMoreBtn = document.getElementById('loadMoreBtn');

  grid.innerHTML = '';
  const slice = filteredList.slice(0, currentDisplayCount);

  if (mangaCountEl) {
    let modeText = 'ทุกเว็บ';
    if (currentTagFilter === 'history') {
      modeText = 'ประวัติอ่านล่าสุด';
    } else if (currentTagFilter === 'favorites') {
      modeText = 'เรื่องโปรดของคุณ';
    } else if (currentSourceFilter !== 'all') {
      const allSrc = [...CONFIG.SOURCES, CONFIG.MANGADEX].filter(Boolean);
      modeText = allSrc.find(s => s.id === currentSourceFilter)?.name || '';
    }
    mangaCountEl.textContent = `พบ ${filteredList.length} เรื่อง [${modeText}] (แสดง ${slice.length})`;
  }

  if (slice.length === 0) {
    if (currentTagFilter === 'history') {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #888;">
          <div style="font-size: 2.5rem; margin-bottom: 10px;">🕒</div>
          <h3 style="color:#fff; font-size: 1.15rem;">ยังไม่มีประวัติการเข้าอ่าน</h3>
          <p style="margin-top: 6px; font-size: 0.88rem; color: #aaa;">เมื่อคุณคลิกเข้าไปอ่านมังงะเรื่องใดก็ตาม ระบบจะบันทึกมาไว้ที่นี่ให้อัตโนมัติทันที</p>
        </div>
      `;
    } else if (currentTagFilter === 'favorites') {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #888;">
          <div style="font-size: 2.5rem; margin-bottom: 10px;">⭐</div>
          <h3 style="color:#fff; font-size: 1.15rem;">ยังไม่มีรายการเรื่องโปรด</h3>
          <p style="margin-top: 6px; font-size: 0.88rem; color: #aaa;">กดที่ไอคอนรูปดาว ⭐ บนการ์ดเรื่องที่ชอบเพื่อปักหมุดบันทึกไว้ที่นี่</p>
        </div>
      `;
    } else {
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 50px; color: #888;">ไม่พบมังงะในหมวดนี้</div>';
    }
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    return;
  }

  const isHistoryView = currentTagFilter === 'history';
  const isFavView = currentTagFilter === 'favorites';

  slice.forEach(m => {
    const card = document.createElement('div');
    card.className = 'manga-card';
    if (m.mangaUrl) card.dataset.url = m.mangaUrl;
    if (m.title) card.dataset.title = m.title;

    // กู้คืนภาพปกอัตโนมัติหากปกเดิมว่าง
    if (!m.cover && allMangaList && allMangaList.length > 0) {
      const match = allMangaList.find(am => am.title === m.title || getMangaTitleKeys(am.title).some(k => getMangaTitleKeys(m.title).includes(k)));
      if (match && match.cover) {
        m.cover = match.cover;
      }
    }
    if (!m.cover && m.altSources && m.altSources.length > 0) {
      const altWithCover = m.altSources.find(a => a.cover);
      if (altWithCover) m.cover = altWithCover.cover;
    }

    const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='280' viewBox='0 0 200 280'%3E%3Cdefs%3E%3ClinearGradient id='bg' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23161821'/%3E%3Cstop offset='100%25' stop-color='%231f2330'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='200' height='280' rx='8' fill='url(%23bg)'/%3E%3Ctext x='50%25' y='46%25' fill='%23555b70' font-size='36' text-anchor='middle' dominant-baseline='middle'%3E📖%3C/text%3E%3Ctext x='50%25' y='64%25' fill='%23666d85' font-family='sans-serif' font-size='12' font-weight='bold' text-anchor='middle'%3ECleanManga%3C/text%3E%3C/svg%3E";
    const isMangaDex = m.sourceId === 'mangadex' || (m.lang && m.lang !== 'th');
    const coverUrl = m.cover ? (isMangaDex ? m.cover : getProxyUrl(m.cover)) : placeholder;
    const isFav = isFavorite(m.title);

    let historyBadgeHtml = '';
    if (isHistoryView && m.lastChapterTitle) {
      historyBadgeHtml = `
        <div style="margin-top: 6px;">
          <span class="history-read-badge">📖 อ่านถึง: ${m.lastChapterTitle}</span>
          ${m.updatedAt ? `<div class="history-time-text">🕒 ${formatTimeAgo(m.updatedAt)}</div>` : ''}
        </div>
      `;
    }

    let displayEp = (m.latestEp || '').trim();
    if (!displayEp || displayEp === 'ตอนที่' || /อัปเดต\s*202\d|อัพเดต\s*202\d|\b202\d-\d{2}-\d{2}\b/i.test(displayEp)) {
      displayEp = m.lastChapterTitle || 'ตอนล่าสุด';
    }
    const epNumLatest = extractEpNumberFromText(displayEp);
    const epNumRead = extractEpNumberFromText(m.lastChapterTitle);
    if (epNumRead > epNumLatest && epNumRead > 0) {
      displayEp = `ตอนที่ ${epNumRead}`;
    }

    card.innerHTML = `
      <div class="manga-cover">
        <div class="manga-badge-group">
          <span class="manga-badge">${m.type || 'Manga'}</span>
          ${renderLangBadge(m.lang)}
        </div>
        ${isHistoryView ? `
          <button class="btn-card-remove-hist" title="ลบเรื่องนี้ออกจากประวัติ" data-target="${encodeURIComponent(m.mangaUrl || m.title)}">
            ✕
          </button>
        ` : (isFavView ? `
          <button class="btn-card-remove-fav" title="ลบเรื่องนี้ออกจากเรื่องโปรด" data-target="${encodeURIComponent(m.mangaUrl || m.title)}">
            ✕
          </button>
        ` : `
          <a href="${m.mangaUrl}" target="_blank" class="manga-card-ext" title="เปิดดูเรื่องนี้ที่เว็บต้นทาง (${m.sourceName})" onclick="event.stopPropagation();">
            ↗
          </a>
        `)}
        <button class="btn-card-fav ${isFav ? 'active' : ''}" data-title="${encodeURIComponent(m.title)}" title="${isFav ? 'นำออกจากเรื่องโปรด' : 'บันทึกเป็นเรื่องโปรด'}">
          ${isFav ? '★' : '⭐'}
        </button>
        <img src="${coverUrl}" alt="${m.title}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${placeholder}';">
        <span class="manga-source-pill">${m.sourceName}</span>
      </div>
      <div class="manga-info">
        <div class="manga-title" title="${m.title}">${m.title}</div>
        <div class="manga-latest">
          <span class="manga-latest-ep">${displayEp || 'อ่านต่อ'}</span>
          <span style="font-size: 0.75rem; color: #888;">อ่าน →</span>
        </div>
        ${historyBadgeHtml}
      </div>
    `;

    // คลิกปุ่มดาวเรื่องโปรด
    const favBtn = card.querySelector('.btn-card-fav');
    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(m);
      });
    }

    // คลิกปุ่มลบออกจากประวัติ
    const removeHistBtn = card.querySelector('.btn-card-remove-hist');
    if (removeHistBtn) {
      removeHistBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistoryItem(m);
      });
    }

    // คลิกปุ่มลบออกจากเรื่องโปรด
    const removeFavBtn = card.querySelector('.btn-card-remove-fav');
    if (removeFavBtn) {
      removeFavBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFavoriteItem(m);
      });
    }

    // หากภาพปกยังไม่มี ให้ดึงจากเว็บต้นทางในพื้นหลังและบันทึกซ่อมแซมลงฐานข้อมูลประวัติ
    if (!m.cover && m.mangaUrl) {
      fetchViaProxy(m.mangaUrl, {}, 6000).then(html => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const coverEl = doc.querySelector('.thumb img, .summary_image img, .series-thumb img, .post-thumbnail img, img[class*="wp-post-image"]');
        if (coverEl) {
          const foundCover = extractCoverUrl(coverEl, m.sourceUrl || m.mangaUrl);
          if (foundCover) {
            m.cover = foundCover;
            const cardImg = card.querySelector('.manga-cover img');
            if (cardImg) cardImg.src = getProxyUrl(foundCover);
            try {
              let hist = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]');
              const hItem = hist.find(h => h.title === m.title || h.mangaUrl === m.mangaUrl);
              if (hItem) {
                hItem.cover = foundCover;
                localStorage.setItem(STORAGE_HISTORY, JSON.stringify(hist));
              }
            } catch (e) {}
          }
        }
      }).catch(() => {});
    }

    card.addEventListener('click', () => openChapterModal(m));
    grid.appendChild(card);
  });

  if (loadMoreBtn) {
    loadMoreBtn.style.display = (currentTagFilter === 'history' || currentTagFilter === 'favorites') ? 'none' : 'inline-flex';
  }
}

// ฟังก์ชันจัดเรียงตอนทั้งหมด: "ตอนล่าสุดอยู่บนสุด และตอนที่ 1 อยู่ล่างสุดเสมอ" (Numeric Descending)
function sortChaptersDescending(chapters) {
  if (!Array.isArray(chapters) || chapters.length <= 1) return chapters;

  const getEpNum = (c) => {
    if (!c) return -1;
    if (typeof c.num === 'number' && !isNaN(c.num) && c.num >= 0) {
      return c.num;
    }
    const t = c.title || '';
    const u = decodeURIComponent(c.url || '');

    // 1. ตรวจสอบ "ตอนที่ XX", "Ch. XX", "Ep. XX"
    const mt = t.match(/ตอนที่\s*(\d+(?:\.\d+)?)/i) ||
               t.match(/ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)/i) ||
               t.match(/ep(?:isode)?\.?\s*(\d+(?:\.\d+)?)/i);
    if (mt) return parseFloat(mt[1]);

    // 2. ตรวจสอบจาก URL เช่น ตอนที่-52, chapter-52, -52/, /52
    const mu = u.match(/ตอนที่[-_ ]*(\d+(?:\.\d+)?)/i) ||
               u.match(/chapter[-_ ]*(\d+(?:\.\d+)?)/i) ||
               u.match(/\/(\d+(?:\.\d+)?)\/?$/) ||
               u.match(/-(\d+(?:\.\d+)?)\/?$/);
    if (mu) return parseFloat(mu[1]);

    // 3. บทนำ หรือ Prologue ให้เป็น 0 เพื่ออยู่ล่างสุดใต้ตอนที่ 1
    if (/บทนำ|prologue/i.test(t) || /prologue/i.test(u)) return 0;
    if (/ตอนพิเศษ|special/i.test(t)) {
      const spMatch = t.match(/\d+/);
      return spMatch ? 9000 + parseFloat(spMatch[0]) : 9000;
    }

    // 4. ตัวเลขโดดๆ ในชื่อตอน
    const numOnly = t.match(/\b(\d+(?:\.\d+)?)\b/);
    if (numOnly) return parseFloat(numOnly[1]);

    return -1;
  };

  const withNums = chapters.map((c, idx) => ({
    c,
    idx,
    num: getEpNum(c)
  }));

  const valid = withNums.filter(x => x.num >= 0);
  if (valid.length >= chapters.length * 0.3) {
    withNums.sort((a, b) => {
      if (a.num >= 0 && b.num >= 0) {
        if (b.num !== a.num) return b.num - a.num; // เลขมาก (ตอนล่าสุด) อยู่บน, เลขน้อย (ตอนที่ 1) อยู่ล่างสุด
        return a.idx - b.idx;
      }
      if (a.num >= 0) return -1;
      if (b.num >= 0) return 1;
      return a.idx - b.idx;
    });
    return withNums.map(x => x.c);
  }

  // Fallback: ถ้าตัวแรกน้อยกว่าตัวท้าย (เช่น ต้นทางเรียงตอนที่ 1 มาไว้บน) ให้กลับด้านเพื่อเอาตอนที่ 1 ไว้ล่างสุด
  const first = getEpNum(chapters[0]);
  const last = getEpNum(chapters[chapters.length - 1]);
  if (first >= 0 && last >= 0 && first < last) {
    return [...chapters].reverse();
  }

  return chapters;
}

// 12. แกะรายชื่อตอน (รองรับครบทุกระบบ พร้อมตรวจจับตอนฟรี / ติดเหรียญ)
function parseChaptersFromHtml(html, baseUrl, sourceType) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const chapters = [];
  const seenUrls = new Set();

  if (sourceType === 'readtoon') {
    const links = doc.querySelectorAll('a[href*="/content/"]');
    links.forEach(a => {
      const href = (a.getAttribute('href') || '').trim();
      if (href && href.match(/\/content\/[^/]+\/\d+/)) {
        const fullUrl = baseUrl.replace(/\/$/, '') + href;
        const numMatch = href.match(/\/content\/[^/]+\/(\d+)/);
        const epNum = numMatch ? numMatch[1] : '';
        const title = epNum ? `ตอนที่ ${epNum}` : (a.textContent.trim().replace(/\s+/g, ' ') || 'อ่านตอนนี้');
        
        const hasCoin = a.innerHTML.includes('coin') || a.innerHTML.includes('เหรียญ') || a.querySelector('svg, img[src*="coin"]');
        const badge = hasCoin ? '🔒 เหรียญ' : '🔒 ติดเหรียญ';

        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          chapters.push({
            title,
            url: fullUrl,
            num: epNum ? parseFloat(epNum) : undefined,
            isLocked: true,
            badge: badge,
            sourceType: 'readtoon'
          });
        }
      }
    });
  } else if (sourceType === 'whytoon') {
    const links = doc.querySelectorAll('a[href*="/content/"]');
    links.forEach(a => {
      const href = (a.getAttribute('href') || '').trim();
      if (href && href.match(/\/content\/[^/]+\/\d+/)) {
        const fullUrl = baseUrl.replace(/\/$/, '') + href;
        const numMatch = href.match(/\/content\/[^/]+\/(\d+)/);
        const epNum = numMatch ? numMatch[1] : '';
        const title = epNum ? `ตอนที่ ${epNum}` : (a.textContent.trim().replace(/\s+/g, ' ') || 'อ่านตอนนี้');
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          chapters.push({
            title,
            url: fullUrl,
            num: epNum ? parseFloat(epNum) : undefined,
            isLocked: false,
            badge: '✨ ฟรี',
            sourceType: 'whytoon'
          });
        }
      }
    });
  } else if (sourceType === 'ntrnaja') {
    // ดึงเฉพาะลิงก์ตอนใน .ss-chlist หรือ .ss-ch เพื่อไม่ให้ไปโดนปุ่ม header/hero (ss-btn)
    let links = doc.querySelectorAll('.ss-chlist .ss-ch a, ul.ss-chlist a, .ss-ch a');
    if (!links || links.length === 0) {
      links = doc.querySelectorAll('a[href*="?chapter="]:not(.ss-btn):not(.ss-btn--primary), a[href*="/-"]:not(.ss-btn):not(.ss-btn--primary)');
    }
    links.forEach(a => {
      let href = (a.getAttribute('href') || '').trim();
      if (!href || href.includes('auth-login') || href.includes('/page/')) return;
      if (href.startsWith('/')) href = baseUrl.replace(/\/$/, '') + href;

      const chItem = a.closest('.ss-ch') || a.parentElement;
      const titleEl = a.querySelector('.ss-ch-title') || (chItem ? chItem.querySelector('.ss-ch-title') : null);
      const subEl = a.querySelector('.ss-ch-sub') || (chItem ? chItem.querySelector('.ss-ch-sub') : null);
      const subText = subEl ? subEl.textContent.trim() : '';
      const rawText = a.textContent.trim().replace(/\s+/g, ' ');

      const matchEp = (titleEl ? titleEl.textContent : rawText).match(/ตอนที่\s*(\d+(?:\.\d+)?)/i) || 
                      href.match(/chapter=-?(\d+(?:\.\d+)?)/i) || 
                      href.match(/-(\d+(?:\.\d+)?)\/?$/);
      const epTitle = matchEp ? `ตอนที่ ${matchEp[1]}` : (titleEl ? titleEl.textContent.trim() : (rawText.split('\n')[0] || 'อ่านตอนนี้'));

      const coinEl = a.querySelector('.ss-coin') || (chItem ? chItem.querySelector('.ss-coin') : null);
      const isCoinText = !!coinEl || rawText.includes('ล็อค') || rawText.includes('แต้ม') || rawText.includes('พอยท์') || subText.includes('ล็อค') || subText.includes('แต้ม') || subText.includes('พอยท์');
      const isExplicitFree = (rawText.includes('ฟรี') || subText.includes('ฟรี')) && !coinEl && !subText.includes('แต้ม') && !subText.includes('ล็อค');

      let badge = '🔒 ติดเหรียญ';
      let isLocked = true;

      if (coinEl && coinEl.textContent.trim()) {
        badge = `🔒 ${coinEl.textContent.trim()}`;
      } else if (subText.match(/(\d+\s*(?:แต้ม|พอยท์))/)) {
        badge = `🔒 ${subText.match(/(\d+\s*(?:แต้ม|พอยท์))/)[1]}`;
      } else if (rawText.match(/(\d+\s*(?:แต้ม|พอยท์))/)) {
        badge = `🔒 ${rawText.match(/(\d+\s*(?:แต้ม|พอยท์))/)[1]}`;
      } else if (isExplicitFree || !isCoinText) {
        badge = '✨ ฟรี';
        isLocked = false;
      }

      if (!seenUrls.has(href)) {
        seenUrls.add(href);
        chapters.push({
          title: epTitle,
          url: href,
          num: matchEp ? parseFloat(matchEp[1]) : undefined,
          isLocked: isLocked,
          badge: badge,
          sourceType: 'ntrnaja'
        });
      }
    });
  } else if (sourceType === 'madara') {
    const links = doc.querySelectorAll('.wp-manga-chapter a, li.wp-manga-chapter a');
    links.forEach(a => {
      let url = (a.getAttribute('href') || '').trim();
      if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.includes('/genre') || url.includes('/tag') || url.includes('/author')) {
        return;
      }

      const aClone = a.cloneNode(true);
      aClone.querySelectorAll('.chapter-release-date, .date, .time, time, i').forEach(el => el.remove());
      let rawTitle = aClone.textContent.trim().replace(/\s+/g, ' ');
      rawTitle = rawTitle.replace(/(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{1,2},?\s+\d{4}/gi, '').trim();
      rawTitle = rawTitle.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi, '').trim();

      if (url.startsWith('//')) {
        url = 'https:' + url;
      } else if (url.startsWith('/')) {
        url = baseUrl.replace(/\/$/, '') + url;
      } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = baseUrl.replace(/\/$/, '') + '/' + url;
      }

      let title = rawTitle;
      const numMatch = rawTitle.match(/ตอนที่\s*(\d+(\.\d+)?)/i) || rawTitle.match(/ch\.\s*(\d+(\.\d+)?)/i) || url.match(/ตอนที่-(\d+(\.\d+)?)/i) || url.match(/chapter-(\d+(\.\d+)?)/i);
      if (numMatch && !title.includes('ตอนที่')) {
        title = `ตอนที่ ${numMatch[1]}`;
      }

      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        chapters.push({
          title: title || 'อ่านตอนนี้',
          url,
          num: numMatch ? parseFloat(numMatch[1]) : undefined,
          isLocked: false,
          badge: '✨ ฟรี',
          sourceType: 'madara'
        });
      }
    });
  } else if (sourceType === 'mangatown') {
    const links = doc.querySelectorAll('.chapter_content .chapter_list li a, ul.chapter_list li a');
    links.forEach(a => {
      let url = (a.getAttribute('href') || '').trim();
      if (!url) return;
      if (url.startsWith('/')) url = 'https://www.mangatown.com' + url;
      let title = a.textContent.trim().replace(/\s+/g, ' ');
      const matchNum = url.match(/\/c(\d+(?:\.\d+)?)\/?/i) || title.match(/(\d+(?:\.\d+)?)/);
      const epNum = matchNum ? parseFloat(matchNum[1]) : undefined;
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        chapters.push({
          title,
          url,
          num: epNum,
          isLocked: false,
          badge: '✨ ฟรี (EN)',
          sourceType: 'mangatown'
        });
      }
    });
  } else if (sourceType === 'asurascans') {
    const links = doc.querySelectorAll('a[href*="/chapter/"], a[href*="/chapters/"]');
    links.forEach(a => {
      let url = (a.getAttribute('href') || '').trim();
      if (!url) return;
      if (url.startsWith('/')) url = 'https://asurascans.com' + url;
      let title = a.textContent.trim().replace(/\s+/g, ' ');
      const matchNum = url.match(/\/chapter\/(\d+(?:\.\d+)?)\/?/i) || title.match(/(\d+(?:\.\d+)?)/);
      const epNum = matchNum ? parseFloat(matchNum[1]) : undefined;
      const displayTitle = epNum ? `Chapter ${epNum}` : (title || 'Read Chapter');
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        chapters.push({
          title: displayTitle,
          url,
          num: epNum,
          isLocked: false,
          badge: '✨ ฟรี (EN)',
          sourceType: 'asurascans'
        });
      }
    });
  } else {
    // MangaReader (Go, Fin, Dark, Up, Slow, NTR-Manga, Ped-Manga, MangaStep, Ecchi, Speed)
    doc.querySelectorAll('#series-history, #series-history-tpl, [id*="history"]').forEach(el => el.remove());

    const links = doc.querySelectorAll('.eph-num a, .clstyle li a, #chapterlist li a, .bxcl ul li a, .chlist li a, .ntr-upd-ep');
    links.forEach(a => {
      let url = (a.getAttribute('href') || '').trim();

      if (!url || url.startsWith('#') || url.includes('{{') || url.includes('}}') || url.startsWith('javascript:')) {
        return;
      }

      // กรอง URL ที่ไม่ใช่ตอนการ์ตูน
      if (url.includes('/page/') || url.includes('/genre') || url.includes('/tag') || url.includes('/author') || url.includes('/feed') || url.includes('wp-admin')) {
        return;
      }

      const aClone = a.cloneNode(true);
      aClone.querySelectorAll('.chapterdate, .date, .time, time, i').forEach(el => el.remove());
      const numSpan = aClone.querySelector('.chapternum');
      let rawTitle = (numSpan ? numSpan.textContent : aClone.textContent).trim().replace(/\s+/g, ' ');
      rawTitle = rawTitle.replace(/(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{1,2},?\s+\d{4}/gi, '').trim();
      rawTitle = rawTitle.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi, '').trim();

      const liParent = a.closest('li');
      const dataNum = liParent ? liParent.getAttribute('data-num') : null;

      if (url.startsWith('//')) {
        url = 'https:' + url;
      } else if (url.startsWith('/')) {
        url = baseUrl.replace(/\/$/, '') + url;
      } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = baseUrl.replace(/\/$/, '') + '/' + url;
      }

      let title = rawTitle;
      const numMatch = rawTitle.match(/ตอนที่\s*(\d+(\.\d+)?)/i) ||
                       rawTitle.match(/ch\.\s*(\d+(\.\d+)?)/i) ||
                       url.match(/chapter-(\d+(\.\d+)?)/i) ||
                       url.match(/-(\d+(\.\d+)?)\/?$/) ||
                       url.match(/\/(\d+(\.\d+)?)-[a-z0-9]/i) ||
                       (dataNum ? [null, dataNum] : null);

      if (numMatch && !title.includes('ตอนที่')) {
        title = `ตอนที่ ${numMatch[1]}`;
      }

      const parsedNum = dataNum ? parseFloat(dataNum) : (numMatch ? parseFloat(numMatch[1]) : undefined);

      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        chapters.push({
          title: title || 'อ่านตอนนี้',
          url,
          num: parsedNum,
          isLocked: false,
          badge: '✨ ฟรี',
          sourceType: 'mangareader'
        });
      }
    });
  }

  return sortChaptersDescending(chapters);
}

// 13. Modal รายชื่อตอน พร้อมระบบสลับเว็บอ่าน (Source Switcher), แจ้งเตือนสลับอ่านฟรี และเชื่อมโยงเว็บ
async function openChapterModal(manga, activeSource = null) {
  const modal = document.getElementById('chapterModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalSource = document.getElementById('modalSource');
  const modalSourceBtn = document.getElementById('modalSourceBtn');
  const chapterList = document.getElementById('chapterList');
  const sourceSelector = document.getElementById('modalSourceSelector');
  const sourcePills = document.getElementById('modalSourcePills');
  const freeBanner = document.getElementById('freeSourceBanner');
  const customLinkBox = document.getElementById('customLinkBox');
  const customLinkInput = document.getElementById('customLinkInput');
  const btnApplyCustomLink = document.getElementById('btnApplyCustomLink');

  // ตรวจสอบและดึง Alias อัตโนมัติ (เช่น ผมแต่งงานกับมังกรที่ผมเคยฆ่า <-> WhyToon)
  const currentKeys = getMangaTitleKeys(manga.title);
  const aliasMatch = KNOWN_MANGA_ALIASES.find(a => 
    a.keys.some(ak => currentKeys.includes(ak)) || a.sources.some(s => s.mangaUrl === manga.mangaUrl)
  );
  if (aliasMatch) {
    if (!manga.altSources) manga.altSources = [];
    aliasMatch.sources.forEach(src => {
      if (src.mangaUrl !== manga.mangaUrl && !manga.altSources.some(a => a.sourceId === src.sourceId)) {
        manga.altSources.push({ ...src });
      }
    });
  }

  // ดึงลิงก์กำหนดเองที่ผู้ใช้เคยบันทึกไว้ใน localStorage
  try {
    const savedCustom = JSON.parse(localStorage.getItem('custom_manga_sources') || '{}');
    const matchedCustom = savedCustom[manga.title] || savedCustom[currentKeys[0]];
    if (matchedCustom && Array.isArray(matchedCustom)) {
      if (!manga.altSources) manga.altSources = [];
      matchedCustom.forEach(c => {
        if (!manga.altSources.some(a => a.mangaUrl === c.mangaUrl)) {
          manga.altSources.push(c);
        }
      });
    }
  } catch (e) {}

  // ดึงแหล่งที่เคยค้นพบและบันทึกไว้ใน localStorage ตามคีย์ชื่อเรื่อง
  try {
    currentKeys.forEach(k => {
      const savedSrcs = JSON.parse(localStorage.getItem('manga_alts_' + k) || '[]');
      if (Array.isArray(savedSrcs)) {
        if (!manga.altSources) manga.altSources = [];
        savedSrcs.forEach(s => {
          if (s && s.sourceId && s.sourceId !== manga.sourceId && !manga.altSources.some(a => a.sourceId === s.sourceId || a.mangaUrl === s.mangaUrl)) {
            manga.altSources.push(s);
          }
        });
      }
    });
  } catch (e) {}

  // ตรวจสอบใน allMangaList เผื่อมีเรื่องเดียวกันจากเว็บอื่นที่เพิ่งโหลดมา
  allMangaList.forEach(other => {
    if (other.mangaUrl !== manga.mangaUrl) {
      const otherKeys = getMangaTitleKeys(other.title);
      const isMatch = currentKeys.some(k => otherKeys.includes(k));
      if (isMatch) {
        if (!manga.altSources) manga.altSources = [];
        if (!manga.altSources.some(a => a.sourceId === other.sourceId)) {
          manga.altSources.push({
            title: other.title,
            mangaUrl: other.mangaUrl,
            sourceId: other.sourceId,
            sourceName: other.sourceName,
            sourceUrl: other.sourceUrl,
            sourceType: other.sourceType,
            readable: other.readable !== false,
            isCoin: !!other.isCoin,
            icon: other.icon
          });
        }
      }
    }
  });

  // แหล่งที่กำลังเลือกดู (หากไม่ได้ระบุ ให้เลือกเว็บฟรีที่มีจำนวนตอนมากที่สุดขึ้นนำเสมอ! ยกเว้นถ้าเรื่องนี้มาจาก MangaDex หรือเป็นภาษาต่างประเทศ ให้เปิดตามแหล่งนั้นตรงๆ)
  let currentSource = activeSource;
  if (!currentSource) {
    if (manga.sourceId === 'mangadex' || (manga.lang && manga.lang !== 'th')) {
      currentSource = manga;
    } else {
      const allCandidates = [manga, ...(manga.altSources || [])];
      allCandidates.sort((a, b) => {
        const aFree = a.readable !== false ? 1 : 0;
        const bFree = b.readable !== false ? 1 : 0;
        if (bFree !== aFree) return bFree - aFree; // เอาเว็บฟรีก่อน

        const aEp = extractEpNumberFromText(a.latestEp);
        const bEp = extractEpNumberFromText(b.latestEp);
        if (bEp !== aEp) return bEp - aEp; // เอาเว็บที่มีตอนมากที่สุดก่อน

        return 0;
      });
      currentSource = allCandidates[0] || manga;
    }
  }

  // บันทึกข้อมูลมังงะและแหล่งที่เลือก เพื่อจำไว้เวลา Back กลับมา
  try {
    sessionStorage.setItem('currentManga', JSON.stringify(manga));
    sessionStorage.setItem('currentSource', JSON.stringify(currentSource));
    if (!window.location.pathname.includes('reader.html')) {
      sessionStorage.setItem('scrollPos', String(window.scrollY));
    }
  } catch (e) {}

  if (modalTitle) modalTitle.textContent = manga.title;

  const isCurrentFree = currentSource.readable !== false;
  if (modalSource) {
    modalSource.textContent = `แหล่ง: ${currentSource.sourceName} ${isCurrentFree ? '(ฟรี 100%)' : '(ติดเหรียญ/ต้นทาง)'}`;
  }
  if (modalSourceBtn) {
    modalSourceBtn.href = currentSource.mangaUrl;
    modalSourceBtn.textContent = `🌐 เปิดดูที่ ${currentSource.sourceName} ↗`;
  }

  // ผูกปุ่มดาวเรื่องโปรดใน Modal
  updateModalFavButton(manga);
  const btnModalFav = document.getElementById('btnModalFav');
  if (btnModalFav) {
    btnModalFav.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(manga);
    };
  }

  // ตรวจสอบ URL ตอนปัจจุบันหากเปิด Modal จาก reader.html
  let currentReadingChapterUrl = null;
  try {
    const sp = new URLSearchParams(window.location.search);
    currentReadingChapterUrl = sp.get('url');
  } catch (e) {}

  // ตรวจสอบประวัติการอ่านค้างไว้สำหรับเรื่องนี้ (Continue Reading)
  const historyList = getReadingHistory();
  const histItem = historyList.find(h => {
    if (h.title === manga.title || h.mangaUrl === manga.mangaUrl) return true;
    const hKeys = getMangaTitleKeys(h.title);
    return currentKeys.some(k => hKeys.includes(k));
  });

  const continueBox = document.getElementById('continueReadingBox');
  if (continueBox) {
    const isAlreadyOnThisChapter = currentReadingChapterUrl && histItem && (histItem.lastChapterUrl === currentReadingChapterUrl);
    if (histItem && histItem.lastChapterUrl && (histItem.lastChapterTitle || histItem.lastChapterUrl) && !isAlreadyOnThisChapter) {
      continueBox.style.display = 'flex';
      const q = new URLSearchParams();
      q.set('url', histItem.lastChapterUrl);
      q.set('title', manga.title + ' - ' + (histItem.lastChapterTitle || 'ตอนล่าสุด'));
      q.set('source', currentSource.sourceUrl);
      q.set('mangaUrl', currentSource.mangaUrl);
      q.set('mangaTitle', manga.title);
      q.set('sourceId', currentSource.sourceId || '');
      q.set('sourceName', currentSource.sourceName);
      q.set('sourceType', currentSource.sourceType);

      // ดึงชื่อตอนที่กระชับ ชัดเจน ไม่เอาชื่อเรื่องมาบัง ไม่ยาวล้นจอ
      let cleanEpTitle = (histItem.lastChapterTitle || '').trim();
      if (manga.title && cleanEpTitle.includes(manga.title)) {
        cleanEpTitle = cleanEpTitle.split(manga.title).join('').replace(/^[- :]+/, '').trim();
      }
      cleanEpTitle = cleanEpTitle.replace(/(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{1,2},?\s+\d{4}/gi, '').trim();
      cleanEpTitle = cleanEpTitle.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi, '').trim();

      if (!cleanEpTitle || !/\d/.test(cleanEpTitle)) {
        const decodedUrl = decodeURIComponent(histItem.lastChapterUrl || '');
        const m = decodedUrl.match(/ตอนที่[-_ ]*(\d+(?:\.\d+)?)/i) ||
                  decodedUrl.match(/ch(?:apter)?[-_ ]*(\d+(?:\.\d+)?)/i) ||
                  decodedUrl.match(/\/(\d+(?:\.\d+)?)\/?$/) ||
                  decodedUrl.match(/-(\d+(?:\.\d+)?)\/?$/);
        if (m) {
          cleanEpTitle = `ตอนที่ ${m[1]}`;
        } else {
          cleanEpTitle = cleanEpTitle || 'ตอนล่าสุด';
        }
      }

      continueBox.innerHTML = `
        <div class="continue-reading-text">
          <div class="continue-main-row">
            <span class="continue-label">📖 อ่านค้างไว้:</span>
            <strong class="continue-ep-badge">${cleanEpTitle}</strong>
          </div>
          <span class="continue-time-text">(${formatTimeAgo(histItem.updatedAt)})</span>
        </div>
        <a href="reader.html?${q.toString()}" class="btn-continue-now">อ่านต่อ ⚡</a>
      `;
    } else {
      continueBox.style.display = 'none';
    }
  }

  // ซ่อน Custom Link Box ก่อน
  if (customLinkBox) customLinkBox.style.display = 'none';

  // ตรวจสอบว่ามีแหล่งฟรีให้สลับอ่านหรือไม่ เมื่อกำลังเปิดดูเว็บที่ติดเหรียญ
  if (freeBanner) {
    const freeSource = (manga.altSources || []).find(s => s.readable !== false);
    if (!isCurrentFree && freeSource) {
      freeBanner.style.display = 'flex';
      freeBanner.innerHTML = `
        <div class="free-source-banner-text">
          <span style="font-size: 1.1rem;">💡</span>
          <span>เรื่องนี้มีให้อ่านฟรี 100% ที่ <strong>${freeSource.sourceName}</strong> (อ่านฟรีไม่ต้องใช้เหรียญ)</span>
        </div>
        <button class="btn-switch-free" id="btnSwitchToFree">สลับไปอ่านฟรีทันที ⚡</button>
      `;
      const btn = document.getElementById('btnSwitchToFree');
      if (btn) {
        btn.onclick = () => openChapterModal(manga, freeSource);
      }
    } else {
      freeBanner.style.display = 'none';
    }
  }

  // สร้างแถบสลับเว็บต้นทาง (Source Switcher Pills)
  if (sourceSelector && sourcePills) {
    const allSources = [];
    const seenSources = new Set();

    // รวมแหล่งหลักและแหล่งสำรองที่เจอ
    [manga, ...(manga.altSources || [])].forEach(s => {
      if (s && s.sourceId && !seenSources.has(s.sourceId)) {
        seenSources.add(s.sourceId);
        allSources.push(s);
      }
    });

    // บันทึกแหล่งที่พบทั้งหมดลง localStorage ตามคีย์ชื่อเรื่อง เพื่อให้เปิดจากที่ไหนก็มีเว็บอื่นครบถ้วน
    try {
      currentKeys.forEach(k => {
        localStorage.setItem('manga_alts_' + k, JSON.stringify(allSources));
      });
    } catch (e) {}

    sourceSelector.style.display = 'flex';
    sourcePills.innerHTML = '';

    // เรียงลำดับแถบปุ่ม: แหล่งที่กำลังเปิดดูอยู่หน้าสุดเสมอ จากนั้นเว็บภาษาไทยก่อน + เว็บฟรีก่อน + จำนวนตอนมากที่สุด
    allSources.sort((a, b) => {
      if (currentSource && currentSource.sourceId) {
        if (a.sourceId === currentSource.sourceId) return -1;
        if (b.sourceId === currentSource.sourceId) return 1;
      }

      const aTh = (a.lang || 'th') === 'th' ? 1 : 0;
      const bTh = (b.lang || 'th') === 'th' ? 1 : 0;
      if (bTh !== aTh) return bTh - aTh;

      const aFree = a.readable !== false ? 1 : 0;
      const bFree = b.readable !== false ? 1 : 0;
      if (bFree !== aFree) return bFree - aFree;

      const aEp = extractEpNumberFromText(a.latestEp);
      const bEp = extractEpNumberFromText(b.latestEp);
      if (bEp !== aEp) return bEp - aEp;

      return 0;
    });

    allSources.forEach(s => {
      const isFree = s.readable !== false;
      const isSelected = s.sourceId === currentSource.sourceId;
      const pill = document.createElement('button');
      pill.className = `modal-source-pill ${isSelected ? 'active' : ''} ${!isFree ? 'locked' : ''}`;
      const epNum = extractEpNumberFromText(s.latestEp);
      const epLabel = epNum > 0 ? ` (${epNum} ตอน)` : (s.latestEp ? ` (${s.latestEp})` : '');
      pill.innerHTML = `
        <span>${s.icon || (isFree ? '⚡' : '🔒')}</span>
        <span>${s.sourceName}${epLabel}</span>
        <span class="source-pill-badge ${isFree ? 'free' : 'coin'}">${isFree ? 'ฟรี' : '🔒 ติดเหรียญ'}</span>
      `;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        openChapterModal(manga, s);
      });
      sourcePills.appendChild(pill);

      // ตรวจสอบและดึงข้อมูลเลขตอนล่าสุดสำหรับแหล่งที่ยังไม่มี เช่น NTRnaja
      if (s.sourceId === 'ntrnaja' && (!s.latestEp || extractEpNumberFromText(s.latestEp) === 0) && s.mangaUrl) {
        fetchViaProxy(s.mangaUrl, {}, 6000).then(sourceHtml => {
          const m = sourceHtml.match(/class="ss-ch-title">\s*ตอนที่\s*(\d+(?:\.\d+)?)/i) || sourceHtml.match(/chapter=-?(\d+(?:\.\d+)?)/i);
          if (m) {
            s.latestEp = `ตอนที่ ${m[1]}`;
            const hasCoin = sourceHtml.includes('class="ss-coin"') || sourceHtml.includes('ล็อค');
            s.isCoin = hasCoin;
            s.readable = !hasCoin;
            const updatedEpNum = parseFloat(m[1]);
            const updatedLabel = ` (${updatedEpNum} ตอน)`;
            const nameEl = pill.querySelector('span:nth-child(2)');
            if (nameEl) nameEl.textContent = `${s.sourceName}${updatedLabel}`;
            const badgeEl = pill.querySelector('.source-pill-badge');
            if (badgeEl) {
              badgeEl.className = `source-pill-badge ${s.readable ? 'free' : 'coin'}`;
              badgeEl.textContent = s.readable ? 'ฟรี' : '🔒 ติดเหรียญ';
            }
          }
        }).catch(() => {});
      }
    });

    // ปุ่มเพิ่มแหล่งเชื่อมโยงด้วยตนเอง (+ วางลิงก์)
    const addBtn = document.createElement('button');
    addBtn.className = 'modal-source-pill add-source';
    addBtn.innerHTML = `<span>➕</span><span>เชื่อมโยงเว็บอื่น</span>`;
    addBtn.title = 'วางลิงก์เรื่องนี้จากเว็บอื่น เช่น WhyToon เพื่อรวมเข้าด้วยกัน';
    addBtn.onclick = (e) => {
      e.stopPropagation();
      if (customLinkBox) {
        customLinkBox.style.display = customLinkBox.style.display === 'none' ? 'flex' : 'none';
        if (customLinkInput) customLinkInput.focus();
      }
    };
    sourcePills.appendChild(addBtn);

    // ผูกเหตุการณ์ปุ่มเชื่อมโยง
    if (btnApplyCustomLink && customLinkInput) {
      btnApplyCustomLink.onclick = () => {
        const url = customLinkInput.value.trim();
        if (!url) return;

        let srcId = 'other';
        let srcName = 'เว็บอื่น';
        let icon = '🌐';
        let srcType = 'mangareader';
        let isReadable = true;

        if (url.includes('whytoon.com')) {
          srcId = 'whytoon';
          srcName = 'WhyToon';
          icon = '📱';
          srcType = 'whytoon';
        } else if (url.includes('slow-manga')) {
          srcId = 'slow-manga';
          srcName = 'Slow-Manga';
          icon = '🐢';
        } else if (url.includes('ntr-manga')) {
          srcId = 'ntr-manga';
          srcName = 'NTR-Manga';
          icon = '🔥';
        } else if (url.includes('ped-manga')) {
          srcId = 'ped-manga';
          srcName = 'Ped-Manga';
          icon = '🦆';
        } else if (url.includes('mangastep')) {
          srcId = 'manga-step';
          srcName = 'MangaStep';
          icon = '🐾';
        } else if (url.includes('go-manga')) {
          srcId = 'go-manga';
          srcName = 'Go-Manga';
          icon = '⚡';
        } else if (url.includes('ntrnaja')) {
          srcId = 'ntrnaja';
          srcName = 'NTRnaja';
          icon = '🔒';
          srcType = 'ntrnaja';
          isReadable = false;
        } else if (url.includes('readtoon')) {
          srcId = 'readtoon';
          srcName = 'ReadToon';
          icon = '🔒';
          srcType = 'readtoon';
          isReadable = false;
        }

        const newSrc = {
          title: manga.title,
          mangaUrl: url,
          sourceId: srcId,
          sourceName: srcName,
          sourceUrl: new URL(url).origin,
          sourceType: srcType,
          readable: isReadable,
          isCoin: !isReadable,
          icon: icon
        };

        if (!manga.altSources) manga.altSources = [];
        manga.altSources.push(newSrc);

        // บันทึกลง localStorage
        try {
          const store = JSON.parse(localStorage.getItem('custom_manga_sources') || '{}');
          if (!store[manga.title]) store[manga.title] = [];
          store[manga.title].push(newSrc);
          localStorage.setItem('custom_manga_sources', JSON.stringify(store));
        } catch (e) {}

        customLinkInput.value = '';
        openChapterModal(manga, newSrc);
      };
    }
  }

  const initScrollControls = document.getElementById('modalScrollControls');
  if (initScrollControls) initScrollControls.style.display = 'none';

  if (chapterList) chapterList.innerHTML = `<div class="spinner"></div>กำลังโหลดรายชื่อตอนจาก ${currentSource.sourceName}...`;
  if (modal) modal.style.display = 'flex';

  try {
    let chapters = [];
    if (currentSource.sourceType === 'mangadex') {
      const mangaId = currentSource.mangaId || (currentSource.mangaUrl.match(/title\/([a-f0-9-]+)/i) || [])[1];
      const targetLang = currentSource.lang || (selectedLanguages.has('en') ? 'en' : (selectedLanguages.has('ja') ? 'ja' : (selectedLanguages.has('ko') ? 'ko' : '')));
      chapters = await fetchMangaDexChapters(mangaId, targetLang);
    } else {
      let html = await fetchViaProxy(currentSource.mangaUrl);
      chapters = parseChaptersFromHtml(html, currentSource.sourceUrl, currentSource.sourceType);

      // สำหรับเว็บตระกูล Madara (เช่น Du-Manga) หากหน้าแรกไม่ได้ใส่รายการตอน ให้ดึงผ่าน AJAX Endpoint ทันที
      if (currentSource.sourceType === 'madara' && chapters.length === 0) {
        try {
          const ajaxUrl = currentSource.mangaUrl.replace(/\/$/, '') + '/ajax/chapters/';
          const ajaxHtml = await fetchViaProxy(ajaxUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'action=manga_get_chapters'
          });
          if (ajaxHtml) {
            const ajaxChapters = parseChaptersFromHtml(ajaxHtml, currentSource.sourceUrl, currentSource.sourceType);
            if (ajaxChapters.length > 0) {
              chapters = ajaxChapters;
            }
          }
        } catch (errAjax) {
          console.warn("Madara ajax chapters fetch:", errAjax);
        }
      }
    }

    if (!chapterList) return;

    if (chapters.length === 0) {
      if (!currentSource.isCoin && sourceHealthStatus[currentSource.sourceId]) {
        sourceHealthStatus[currentSource.sourceId] = { ok: false, error: 'ไม่พบรายการตอน' };
        updateSourceHealthUi();
      }

      chapterList.innerHTML = `
        <div style="text-align: center; padding: 24px 16px; background: rgba(255,68,68,0.06); border-radius: 12px; border: 1px solid rgba(255,68,68,0.3); margin: 10px 0;">
          <div style="font-size: 2rem; margin-bottom: 8px;">🔴</div>
          <h4 style="color: #ff7777; margin-bottom: 6px; font-size: 1rem;">เว็บ ${currentSource.sourceName} ขัดข้องหรือใช้งานไม่ได้ชั่วคราว</h4>
          <p style="color:#aaa; margin-bottom:14px; font-size: 0.88rem;">
            ${isCurrentFree ? 'ต้นทางอาจปิดปรับปรุง หรือไม่สามารถดึงรายการตอนได้ คุณสามารถเปิดดูผ่านเว็บต้นทางโดยตรงได้' : `เว็บ ${currentSource.sourceName} ใช้ระบบเหรียญหรือระบบรักษาความปลอดภัย`}
          </p>
          <a href="${currentSource.mangaUrl}" target="_blank" class="btn-primary" style="padding: 10px 20px; display: inline-flex; align-items: center; gap: 8px;">
            🌐 เปิดอ่านที่ ${currentSource.sourceName} ↗
          </a>
        </div>
      `;
      return;
    }

    const readUrls = new Set((histItem && Array.isArray(histItem.readChapters)) ? histItem.readChapters : []);

    chapters = sortChaptersDescending(chapters);
    if (chapters.length > 0) {
      currentSource.latestEp = chapters[0].title;
      if (currentSource.sourceId === 'ntrnaja' && currentSource.mangaUrl) {
        saveNtrChapterCache(currentSource.mangaUrl, chapters[0].title);
        updateCardLatestEpInDom(currentSource.mangaUrl, manga.title, chapters[0].title);
      }
      if (chapters[0].isLocked) {
        currentSource.isCoin = true;
        currentSource.readable = false;
      } else {
        currentSource.isCoin = false;
        currentSource.readable = true;
      }
    }
    try {
      if (currentSource && currentSource.mangaUrl) {
        sessionStorage.setItem('cached_chapters_' + currentSource.mangaUrl, JSON.stringify(chapters));
      }
      if (manga && manga.title) {
        sessionStorage.setItem('cached_chapters_title_' + manga.title, JSON.stringify(chapters));
      }
    } catch (e) {}
    chapterList.innerHTML = '';
    chapters.forEach(c => {
      const isRead = readUrls.has(c.url);
      const isCurrent = currentReadingChapterUrl && (c.url === currentReadingChapterUrl);
      const a = document.createElement('a');
      a.className = `chapter-item ${c.isLocked ? 'locked' : ''} ${isRead ? 'is-read' : ''} ${isCurrent ? 'current-chapter' : ''}`;

      const currentBadgeHtml = isCurrent ? '<span class="chapter-current-badge">กำลังอ่าน 📍</span>' : '';
      const readBadgeHtml = (!isCurrent && isRead) ? '<span class="chapter-read-badge">✓ อ่านแล้ว</span>' : '';

      if (c.isLocked || (c.isExternal && c.url.startsWith('http'))) {
        // ตอนติดเหรียญหรือตอนเว็บภายนอก: เปิดอ่านที่เว็บต้นทางโดยตรง
        a.href = c.url;
        a.target = '_blank';
        a.innerHTML = `
          <div class="chapter-title-group">
            <span class="chapter-badge-coin">${c.badge || (c.isExternal ? '↗ เว็บนอก' : '🔒 ติดเหรียญ')}</span>
            <span class="chapter-title-text">${c.title}</span>
            ${currentBadgeHtml}
            ${readBadgeHtml}
          </div>
          <span class="chapter-action-link">เปิดต้นทาง ↗</span>
        `;
      } else {
        // ตอนฟรี: เปิดอ่านด้วย Vertical Reader
        const finalCover = manga.cover || currentSource.cover || '';
        const q = new URLSearchParams();
        q.set('url', c.url);
        q.set('title', manga.title + ' - ' + c.title);
        q.set('source', currentSource.sourceUrl);
        q.set('mangaUrl', currentSource.mangaUrl);
        q.set('mangaTitle', manga.title);
        if (finalCover) q.set('cover', finalCover);
        q.set('sourceId', currentSource.sourceId || '');
        q.set('sourceName', currentSource.sourceName);
        q.set('sourceType', currentSource.sourceType);
        const resolvedLang = c.lang || currentSource.lang || manga.lang || (currentSource.sourceId === 'mangadex' ? 'en' : 'th');
        q.set('lang', resolvedLang);

        a.href = `reader.html?${q.toString()}`;
        a.innerHTML = `
          <div class="chapter-title-group">
            <span class="chapter-badge-free">${c.badge || '✨ ฟรี'}</span>
            <span class="chapter-title-text">${c.title}</span>
            ${currentBadgeHtml}
            ${readBadgeHtml}
          </div>
          <span class="chapter-action-link">${isCurrent ? 'ตอนนี้' : (isRead ? 'อ่านซ้ำ ↺' : 'อ่านเลย →')}</span>
        `;
      }

      // บันทึกประวัติการอ่านทันทีที่คลิกตอน (ไม่ว่าจะอ่านในเว็บหรือเปิดแท็บต้นทาง)
      a.addEventListener('click', () => {
        const finalCover = manga.cover || currentSource.cover || '';
        const mangaForHist = {
          ...manga,
          cover: finalCover,
          mangaUrl: currentSource.mangaUrl || manga.mangaUrl,
          sourceId: currentSource.sourceId || manga.sourceId,
          sourceName: currentSource.sourceName || manga.sourceName,
          sourceUrl: currentSource.sourceUrl || manga.sourceUrl,
          sourceType: currentSource.sourceType || manga.sourceType,
          lang: c.lang || currentSource.lang || manga.lang || (currentSource.sourceId === 'mangadex' ? 'en' : 'th')
        };
        recordReadingHistory(mangaForHist, c.title, c.url);
      });

      chapterList.appendChild(a);
    });

    // จัดการปุ่มลูกศรวาร์ปเลื่อนตอน (⬇️ ตอนที่ 1 / ⬆️ ตอนล่าสุด)
    const modalBody = modal ? modal.querySelector('.modal-body') : null;
    const scrollControls = document.getElementById('modalScrollControls');
    const btnScrollTop = document.getElementById('btnModalScrollTop');
    const btnScrollBottom = document.getElementById('btnModalScrollBottom');

    if (modalBody && scrollControls && btnScrollTop && btnScrollBottom) {
      if (chapters.length > 8) {
        scrollControls.style.display = 'flex';

        btnScrollBottom.onclick = (e) => {
          if (e) e.stopPropagation();
          modalBody.scrollTo({
            top: modalBody.scrollHeight,
            behavior: (chapters.length > 300) ? 'auto' : 'smooth'
          });
        };

        btnScrollTop.onclick = (e) => {
          if (e) e.stopPropagation();
          modalBody.scrollTo({
            top: 0,
            behavior: (chapters.length > 300) ? 'auto' : 'smooth'
          });
        };

        const handleModalScroll = () => {
          const st = modalBody.scrollTop;
          const maxScroll = modalBody.scrollHeight - modalBody.clientHeight;
          if (maxScroll <= 40) {
            scrollControls.style.display = 'none';
            return;
          }
          scrollControls.style.display = 'flex';
          btnScrollTop.style.display = (st > 120) ? 'inline-flex' : 'none';
          btnScrollBottom.style.display = (st < maxScroll - 120) ? 'inline-flex' : 'none';
        };

        modalBody.onscroll = handleModalScroll;
        // เรียกอัปเดตสถานะปุ่มรอบแรก
        setTimeout(handleModalScroll, 50);
      } else {
        scrollControls.style.display = 'none';
        modalBody.onscroll = null;
      }
    }

    if (currentReadingChapterUrl) {
      setTimeout(() => {
        const cur = chapterList.querySelector('.chapter-item.current-chapter');
        if (cur) {
          cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 100);
    }
  } catch (err) {
    if (chapterList) {
      chapterList.innerHTML = `
        <div style="text-align: center; padding: 24px 16px;">
          <p style="color:#ff5555; margin-bottom: 12px;">ไม่สามารถโหลดตอนได้: ${err.message}</p>
          <a href="${currentSource.mangaUrl}" target="_blank" class="btn-modal-source">🌐 เปิดอ่านที่เว็บ ${currentSource.sourceName} ↗</a>
        </div>
      `;
    }
  }
}

function closeChapterModal() {
  const modal = document.getElementById('chapterModal');
  if (modal) modal.style.display = 'none';
  const scrollControls = document.getElementById('modalScrollControls');
  if (scrollControls) scrollControls.style.display = 'none';
  if (!window.location.pathname.includes('reader.html')) {
    try {
      sessionStorage.removeItem('currentManga');
      sessionStorage.removeItem('scrollPos');
    } catch (e) {}
  }
}

// ฟังก์ชันทำความสะอาด URL นำทาง ป้องกันลิงก์พัง เช่น #/next/, #/prev/, javascript:
function cleanChapterNavUrl(rawUrl, currentUrl = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed === '#' ||
    trimmed === '/' ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('javascript:') ||
    trimmed.toLowerCase().includes('void(0)')
  ) {
    return '';
  }

  if (trimmed.startsWith('mangadex://')) {
    return trimmed;
  }

  let finalUrl = trimmed;
  if (finalUrl.startsWith('//')) {
    finalUrl = 'https:' + finalUrl;
  } else if (finalUrl.startsWith('/') && currentUrl) {
    try {
      finalUrl = new URL(finalUrl, currentUrl).href;
    } catch (e) {
      return '';
    }
  }

  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
    return '';
  }

  return finalUrl;
}

// 14. หน้า Reader (อ่านการ์ตูน)
function parseReaderData(html, currentUrl = '') {
  // ตรวจจับ Script ที่เซ็ตปุ่ม ตอนก่อนหน้า / ตอนต่อไป ผ่าน jQuery (พบบ่อยในตระกูล MangaReader และ NTR-Manga)
  let scriptNextUrl = '';
  let scriptPrevUrl = '';

  const jqNext = html.match(/(?:jQuery|\$)\(["']a\.ch-next-btn["']\)[^;]*?attr\(["']href["'],\s*["']([^"']+)["']\)/i);
  if (jqNext && jqNext[1]) {
    scriptNextUrl = cleanChapterNavUrl(jqNext[1], currentUrl);
  }

  const jqPrev = html.match(/(?:jQuery|\$)\(["']a\.ch-prev-btn["']\)[^;]*?attr\(["']href["'],\s*["']([^"']+)["']\)/i);
  if (jqPrev && jqPrev[1]) {
    scriptPrevUrl = cleanChapterNavUrl(jqPrev[1], currentUrl);
  }

  // 1. ลองหา ts_reader.run (Go, Fin, Dark, Up, Slow, NTR-Manga, Ecchi)
  const match = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
  if (match) {
    try {
      const readerJson = JSON.parse(match[1]);
      const rawImages = readerJson.sources?.[0]?.images || [];
      return {
        prevUrl: cleanChapterNavUrl(readerJson.prevUrl, currentUrl) || scriptPrevUrl,
        nextUrl: cleanChapterNavUrl(readerJson.nextUrl, currentUrl) || scriptNextUrl,
        images: rawImages.map(imgUrl => getProxyUrl(imgUrl, currentUrl || 'https://ped-manga.com/'))
      };
    } catch (e) {
      console.warn("Failed to parse ts_reader JSON:", e);
    }
  }

  // 2. ตรวจสอบ WhyToon (Next.js App Router Webtoon)
  const whytoonMatches = [...html.matchAll(/content\/[a-zA-Z0-9_\-]+\/\d+\/[a-f0-9\-]+\.webp/g)];
  if (whytoonMatches.length > 0) {
    const uniquePaths = [...new Set(whytoonMatches.map(m => m[0]))];
    const prevMatch = html.match(/href="(\/content\/[^/]+\/[^"]+)"[^>]*>←/);
    const nextMatch = html.match(/href="(\/content\/[^/]+\/[^"]+)"[^>]*>[^<]*→/);
    const baseUrl = 'https://whytoon.com';
    return {
      prevUrl: prevMatch ? cleanChapterNavUrl(`${baseUrl}${prevMatch[1]}`, currentUrl) : '',
      nextUrl: nextMatch ? cleanChapterNavUrl(`${baseUrl}${nextMatch[1]}`, currentUrl) : '',
      images: uniquePaths.map(p => getProxyUrl(`https://gd.whytoon.com/${p}`))
    };
  }

  // 3. ตรวจสอบ ReadToon
  const readtoonMatches = [...html.matchAll(/content\/\d+\/[a-f0-9\-]+\.webp/g)];
  if (readtoonMatches.length > 0) {
    const uniquePaths = [...new Set(readtoonMatches.map(m => m[0]))];
    return {
      prevUrl: '',
      nextUrl: '',
      images: uniquePaths.map(p => getProxyUrl(`https://w.nobuild.pro/${p}`))
    };
  }

  // 3.5 ตรวจสอบ chapter_preloaded_images (NTRnaja และ Madara บางเว็บ)
  const preloadedMatch = html.match(/var\s+chapter_preloaded_images\s*=\s*(\[[^\]]+\])/);
  if (preloadedMatch) {
    try {
      const rawImgs = JSON.parse(preloadedMatch[1]);
      if (Array.isArray(rawImgs) && rawImgs.length > 0) {
        return {
          prevUrl: scriptPrevUrl,
          nextUrl: scriptNextUrl,
          images: rawImgs.map(u => getProxyUrl(u.replace(/\\/g, '')))
        };
      }
    } catch (e) {
      console.warn("Failed to parse chapter_preloaded_images:", e);
    }
  }

  // 3.6 ตรวจสอบ Asura Scans (Next.js/WebP chapters)
  const asuraMatches = [...html.matchAll(/https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\/[a-zA-Z0-9_\-./]+\.webp(?:\?v=\d+)?/g)];
  if (asuraMatches.length > 0) {
    const uniqueAsura = [...new Set(asuraMatches.map(m => m[0]))];
    return {
      prevUrl: '',
      nextUrl: '',
      images: uniqueAsura.map(u => getProxyUrl(u))
    };
  }

  // 3.7 ตรวจสอบ MangaTown (zjcdn sequential images)
  if (currentUrl.includes('mangatown.com') || html.includes('id="image"')) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const mtImg = doc.querySelector('img#image');
    if (mtImg) {
      let firstSrc = (mtImg.getAttribute('src') || '').trim();
      if (firstSrc.startsWith('//')) firstSrc = 'https:' + firstSrc;
      const imgs = [getProxyUrl(firstSrc, 'https://www.mangatown.com/')];

      const pageOptions = doc.querySelectorAll('.page_select option');
      const totalPages = pageOptions.length || doc.querySelectorAll('.page_select a').length || 1;

      const matchPattern = firstSrc.match(/(.*\/v)(\d+)(\.jpg.*)$/i);
      if (matchPattern && totalPages > 1) {
        const prefix = matchPattern[1];
        const numDigits = matchPattern[2].length;
        const suffix = matchPattern[3];
        for (let p = 2; p <= totalPages; p++) {
          const pStr = String(p).padStart(numDigits, '0');
          imgs.push(getProxyUrl(`${prefix}${pStr}${suffix}`, 'https://www.mangatown.com/'));
        }
      }

      return {
        prevUrl: '',
        nextUrl: '',
        images: imgs
      };
    }
  }

  // 4. ตรวจสอบเว็บตระกูล Madara (Du-Manga, Manga-LC)
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const madaraImgs = doc.querySelectorAll('.reading-content img, .page-break img, .wp-manga-chapter-img');
  if (madaraImgs.length > 0) {
    const imgs = [];
    const prevLink = doc.querySelector('.nav-previous a:not(.disabled), a.prev_page:not(.disabled), .btn.prev_page:not(.disabled)');
    const nextLink = doc.querySelector('.nav-next a:not(.disabled), a.next_page:not(.disabled), .btn.next_page:not(.disabled)');

    madaraImgs.forEach(img => {
      let src = img.getAttribute('data-src') || 
                img.getAttribute('data-lazy-src') || 
                img.getAttribute('data-original') || 
                img.getAttribute('src') || '';
      src = src.replace(/&amp;/g, '&').trim();
      
      // กรองรูปโฆษณา แบนเนอร์ หรือ placeholder ออก
      const rel = img.getAttribute('rel') || '';
      if (
        src &&
        !src.includes('data:image') &&
        !src.includes('blank.gif') &&
        !src.includes('Banner01') &&
        !src.includes('banner.png') &&
        !src.includes('manga.gif') &&
        !src.includes('paruay') &&
        !src.includes('ufabet') &&
        !src.includes('kurotoon') &&
        !src.includes('Purple-Colorful') &&
        !src.includes('Screenshot') &&
        !src.includes('cropped-') &&
        !rel.includes('nofollow')
      ) {
        if (src.startsWith('//')) src = 'https:' + src;
        imgs.push(getProxyUrl(src));
      }
    });

    if (imgs.length > 0) {
      return {
        prevUrl: scriptPrevUrl || cleanChapterNavUrl(prevLink ? prevLink.getAttribute('href') : '', currentUrl),
        nextUrl: scriptNextUrl || cleanChapterNavUrl(nextLink ? nextLink.getAttribute('href') : '', currentUrl),
        images: imgs
      };
    }
  }

  // 5. Fallback สำหรับเว็บทั่วไปที่ดึงจากแท็ก img ในเนื้อหา
  const fallbackPrevLink = doc.querySelector('.nav-previous a:not(.disabled), a.prev_page:not(.disabled), .ch-prev-btn:not(.disabled), .nextprev .prev:not(.disabled)');
  const fallbackNextLink = doc.querySelector('.nav-next a:not(.disabled), a.next_page:not(.disabled), .ch-next-btn:not(.disabled), .nextprev .next:not(.disabled)');
  const imgEls = doc.querySelectorAll('#readerarea img, .readerarea img, .entry-content img, #ch-images img, .read-container img');
  const imgs = [];
  imgEls.forEach(img => {
    let src = img.getAttribute('data-wpfc-original-src') || 
              img.getAttribute('data-src') || 
              img.getAttribute('data-lazy-src') || 
              img.getAttribute('data-original') || 
              img.getAttribute('data-orig-file') ||
              img.getAttribute('data-cfsrc') ||
              img.getAttribute('src') || '';
    src = src.replace(/&amp;/g, '&').trim();
    if (src && !src.includes('data:image') && !src.includes('blank.gif')) {
      if (src.startsWith('//')) src = 'https:' + src;
      imgs.push(getProxyUrl(src));
    }
  });

  return {
    prevUrl: scriptPrevUrl || cleanChapterNavUrl(fallbackPrevLink ? fallbackPrevLink.getAttribute('href') : '', currentUrl),
    nextUrl: scriptNextUrl || cleanChapterNavUrl(fallbackNextLink ? fallbackNextLink.getAttribute('href') : '', currentUrl),
    images: imgs
  };
}

async function initReaderPage() {
  const params = new URLSearchParams(window.location.search);
  const chapterUrl = params.get('url');
  const title = params.get('title') || 'อ่านการ์ตูน';

  let mangaUrl = params.get('mangaUrl');
  let mangaTitle = params.get('mangaTitle');
  let mangaCover = params.get('cover');
  let sourceId = params.get('sourceId');
  let sourceName = params.get('sourceName');
  let sourceUrl = params.get('source');
  let sourceType = params.get('sourceType') || 'mangareader';

  // โหลด allMangaList จาก cache ใน sessionStorage เผื่อใช้ค้นหาเว็บอื่นเมื่อเปิดเลือกตอน
  if (!allMangaList || allMangaList.length === 0) {
    try {
      const cached = sessionStorage.getItem('cached_all_manga');
      if (cached) {
        allMangaList = JSON.parse(cached);
      }
    } catch (e) {}
  }

  let savedAltSources = [];
  try {
    const saved = sessionStorage.getItem('currentManga');
    if (saved) {
      const m = JSON.parse(saved);
      if (!mangaUrl) mangaUrl = m.mangaUrl;
      if (!mangaTitle) mangaTitle = m.title;
      if (!mangaCover && m.cover) mangaCover = m.cover;
      if (!sourceId) sourceId = m.sourceId;
      if (!sourceName) sourceName = m.sourceName;
      if (!sourceUrl) sourceUrl = m.sourceUrl;
      if (!sourceType) sourceType = m.sourceType;
      if (m.altSources && Array.isArray(m.altSources)) {
        savedAltSources = m.altSources;
      }
    }
  } catch (e) {}

  const lang = params.get('lang');
  let savedLang = '';
  try {
    const saved = sessionStorage.getItem('currentManga');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.lang) savedLang = parsed.lang;
    }
  } catch (e) {}

  const mangaObj = {
    title: mangaTitle || title.split(' - ')[0] || 'มังงะ',
    cover: mangaCover || '',
    mangaUrl: mangaUrl || '',
    sourceId: sourceId || '',
    sourceName: sourceName || 'Online',
    sourceUrl: sourceUrl || '',
    sourceType: sourceType || 'mangareader',
    lang: lang || savedLang || (sourceId === 'mangadex' ? 'en' : 'th'),
    altSources: savedAltSources
  };

  const titleEl = document.getElementById('readerTitle');
  const container = document.getElementById('readerImages');
  const statusEl = document.getElementById('statusMsg');
  const prevBtn = document.getElementById('prevChapterBtn');
  const nextBtn = document.getElementById('nextChapterBtn');
  const footerPrevBtn = document.getElementById('footerPrevBtn');
  const footerNextBtn = document.getElementById('footerNextBtn');
  const backBtn = document.getElementById('backBtn');
  const footerBackBtn = document.getElementById('footerBackBtn');
  const readerChaptersBtn = document.getElementById('readerChaptersBtn');
  const footerChaptersBtn = document.getElementById('footerChaptersBtn');
  const readerSourceBtn = document.getElementById('readerSourceBtn');
  const footerSourceBtn = document.getElementById('footerSourceBtn');

  if (titleEl) titleEl.textContent = title;

  // ตั้งค่าปุ่มเปิดดูที่เว็บต้นทาง
  let directSourceUrl = chapterUrl || mangaObj.mangaUrl || mangaObj.sourceUrl;
  if (directSourceUrl && directSourceUrl.startsWith('mangadex://')) {
    const chId = directSourceUrl.replace('mangadex://', '').split('?')[0];
    directSourceUrl = `https://mangadex.org/chapter/${chId}`;
  }
  if (readerSourceBtn && directSourceUrl) {
    readerSourceBtn.href = directSourceUrl;
    readerSourceBtn.innerHTML = `<span class="nav-icon">🌐</span> <span class="nav-label">ต้นทาง (${mangaObj.sourceName}) ↗</span>`;
    readerSourceBtn.title = `เปิดดูที่เว็บต้นทาง (${mangaObj.sourceName}) ↗`;
  }
  if (footerSourceBtn && directSourceUrl) {
    footerSourceBtn.href = directSourceUrl;
    footerSourceBtn.innerHTML = `<span class="nav-icon">🌐</span> <span class="nav-label">ต้นทาง (${mangaObj.sourceName}) ↗</span>`;
    footerSourceBtn.title = `เปิดดูที่เว็บต้นทาง (${mangaObj.sourceName}) ↗`;
  }

  // เริ่มต้นระบบแชทส่วนกลางใต้ปุ่มอ่านต่อ (พร้อมแท็กชื่อเรื่องนี้ให้อัตโนมัติ)
  initChatComponent(mangaObj);

  // เริ่มต้นระบบ Private Sync Key
  initSyncEngine();

  const goBackToChapters = (e) => {
    if (e) e.preventDefault();
    try {
      if (mangaObj && mangaObj.title) {
        sessionStorage.setItem('currentManga', JSON.stringify(mangaObj));
        sessionStorage.setItem('currentSource', JSON.stringify(mangaObj));
      }
    } catch (err) {}
    window.location.href = 'index.html?restore=1';
  };

  if (backBtn) backBtn.onclick = goBackToChapters;
  if (footerBackBtn) footerBackBtn.onclick = goBackToChapters;

  const openInReaderModal = (e) => {
    if (e) e.preventDefault();
    try {
      const saved = sessionStorage.getItem('currentManga');
      const savedSource = sessionStorage.getItem('currentSource');
      if (saved) {
        const m = JSON.parse(saved);
        const s = savedSource ? JSON.parse(savedSource) : null;
        openChapterModal(m, s);
        return;
      }
    } catch (err) {}
    if (mangaObj.mangaUrl) {
      openChapterModal(mangaObj);
    } else {
      goBackToChapters();
    }
  };

  if (readerChaptersBtn) readerChaptersBtn.onclick = openInReaderModal;
  if (footerChaptersBtn) footerChaptersBtn.onclick = openInReaderModal;

  const cleanCurrentChapterUrl = cleanChapterNavUrl(chapterUrl);
  if (!cleanCurrentChapterUrl) {
    statusEl.innerHTML = `
      <div style="max-width:500px; margin: 40px auto; padding: 28px 20px; background: rgba(255,255,255,0.04); border-radius: 16px; border: 1px solid var(--border); text-align: center; backdrop-filter: blur(10px);">
        <div style="font-size: 2.5rem; margin-bottom: 12px;">⚠️</div>
        <h3 style="font-size: 1.15rem; margin-bottom: 8px; color:#fff;">ไม่พบตอนที่ระบุ หรือถึงตอนสุดท้ายแล้ว</h3>
        <p style="color: var(--text-sub); font-size: 0.9rem; line-height: 1.6; margin-bottom: 20px;">
          ระบบตรวจพบว่าไม่มีตอนถัดไป หรือเว็บต้นทางยังไม่ได้อัปเดตตอนใหม่
        </p>
        <div style="display: flex; gap: 10px; justify-content: center;">
          <button onclick="window.location.href='index.html?restore=1'" class="btn-primary" style="padding: 10px 22px;">← กลับหน้ารายการตอน</button>
        </div>
      </div>
    `;
    return;
  }

  // ทำความสะอาดชื่อตอนและบันทึกประวัติการอ่านทันที ไม่ต้องรอรูปภาพโหลดเสร็จ
  try {
    const savedMangaRaw = sessionStorage.getItem('currentManga');
    if (savedMangaRaw) {
      const sm = JSON.parse(savedMangaRaw);
      if (!mangaObj.cover && sm.cover) mangaObj.cover = sm.cover;
      if (!mangaObj.type && sm.type) mangaObj.type = sm.type;
      if (!mangaObj.latestEp && sm.latestEp) mangaObj.latestEp = sm.latestEp;
    }
  } catch (e) {}

  const chapterEpTitle = cleanMangaChapterTitle(title, mangaObj.title, cleanCurrentChapterUrl);
  if (titleEl && mangaObj.title) {
    titleEl.textContent = `${mangaObj.title} - ${chapterEpTitle}`;
  }
  recordReadingHistory(mangaObj, chapterEpTitle, cleanCurrentChapterUrl);

  try {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<div class="spinner"></div>กำลังโหลดรูปภาพมังงะ...';

    let readerData;
    if (cleanCurrentChapterUrl.startsWith('mangadex://') || mangaObj.sourceType === 'mangadex') {
      const chId = cleanCurrentChapterUrl.replace('mangadex://', '').split('?')[0];
      readerData = await fetchMangaDexReaderImages(chId);
    } else {
      const html = await fetchViaProxy(cleanCurrentChapterUrl);
      readerData = parseReaderData(html, cleanCurrentChapterUrl);
    }

    // โหลดรายการตอนจาก cached_chapters มาเตรียมไว้สำหรับปุ่มตอนก่อนหน้า/ถัดไป
    let cachedChapters = null;
    try {
      if (mangaObj.mangaUrl) {
        const rawCached = sessionStorage.getItem('cached_chapters_' + mangaObj.mangaUrl);
        if (rawCached) cachedChapters = JSON.parse(rawCached);
      }
      if (!cachedChapters && mangaObj.title) {
        const rawCached = sessionStorage.getItem('cached_chapters_title_' + mangaObj.title);
        if (rawCached) cachedChapters = JSON.parse(rawCached);
      }
    } catch (e) {}

    // ถ้าระบบยังหา prevUrl หรือ nextUrl ไม่พบ ให้ดึงจาก cached_chapters มาคำนวณตอนถัดไป/ก่อนหน้า
    if (!readerData.prevUrl || !readerData.nextUrl) {
      if (Array.isArray(cachedChapters) && cachedChapters.length > 0) {
        const normCurrent = cleanCurrentChapterUrl.replace(/\/$/, '');
        const currentIndex = cachedChapters.findIndex(c => c.url && cleanChapterNavUrl(c.url).replace(/\/$/, '') === normCurrent);
        if (currentIndex !== -1) {
          // เนื่องจาก chapters เรียงจาก มากสุด -> น้อยสุด (1 อยู่ล่างสุด)
          // ตอนต่อไป (Next, เลขตอนมากกว่า) จะอยู่ที่ currentIndex - 1
          // ตอนก่อนหน้า (Prev, เลขตอนน้อยกว่า) จะอยู่ที่ currentIndex + 1
          if (!readerData.nextUrl && currentIndex > 0) {
            readerData.nextUrl = cleanChapterNavUrl(cachedChapters[currentIndex - 1].url);
          }
          if (!readerData.prevUrl && currentIndex < cachedChapters.length - 1) {
            readerData.prevUrl = cleanChapterNavUrl(cachedChapters[currentIndex + 1].url);
          }
        }
      }
    }

    statusEl.style.display = 'none';

    if (readerData.images.length === 0) {
      let directUrl = cleanCurrentChapterUrl;
      if (directUrl.startsWith('mangadex://')) {
        const chId = directUrl.replace('mangadex://', '').split('?')[0];
        directUrl = `https://mangadex.org/chapter/${chId}`;
      }
      statusEl.style.display = 'block';
      statusEl.innerHTML = `
        <div style="max-width:520px; margin: 40px auto; padding: 32px 24px; background: rgba(255,255,255,0.04); border-radius: 18px; border: 1px solid var(--border); text-align: center; backdrop-filter: blur(10px);">
          <div style="font-size: 2.5rem; margin-bottom: 12px;">🔒</div>
          <h3 style="font-size: 1.2rem; margin-bottom: 8px; color:#fff;">ตอนนี้อาจมีการเข้ารหัสหรือติดระบบเหรียญของต้นทาง</h3>
          <p style="color: var(--text-sub); font-size: 0.9rem; line-height: 1.6; margin-bottom: 22px;">
            เนื่องจากตอนนี้ในเว็บต้นทาง (${mangaObj.sourceName}) มีการใช้ระบบป้องกันเหรียญหรือบอท คุณสามารถกดเปิดอ่านได้โดยตรงที่เว็บต้นทาง
          </p>
          <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
            <a href="${directUrl}" target="_blank" class="btn-primary" style="padding: 11px 22px; font-size: 0.9rem;">
              เปิดอ่านที่เว็บต้นทาง ↗
            </a>
            <button onclick="window.history.back()" class="btn-secondary" style="padding: 11px 22px; font-size: 0.9rem;">
              ← เลือกตอนอื่น
            </button>
          </div>
        </div>
      `;
      return;
    }

    const setupNavButtons = (prev, next) => {
      const buildNavUrl = (targetEpUrl) => {
        const p = new URLSearchParams();
        p.set('url', targetEpUrl);
        let epStr = '';
        if (Array.isArray(cachedChapters)) {
          const foundCh = cachedChapters.find(c => c.url === targetEpUrl);
          if (foundCh && foundCh.title) epStr = foundCh.title;
        }
        if (!epStr) {
          const decodedTarget = decodeURIComponent(targetEpUrl);
          const tm = decodedTarget.match(/ตอนที่[-_ ]*(\d+(?:\.\d+)?)/i) ||
                     decodedTarget.match(/ch(?:apter)?[-_ ]*(\d+(?:\.\d+)?)/i) ||
                     decodedTarget.match(/\/(\d+(?:\.\d+)?)\/?$/) ||
                     decodedTarget.match(/-(\d+(?:\.\d+)?)\/?$/);
          epStr = tm ? `ตอนที่ ${tm[1]}` : '';
        }
        p.set('title', epStr ? `${mangaObj.title} - ${epStr}` : mangaObj.title);
        if (mangaObj.sourceUrl) p.set('source', mangaObj.sourceUrl);
        if (mangaObj.mangaUrl) p.set('mangaUrl', mangaObj.mangaUrl);
        if (mangaObj.title) p.set('mangaTitle', mangaObj.title);
        if (mangaObj.sourceId) p.set('sourceId', mangaObj.sourceId);
        if (mangaObj.sourceName) p.set('sourceName', mangaObj.sourceName);
        if (mangaObj.sourceType) p.set('sourceType', mangaObj.sourceType);
        if (mangaObj.cover) p.set('cover', mangaObj.cover);
        return `reader.html?${p.toString()}`;
      };

      const setBtn = (btn, url) => {
        if (!btn) return;
        const validUrl = cleanChapterNavUrl(url);
        if (validUrl) {
          btn.onclick = () => { window.location.href = buildNavUrl(validUrl); };
          btn.disabled = false;
        } else {
          btn.disabled = true;
          btn.onclick = null;
        }
      };
      setBtn(prevBtn, prev);
      setBtn(footerPrevBtn, prev);
      setBtn(nextBtn, next);
      setBtn(footerNextBtn, next);
    };

    setupNavButtons(readerData.prevUrl, readerData.nextUrl);

    // แสดงรูปภาพทั้งหมดพร้อมระบบ Auto-Retry เมื่อรูปโหลดสะดุด
    readerData.images.forEach((imgUrl, idx) => {
      const img = document.createElement('img');
      img.src = imgUrl;
      img.alt = `Page ${idx + 1}`;
      img.loading = idx < 4 ? 'eager' : 'lazy';
      img.referrerPolicy = 'no-referrer';

      let retried = false;
      img.onerror = function() {
        if (!retried) {
          retried = true;
          setTimeout(() => {
            this.src = imgUrl + (imgUrl.includes('?') ? '&' : '?') + 'retry=' + Date.now();
          }, 1200);
        }
      };

      container.appendChild(img);
    });

  } catch (err) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = `
      <div style="color: #ff5555; margin-bottom: 12px;">เกิดข้อผิดพลาด: ${err.message}</div>
      <div style="display:flex; gap:10px; justify-content:center;">
        <button onclick="window.location.href=\'index.html?restore=1\'" class="btn-nav">← กลับหน้ารายการตอน</button>
        <a href="${directSourceUrl}" target="_blank" class="btn-modal-source">🌐 เปิดที่เว็บต้นทาง ↗</a>
      </div>
    `;
  }
}
