// Clean Manga Reader - Mega Aggregator & Reader Engine

let allMangaList = [];          // คลังรวมมังงะทุกเรื่องจากทุกเว็บ
let filteredList = [];          // มังงะที่ผ่านการค้นหาหรือฟิลเตอร์
let currentSourceFilter = 'all';// แหล่งที่เลือก ('all' หรือ id เช่น 'go-manga', 'slow-manga')
let currentTagFilter = 'all';   // หมวดหมู่ที่เลือก ('all', 'manhwa', 'action', ...)
let currentSearchQuery = '';    // ข้อความค้นหา
let currentDisplayCount = 40;   // แสดงครั้งละ 40 เรื่อง
let loadedPagesPerSource = 1;

// ตัวช่วยสร้าง URL ผ่าน Proxy
function getProxyUrl(targetUrl) {
  if (!targetUrl) return '';
  return `${CONFIG.PROXY_URL}${encodeURIComponent(targetUrl)}`;
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

// 3. แกะข้อมูลมังงะจากเว็บตระกูล MangaReader (Go, Fin, Dark, Up, Slow, NTR-Manga, Ecchi-Doujin)
function parseMangaReaderHtml(html, sourceInfo) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const items = [];

  const cards = doc.querySelectorAll('.bsx, .animposx, .listupd .uta, .ntr-upd-card, .top10manga li');
  cards.forEach(card => {
    const linkEl = card.querySelector('a.ntr-upd-title, a.ntr-upd-cover, a');
    const titleEl = card.querySelector('.ntr-upd-title h3, .tt, h2, h3, .title');
    const imgEl = card.querySelector('img');
    const epNumEl = card.querySelector('.ntr-upd-epnum');
    const epEl = card.querySelector('.epxs, .eggchap, .fivchap, .chfiv li a, .ntr-upd-ep');
    const typeEl = card.querySelector('.typename, .type');

    if (linkEl && titleEl) {
      let mangaUrl = linkEl.getAttribute('href') || '';
      let title = titleEl.textContent.trim();
      let latestEp = 'ตอนล่าสุด';

      if (epNumEl) {
        latestEp = epNumEl.textContent.trim();
      } else if (epEl) {
        const clone = epEl.cloneNode(true);
        clone.querySelectorAll('.ntr-upd-eptime, .date, .time, time, i').forEach(t => t.remove());
        latestEp = clone.textContent.trim();
      }

      // กรองคำระบุเวลาออก เช่น "2 ชั่วโมงที่แล้ว", "3 วันที่แล้ว" เพื่อไม่ให้เลขเวลามาซ้อนทับกับเลขตอน
      latestEp = latestEp.replace(/\s*\d+\s*(?:ชั่วโมง|นาที|วัน|วินาที|ชม\.|วัน|เดือน|ปี|hours?|mins?|days?|ago)\s*(?:ที่แล้ว|ago)?/gi, '').trim() || latestEp;

      let type = typeEl ? typeEl.textContent.trim() : (sourceInfo.name.includes('Doujin') || sourceInfo.name.includes('NTR') ? '18+ / Doujin' : 'Manga');
      let cover = extractCoverUrl(imgEl, sourceInfo.url);

      if (mangaUrl.startsWith('/')) mangaUrl = sourceInfo.url + mangaUrl;

      if (title && mangaUrl) {
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
    let latestEp = metaEl ? metaEl.textContent.trim() : 'ตอนล่าสุด';

    const imgEl = card.querySelector('img.ntr-genre-thumb__img, img');
    let cover = extractCoverUrl(imgEl, sourceInfo.url);

    if (mangaUrl.startsWith('/')) mangaUrl = sourceInfo.url + mangaUrl;

    if (title) {
      items.push({
        title,
        mangaUrl,
        cover,
        latestEp,
        type: '18+ / NTR',
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

// ==========================================================
// ระบบประวัติการอ่าน (Reading History) และเรื่องโปรด (Favorites)
// ทำงานผ่าน localStorage 100% ไม่ต้องมีเซิร์ฟเวอร์ และขึ้น GitHub Pages ได้ทันที
// ==========================================================
const STORAGE_HISTORY = 'clean_manga_reading_history';
const STORAGE_FAVORITES = 'clean_manga_favorites';

// ดึงประวัติการอ่าน
function getReadingHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]');
  } catch (e) {
    return [];
  }
}

// ดึงรายการโปรด
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_FAVORITES) || '[]');
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
    if (f.title === manga.title) return true;
    const fKeys = getMangaTitleKeys(f.title);
    return keys.some(k => fKeys.includes(k));
  });

  let nowFav = false;
  if (existingIdx >= 0) {
    favs.splice(existingIdx, 1);
    nowFav = false;
  } else {
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
      savedAt: Date.now()
    });
    nowFav = true;
  }

  try {
    localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(favs));
  } catch (e) {}

  updateHistoryAndFavCounts();

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

// บันทึกประวัติการอ่านอัตโนมัติ (เรียกใช้อัตโนมัติเมื่อกดอ่านตอน)
function recordReadingHistory(manga, chapterTitle, chapterUrl) {
  if (!manga || !manga.title || !chapterUrl) return;
  try {
    let history = getReadingHistory();
    const keys = getMangaTitleKeys(manga.title);
    
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

    // สร้างหรืออัปเดตข้อมูลเรื่อง
    const item = {
      title: manga.title,
      cover: manga.cover || (existing ? existing.cover : ''),
      type: manga.type || (existing ? existing.type : 'Manga'),
      latestEp: manga.latestEp || (existing ? existing.latestEp : ''),
      mangaUrl: manga.mangaUrl || (existing ? existing.mangaUrl : ''),
      sourceId: manga.sourceId || (existing ? existing.sourceId : ''),
      sourceName: manga.sourceName || (existing ? existing.sourceName : 'Online'),
      sourceUrl: manga.sourceUrl || (existing ? existing.sourceUrl : ''),
      sourceType: manga.sourceType || (existing ? existing.sourceType : 'mangareader'),
      readable: manga.readable !== false,
      altSources: (manga.altSources && manga.altSources.length > 0) ? manga.altSources : (existing && existing.altSources ? existing.altSources : []),
      lastChapterTitle: chapterTitle || 'ตอนที่อ่านล่าสุด',
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
    if (history.length > 100) history.pop(); // เก็บประวัติสูงสุด 100 เรื่อง

    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
    updateHistoryAndFavCounts();
  } catch (e) {
    console.warn("Could not save history:", e);
  }
}

// ลบประวัติเรื่องใดเรื่องหนึ่ง
function deleteHistoryItem(itemIdentifier) {
  let history = getReadingHistory();
  history = history.filter(h => h.mangaUrl !== itemIdentifier && h.title !== itemIdentifier);
  try {
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
  } catch (e) {}
  updateHistoryAndFavCounts();
  if (currentTagFilter === 'history') {
    applyFilters();
  }
}

// ล้างประวัติทั้งหมด
function clearAllHistory() {
  if (confirm('คุณต้องการล้างประวัติการอ่านทั้งหมดในเครื่องใช่หรือไม่?')) {
    try {
      localStorage.removeItem(STORAGE_HISTORY);
    } catch (e) {}
    updateHistoryAndFavCounts();
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

// 8. รวมข้อมูลและตัดเรื่องซ้ำ (Deduplication)
// กฎเหล็ก: "เอาเว็บฟรีขึ้นก่อนเป็นหลัก" + ระบบตรวจจับชื่อเรื่องข้ามค่าย
function mergeAndDeduplicate(list) {
  const map = new Map();
  const keyToManga = new Map();

  list.forEach(m => {
    const keys = getMangaTitleKeys(m.title);
    if (keys.length === 0) return;

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

      const isNewFree = m.readable !== false;
      const isExistingFree = existing.readable !== false;

      // ถ้าเรื่องเดิมติดเหรียญ/อ่านไม่ได้ แต่เรื่องใหม่เป็นเว็บฟรี 100% -> สลับเว็บฟรีขึ้นเป็นตัวหลักทันที!
      if (!isExistingFree && isNewFree) {
        const oldAlts = existing.altSources || [];
        existing.altSources = [];
        
        const mergedAlts = [existing, ...oldAlts.filter(a => a.sourceId !== m.sourceId && a.sourceId !== existing.sourceId)];
        m.altSources = mergedAlts;

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

// 9. ดึงข้อมูลมังงะแบบ Multi-Page และจัดเรียงแบบ Latest Updates Interleaving
async function fetchMangaBatch(page = 1) {
  const promises = CONFIG.SOURCES.map(async (source) => {
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
        targetUrl = page > 1 ? `${source.url}/manga/page/${page}/` : `${source.url}/manga/`;
      } else if (source.type === 'kairew') {
        targetUrl = `${source.url}/manga`;
      }

      const html = await fetchViaProxy(targetUrl);
      let items = [];
      if (source.type === 'whytoon') {
        items = parseWhyToonHtml(html, source);
      } else if (source.type === 'readtoon') {
        items = parseReadToonHtml(html, source);
      } else if (source.type === 'ntrnaja') {
        items = parseNtrNajaHtml(html, source);
      } else if (source.type === 'kairew') {
        items = parseKairewHtml(html, source);
      } else if (source.type === 'madara') {
        items = parseMadaraHtml(html, source);
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
  });

  const results = await Promise.allSettled(promises);
  const sourceArrays = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
      sourceArrays.push(r.value);
    }
  });

  updateSourceHealthUi();

  // คืนค่าแบบสลับเว็บ เพื่อให้เรื่องล่าสุดของทุกเว็บมารวมกันที่หัวตาราง
  return interleaveSources(sourceArrays);
}

// 10. ระบบกรองข้อมูล (Filter Engine)
function applyFilters() {
  const historyToolbar = document.getElementById('historyToolbar');
  if (historyToolbar) {
    historyToolbar.style.display = currentTagFilter === 'history' ? 'flex' : 'none';
  }

  let baseList = allMangaList;
  if (currentTagFilter === 'history') {
    baseList = getReadingHistory();
  } else if (currentTagFilter === 'favorites') {
    baseList = getFavorites();
  }

  filteredList = baseList.filter(m => {
    // 1. Source filter (แยกตามเว็บต้นทาง)
    if (currentSourceFilter !== 'all') {
      const matchSource = m.sourceId === currentSourceFilter || 
                          (m.altSources && m.altSources.some(alt => alt.sourceId === currentSourceFilter));
      if (!matchSource) return false;
    }

    // 2. Tag filter (หมวดหมู่ทั่วไป)
    if (currentTagFilter !== 'all' && currentTagFilter !== 'history' && currentTagFilter !== 'favorites') {
      if (currentTagFilter === 'manhwa') {
        if (!m.type.toLowerCase().includes('manhwa') && !m.title.includes('เกาหลี')) return false;
      } else if (currentTagFilter === 'manhua') {
        if (!m.type.toLowerCase().includes('manhua') && !m.title.includes('จีน')) return false;
      } else if (currentTagFilter === 'manga') {
        if (!m.type.toLowerCase().includes('manga')) return false;
      } else if (currentTagFilter === 'romance') {
        if (!m.sourceName.includes('Fin') && !m.title.includes('รัก') && !m.title.includes('สาว') && !m.title.includes('ภรรยา')) return false;
      } else if (currentTagFilter === 'action') {
        if (!m.title.includes('เทพ') && !m.title.includes('จุติ') && !m.title.includes('เลเวล') && !m.title.includes('ดาบ') && !m.title.includes('ราชา') && !m.title.includes('ยุทธ')) return false;
      } else if (currentTagFilter === 'doujin') {
        if (!m.sourceName.includes('Ecchi') && !m.sourceName.includes('NTR') && !m.type.toLowerCase().includes('doujin') && !m.type.toLowerCase().includes('18+')) return false;
      }
    }

    // 3. Search query (ค้นหา)
    if (currentSearchQuery) {
      const q = currentSearchQuery.toLowerCase();
      const matchSearch = (m.title && m.title.toLowerCase().includes(q)) || 
                          (m.type && m.type.toLowerCase().includes(q)) || 
                          (m.latestEp && m.latestEp.toLowerCase().includes(q)) ||
                          (m.lastChapterTitle && m.lastChapterTitle.toLowerCase().includes(q)) ||
                          (m.sourceName && m.sourceName.toLowerCase().includes(q));
      if (!matchSearch) return false;
    }

    return true;
  });

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

  CONFIG.SOURCES.forEach(source => {
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
    btn.addEventListener('click', () => {
      document.querySelectorAll('.source-tag').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      currentSourceFilter = source.id;
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

  CONFIG.SOURCES.forEach(source => {
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

// 11. หน้าแรก Aggregator
async function initAggregatorPage() {
  const statusEl = document.getElementById('statusMsg');
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const filterTags = document.querySelectorAll('.filter-tags .tag');
  const loadMoreBtn = document.getElementById('loadMoreBtn');

  statusEl.style.display = 'block';
  statusEl.innerHTML = `<div class="spinner"></div>กำลังรวบรวมเรื่องอัปเดตล่าสุดจาก ${CONFIG.SOURCES.length} เว็บชั้นนำ...`;

  // ดึงหน้า 1 และหน้า 2 เพื่อให้มีเรื่องอัปเดตใหม่ๆ เยอะจุใจทันที
  const batch1 = await fetchMangaBatch(1);
  const batch2 = await fetchMangaBatch(2);

  allMangaList = mergeAndDeduplicate([...batch1, ...batch2]);
  filteredList = [...allMangaList];

  try {
    sessionStorage.setItem('cached_all_manga', JSON.stringify(allMangaList));
  } catch (e) {}

  statusEl.style.display = 'none';

  if (allMangaList.length === 0) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<p style="color:#ff5555;">ไม่สามารถโหลดข้อมูลได้ กรุณาตรวจสอบว่า local server กำลังทำงานอยู่</p>';
    return;
  }

  setupHeroSpotlight(allMangaList);
  renderSourceTabs();
  initSourceBarToggle();
  renderMangaCards();

  // Search
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.trim();
      if (clearSearchBtn) clearSearchBtn.style.display = currentSearchQuery ? 'block' : 'none';
      applyFilters();
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearSearchBtn.style.display = 'none';
      currentSearchQuery = '';
      applyFilters();
    });
  }

  // Tags
  filterTags.forEach(btn => {
    btn.addEventListener('click', () => {
      filterTags.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      currentTagFilter = btn.getAttribute('data-filter') || 'all';
      applyFilters();
    });
  });

  // Load More (ดึงหน้าถัดไปอัตโนมัติ)
  if (loadMoreBtn) {
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
  if (btnClearAllHistory) {
    btnClearAllHistory.onclick = clearAllHistory;
  }

  // อัปเดตตัวเลขประวัติและเรื่องโปรด
  updateHistoryAndFavCounts();

  // คืนค่าหน้าต่างเลือกตอนเฉพาะเมื่อผู้ใช้กดปุ่มย้อนกลับมาจากหน้าอ่าน (?restore=1) เท่านั้น
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('restore') === '1') {
    restoreActiveModal();
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch (e) {}
  }
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
  const spotlight = list.find(m => m.cover && (m.title.includes('Solo') || m.title.includes('Nano') || m.title.includes('Magic') || m.title.includes('Lookism') || m.title.includes('Demon') || m.title.includes('Knight'))) || list[0];
  if (!spotlight) return;

  const titleEl = document.getElementById('heroTitle');
  const backdropEl = document.getElementById('heroBackdrop');
  const readBtn = document.getElementById('heroReadBtn');
  const chaptersBtn = document.getElementById('heroChaptersBtn');

  if (titleEl) titleEl.textContent = spotlight.title;
  if (backdropEl && spotlight.cover) {
    backdropEl.style.backgroundImage = `url('${getProxyUrl(spotlight.cover)}')`;
  }

  if (chaptersBtn) chaptersBtn.onclick = () => openChapterModal(spotlight);
  if (readBtn) readBtn.onclick = (e) => { e.preventDefault(); openChapterModal(spotlight); };
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
      modeText = CONFIG.SOURCES.find(s => s.id === currentSourceFilter)?.name || '';
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

  slice.forEach(m => {
    const card = document.createElement('div');
    card.className = 'manga-card';

    const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='280' viewBox='0 0 200 280'%3E%3Crect width='200' height='280' fill='%23161821'/%3E%3Ctext x='50%25' y='50%25' fill='%23444' font-family='sans-serif' font-size='13' text-anchor='middle'%3ELoading...%3C/text%3E%3C/svg%3E";
    const coverUrl = m.cover ? getProxyUrl(m.cover) : placeholder;
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

    card.innerHTML = `
      <div class="manga-cover">
        <div class="manga-badge-group">
          <span class="manga-badge">${m.type || 'Manga'}</span>
        </div>
        ${isHistoryView ? `
          <button class="btn-card-remove-hist" title="ลบเรื่องนี้ออกจากประวัติ" data-target="${encodeURIComponent(m.mangaUrl || m.title)}">
            ✕
          </button>
        ` : `
          <a href="${m.mangaUrl}" target="_blank" class="manga-card-ext" title="เปิดดูเรื่องนี้ที่เว็บต้นทาง (${m.sourceName})" onclick="event.stopPropagation();">
            ↗
          </a>
        `}
        <button class="btn-card-fav ${isFav ? 'active' : ''}" data-title="${encodeURIComponent(m.title)}" title="${isFav ? 'นำออกจากเรื่องโปรด' : 'บันทึกเป็นเรื่องโปรด'}">
          ${isFav ? '★' : '⭐'}
        </button>
        <img src="${coverUrl}" alt="${m.title}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${placeholder}';">
        <span class="manga-source-pill">${m.sourceName}</span>
      </div>
      <div class="manga-info">
        <div class="manga-title" title="${m.title}">${m.title}</div>
        <div class="manga-latest">
          <span>${m.latestEp || (m.lastChapterTitle ? m.lastChapterTitle : 'อ่านต่อ')}</span>
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
        deleteHistoryItem(m.mangaUrl || m.title);
      });
    }

    card.addEventListener('click', () => openChapterModal(m));
    grid.appendChild(card);
  });

  if (loadMoreBtn) {
    loadMoreBtn.style.display = (currentTagFilter === 'history' || currentTagFilter === 'favorites') ? 'none' : 'inline-flex';
  }
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
            isLocked: true,
            badge: badge,
            sourceType: 'readtoon'
          });
        }
      }
    });

    chapters.sort((a, b) => {
      const na = parseInt((a.url.match(/\/(\d+)$/) || [0, 0])[1]);
      const nb = parseInt((b.url.match(/\/(\d+)$/) || [0, 0])[1]);
      return nb - na;
    });
  } else if (sourceType === 'whytoon') {
    const links = doc.querySelectorAll('a[href*="/content/"]');
    links.forEach(a => {
      const href = (a.getAttribute('href') || '').trim();
      if (href && href.match(/\/content\/[^/]+\/\d+/)) {
        const fullUrl = baseUrl.replace(/\/$/, '') + href;
        const numMatch = href.match(/\/content\/[^/]+\/(\d+)/);
        const title = numMatch ? `ตอนที่ ${numMatch[1]}` : (a.textContent.trim().replace(/\s+/g, ' ') || 'อ่านตอนนี้');
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          chapters.push({
            title,
            url: fullUrl,
            isLocked: false,
            badge: '✨ ฟรี',
            sourceType: 'whytoon'
          });
        }
      }
    });

    chapters.sort((a, b) => {
      const na = parseInt((a.url.match(/\/(\d+)$/) || [0, 0])[1]);
      const nb = parseInt((b.url.match(/\/(\d+)$/) || [0, 0])[1]);
      return nb - na;
    });
  } else if (sourceType === 'ntrnaja') {
    const links = doc.querySelectorAll('a[href*="?chapter="]');
    links.forEach(a => {
      let href = (a.getAttribute('href') || '').trim();
      if (!href) return;
      if (href.startsWith('/')) href = baseUrl.replace(/\/$/, '') + href;

      const rawText = a.textContent.trim().replace(/\s+/g, ' ');
      const matchEp = rawText.match(/ตอนที่\s*(\d+(\.\d+)?)/i) || href.match(/chapter=-?(\d+(\.\d+)?)/i);
      const epTitle = matchEp ? `ตอนที่ ${matchEp[1]}` : (rawText.split('\n')[0] || 'อ่านตอนนี้');

      const pointMatch = rawText.match(/ราคา\s*(\d+)\s*พอยท์/);
      const isExplicitFree = rawText.includes('ฟรี') && !pointMatch;

      let badge = '🔒 ติดเหรียญ';
      let isLocked = true;

      if (pointMatch) {
        badge = `🔒 ${pointMatch[1]} พอยท์`;
      } else if (isExplicitFree) {
        badge = '✨ ฟรี (ต้นทาง)';
        isLocked = false;
      }

      if (!seenUrls.has(href)) {
        seenUrls.add(href);
        chapters.push({
          title: epTitle,
          url: href,
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
      let rawTitle = a.textContent.trim().replace(/\s+/g, ' ');

      if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.includes('/genre') || url.includes('/tag') || url.includes('/author')) {
        return;
      }

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
          isLocked: false,
          badge: '✨ ฟรี',
          sourceType: 'madara'
        });
      }
    });
  } else {
    // MangaReader (Go, Fin, Dark, Up, Slow, NTR-Manga, Ecchi, Speed)
    doc.querySelectorAll('#series-history, #series-history-tpl, [id*="history"]').forEach(el => el.remove());

    const links = doc.querySelectorAll('.eph-num a, .clstyle li a, #chapterlist li a, .bxcl ul li a, .chlist li a, .ntr-upd-ep');
    links.forEach(a => {
      let url = (a.getAttribute('href') || '').trim();
      let rawTitle = a.textContent.trim().replace(/\s+/g, ' ');

      if (!url || url.startsWith('#') || url.includes('{{') || url.includes('}}') || url.startsWith('javascript:')) {
        return;
      }

      // กรอง URL ที่ไม่ใช่ตอนการ์ตูน
      if (url.includes('/page/') || url.includes('/genre') || url.includes('/tag') || url.includes('/author') || url.includes('/feed') || url.includes('wp-admin')) {
        return;
      }

      if (url.startsWith('//')) {
        url = 'https:' + url;
      } else if (url.startsWith('/')) {
        url = baseUrl.replace(/\/$/, '') + url;
      } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = baseUrl.replace(/\/$/, '') + '/' + url;
      }

      let title = rawTitle;
      const numMatch = rawTitle.match(/ตอนที่\s*(\d+(\.\d+)?)/i) || rawTitle.match(/ch\.\s*(\d+(\.\d+)?)/i) || url.match(/chapter-(\d+(\.\d+)?)/i) || url.match(/-(\d+(\.\d+)?)\/?$/) || url.match(/\/(\d+(\.\d+)?)-[a-z0-9]/i);
      if (numMatch && !title.includes('ตอนที่')) {
        title = `ตอนที่ ${numMatch[1]}`;
      }

      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        chapters.push({
          title: title || 'อ่านตอนนี้',
          url,
          isLocked: false,
          badge: '✨ ฟรี',
          sourceType: 'mangareader'
        });
      }
    });
  }

  return chapters;
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

  // แหล่งที่กำลังเลือกดู (หากไม่ได้ระบุ และเรื่องนี้มีเว็บฟรี ให้เปิดเว็บฟรีก่อนเป็นอันดับแรกเสมอ!)
  let currentSource = activeSource;
  if (!currentSource) {
    const freeAlt = (manga.altSources || []).find(s => s.readable !== false);
    if (manga.readable === false && freeAlt) {
      currentSource = freeAlt; // ผู้ใช้จะเห็นเว็บฟรี 100% ทันทีโดยไม่ต้องติดเหรียญ!
    } else {
      currentSource = manga;
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
    if (histItem && histItem.lastChapterUrl && histItem.lastChapterTitle && !isAlreadyOnThisChapter) {
      continueBox.style.display = 'flex';
      const q = new URLSearchParams();
      q.set('url', histItem.lastChapterUrl);
      q.set('title', manga.title + ' - ' + histItem.lastChapterTitle);
      q.set('source', currentSource.sourceUrl);
      q.set('mangaUrl', currentSource.mangaUrl);
      q.set('mangaTitle', manga.title);
      q.set('sourceId', currentSource.sourceId || '');
      q.set('sourceName', currentSource.sourceName);
      q.set('sourceType', currentSource.sourceType);

      continueBox.innerHTML = `
        <div class="continue-reading-text">
          <span>📖 อ่านค้างไว้ที่: <strong>${histItem.lastChapterTitle}</strong></span>
          <span style="font-size: 0.75rem; color: #aaa;">(${formatTimeAgo(histItem.updatedAt)})</span>
        </div>
        <a href="reader.html?${q.toString()}" class="btn-continue-now">อ่านต่อตอนนี้ ⚡</a>
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

    allSources.forEach(s => {
      const isFree = s.readable !== false;
      const isSelected = s.sourceId === currentSource.sourceId;
      const pill = document.createElement('button');
      pill.className = `modal-source-pill ${isSelected ? 'active' : ''} ${!isFree ? 'locked' : ''}`;
      pill.innerHTML = `
        <span>${s.icon || (isFree ? '⚡' : '🔒')}</span>
        <span>${s.sourceName}</span>
        <span class="source-pill-badge ${isFree ? 'free' : 'coin'}">${isFree ? 'ฟรี' : 'ติดเหรียญ'}</span>
      `;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        openChapterModal(manga, s);
      });
      sourcePills.appendChild(pill);
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

  if (chapterList) chapterList.innerHTML = `<div class="spinner"></div>กำลังโหลดรายชื่อตอนจาก ${currentSource.sourceName}...`;
  if (modal) modal.style.display = 'flex';

  try {
    let html = await fetchViaProxy(currentSource.mangaUrl);
    let chapters = parseChaptersFromHtml(html, currentSource.sourceUrl, currentSource.sourceType);

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

    chapterList.innerHTML = '';
    chapters.forEach(c => {
      const isRead = readUrls.has(c.url);
      const isCurrent = currentReadingChapterUrl && (c.url === currentReadingChapterUrl);
      const a = document.createElement('a');
      a.className = `chapter-item ${c.isLocked ? 'locked' : ''} ${isRead ? 'is-read' : ''} ${isCurrent ? 'current-chapter' : ''}`;

      const currentBadgeHtml = isCurrent ? '<span class="chapter-current-badge">กำลังอ่าน 📍</span>' : '';
      const readBadgeHtml = (!isCurrent && isRead) ? '<span class="chapter-read-badge">✓ อ่านแล้ว</span>' : '';

      if (c.isLocked) {
        // ตอนติดเหรียญ: เปิดอ่านที่เว็บต้นทางโดยตรง
        a.href = c.url;
        a.target = '_blank';
        a.innerHTML = `
          <div class="chapter-title-group">
            <span class="chapter-badge-coin">${c.badge || '🔒 ติดเหรียญ'}</span>
            <span class="chapter-title-text">${c.title}</span>
            ${currentBadgeHtml}
            ${readBadgeHtml}
          </div>
          <span class="chapter-action-link">เปิดต้นทาง ↗</span>
        `;
      } else {
        // ตอนฟรี: เปิดอ่านด้วย Vertical Reader
        const q = new URLSearchParams();
        q.set('url', c.url);
        q.set('title', manga.title + ' - ' + c.title);
        q.set('source', currentSource.sourceUrl);
        q.set('mangaUrl', currentSource.mangaUrl);
        q.set('mangaTitle', manga.title);
        q.set('sourceId', currentSource.sourceId || '');
        q.set('sourceName', currentSource.sourceName);
        q.set('sourceType', currentSource.sourceType);

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

      chapterList.appendChild(a);
    });

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
  if (!window.location.pathname.includes('reader.html')) {
    try {
      sessionStorage.removeItem('currentManga');
      sessionStorage.removeItem('scrollPos');
    } catch (e) {}
  }
}

// 14. หน้า Reader (อ่านการ์ตูน)
function parseReaderData(html, currentUrl = '') {
  // 1. ลองหา ts_reader.run (Go, Fin, Dark, Up, Slow, NTR-Manga, Ecchi)
  const match = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
  if (match) {
    try {
      const readerJson = JSON.parse(match[1]);
      const rawImages = readerJson.sources?.[0]?.images || [];
      return {
        prevUrl: readerJson.prevUrl || '',
        nextUrl: readerJson.nextUrl || '',
        images: rawImages.map(imgUrl => getProxyUrl(imgUrl))
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
      prevUrl: prevMatch ? `${baseUrl}${prevMatch[1]}` : '',
      nextUrl: nextMatch ? `${baseUrl}${nextMatch[1]}` : '',
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

  // 4. ตรวจสอบเว็บตระกูล Madara (Du-Manga, Manga-LC)
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const madaraImgs = doc.querySelectorAll('.reading-content img, .page-break img, .wp-manga-chapter-img');
  if (madaraImgs.length > 0) {
    const imgs = [];
    const prevLink = doc.querySelector('.nav-previous a, a.prev_page, .btn.prev_page');
    const nextLink = doc.querySelector('.nav-next a, a.next_page, .btn.next_page');

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
        prevUrl: prevLink ? prevLink.getAttribute('href') : '',
        nextUrl: nextLink ? nextLink.getAttribute('href') : '',
        images: imgs
      };
    }
  }

  // 5. Fallback สำหรับเว็บทั่วไปที่ดึงจากแท็ก img ในเนื้อหา
  const fallbackPrevLink = doc.querySelector('.nav-previous a, a.prev_page, .ch-prev-btn, .nextprev .prev');
  const fallbackNextLink = doc.querySelector('.nav-next a, a.next_page, .ch-next-btn, .nextprev .next');
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
    prevUrl: fallbackPrevLink ? fallbackPrevLink.getAttribute('href') : '',
    nextUrl: fallbackNextLink ? fallbackNextLink.getAttribute('href') : '',
    images: imgs
  };
}

async function initReaderPage() {
  const params = new URLSearchParams(window.location.search);
  const chapterUrl = params.get('url');
  const title = params.get('title') || 'อ่านการ์ตูน';

  let mangaUrl = params.get('mangaUrl');
  let mangaTitle = params.get('mangaTitle');
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
      if (!sourceId) sourceId = m.sourceId;
      if (!sourceName) sourceName = m.sourceName;
      if (!sourceUrl) sourceUrl = m.sourceUrl;
      if (!sourceType) sourceType = m.sourceType;
      if (m.altSources && Array.isArray(m.altSources)) {
        savedAltSources = m.altSources;
      }
    }
  } catch (e) {}

  const mangaObj = {
    title: mangaTitle || title.split(' - ')[0] || 'มังงะ',
    mangaUrl: mangaUrl || '',
    sourceId: sourceId || '',
    sourceName: sourceName || 'Online',
    sourceUrl: sourceUrl || '',
    sourceType: sourceType || 'mangareader',
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
  const directSourceUrl = chapterUrl || mangaObj.mangaUrl || mangaObj.sourceUrl;
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

  if (!chapterUrl) {
    statusEl.innerHTML = 'ไม่พบ URL ของตอนนี้ <br><button onclick="window.location.href=\'index.html?restore=1\'" class="btn-nav" style="margin-top:10px;">← กลับหน้ารายการตอน</button>';
    return;
  }

  try {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<div class="spinner"></div>กำลังโหลดรูปภาพมังงะ...';

    const html = await fetchViaProxy(chapterUrl);
    const readerData = parseReaderData(html, chapterUrl);

    statusEl.style.display = 'none';

    if (readerData.images.length === 0) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = `
        <div style="max-width:520px; margin: 40px auto; padding: 32px 24px; background: rgba(255,255,255,0.04); border-radius: 18px; border: 1px solid var(--border); text-align: center; backdrop-filter: blur(10px);">
          <div style="font-size: 2.5rem; margin-bottom: 12px;">🔒</div>
          <h3 style="font-size: 1.2rem; margin-bottom: 8px; color:#fff;">ตอนนี้อาจมีการเข้ารหัสหรือติดระบบเหรียญของต้นทาง</h3>
          <p style="color: var(--text-sub); font-size: 0.9rem; line-height: 1.6; margin-bottom: 22px;">
            เนื่องจากตอนนี้ในเว็บต้นทาง (${mangaObj.sourceName}) มีการใช้ระบบป้องกันเหรียญหรือบอท คุณสามารถกดเปิดอ่านได้โดยตรงที่เว็บต้นทาง
          </p>
          <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
            <a href="${chapterUrl}" target="_blank" class="btn-primary" style="padding: 11px 22px; font-size: 0.9rem;">
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

    // บันทึกประวัติการอ่านเข้า localStorage อัตโนมัติ (ไม่หายแม้ปิดเครื่อง ไม่ต้องล็อกอิน)
    try {
      const savedMangaRaw = sessionStorage.getItem('currentManga');
      if (savedMangaRaw) {
        const sm = JSON.parse(savedMangaRaw);
        if (!mangaObj.cover && sm.cover) mangaObj.cover = sm.cover;
        if (!mangaObj.type && sm.type) mangaObj.type = sm.type;
        if (!mangaObj.latestEp && sm.latestEp) mangaObj.latestEp = sm.latestEp;
      }
    } catch (e) {}

    let chapterEpTitle = title;
    if (mangaObj.title && chapterEpTitle.startsWith(mangaObj.title)) {
      chapterEpTitle = chapterEpTitle.replace(mangaObj.title, '').replace(/^[- :]+/, '').trim() || chapterEpTitle;
    }
    recordReadingHistory(mangaObj, chapterEpTitle, chapterUrl);

    const setupNavButtons = (prev, next) => {
      const buildNavUrl = (targetEpUrl) => {
        const p = new URLSearchParams();
        p.set('url', targetEpUrl);
        p.set('title', mangaObj.title);
        if (mangaObj.sourceUrl) p.set('source', mangaObj.sourceUrl);
        if (mangaObj.mangaUrl) p.set('mangaUrl', mangaObj.mangaUrl);
        if (mangaObj.title) p.set('mangaTitle', mangaObj.title);
        if (mangaObj.sourceId) p.set('sourceId', mangaObj.sourceId);
        if (mangaObj.sourceName) p.set('sourceName', mangaObj.sourceName);
        if (mangaObj.sourceType) p.set('sourceType', mangaObj.sourceType);
        return `reader.html?${p.toString()}`;
      };

      const setBtn = (btn, url) => {
        if (!btn) return;
        if (url) {
          btn.onclick = () => { window.location.href = buildNavUrl(url); };
          btn.disabled = false;
        } else {
          btn.disabled = true;
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
