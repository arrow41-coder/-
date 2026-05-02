const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
const KHUTBAHS_FILE = './khutbahs.json';

let existing = [];
if (fs.existsSync(KHUTBAHS_FILE)) {
  existing = JSON.parse(fs.readFileSync(KHUTBAHS_FILE, 'utf8'));
}
const existingTitles = new Set(existing.map(k => k.title));

const SOURCES = [
  {
    name: 'إسلام ويب',
    url: 'https://www.islamweb.net/ar/articles/index.php?page=artcat&catid=1',
    scraper: scrapeIslamweb
  }
  // يمكن إضافة مصادر أخرى بنفس النمط
];

async function scrapeIslamweb(url) {
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'ar', 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const articles = [];
  $('a.article-title, h3 a').each((i, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr('href');
    if (title && href && !existingTitles.has(title)) {
      articles.push({ title, url: new URL(href, url).href });
    }
  });
  return articles.slice(0, 3); // 3 مقالات جديدة كحد أقصى
}

async function extractKhutbahWithAI(rawText, meta) {
  const prompt = `أنت مساعد متخصص في تنظيم بيانات خطب الجمعة.
المهمة: حوّل النص الخام التالي إلى كائن JSON يتبع هذا الشكل بدقة:
{
  "title": "العنوان الكامل",
  "source": "${meta.source}",
  "sheikh": "اسم الشيخ كاملاً بصيغة: الشيخ [الاسم]",
  "date": "التاريخ بالعربية مثل: ١٨ أبريل ٢٠٢٥",
  "dateISO": "YYYY-MM-DD",
  "dateAdded": "${new Date().toISOString().split('T')[0]}",
  "minutes": عدد_صحيح,
  "durationType": "short أو medium أو long",
  "topic": "aqeedah أو akhlaq أو fiqh أو seerah أو mujtama3 أو tarbiyah أو zuhd",
  "excerpt": "ملخص 2-3 جمل بالعربية",
  "body": "نص HTML للخطبة باستخدام: <p> للفقرات، <div class=quran-verse> للآيات، <div class=hadith> للأحاديث، <span class=khutbah-part> للفواصل",
  "audioUrl": null,
  "sourceUrl": "${meta.url}"
}

قواعد:
- durationType: short إذا minutes < 15، medium إذا 15-20، long إذا > 20
- إذا لم تجد تاريخاً واضحاً، استخدم تاريخ اليوم
- لا تخترع معلومات — فقط استخرج ما هو موجود في النص
- أرجع JSON فقط بدون أي نص آخر

النص الخام:
${rawText.slice(0, 4000)}`;

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.2 }
    })
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Failed to parse Gemini response:', text);
    return null;
  }
}

async function run() {
  const newKhutbahs = [];
  for (const source of SOURCES) {
    console.log(`Fetching from: ${source.name}`);
    try {
      const articles = await source.scraper(source.url);
      for (const article of articles) {
        console.log(`  Processing: ${article.title}`);
        const pageRes = await fetch(article.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const pageHtml = await pageRes.text();
        const $page = cheerio.load(pageHtml);
        const rawText = $page('.article-body, .khutbah-content, main, article').text().trim();
        if (rawText.length < 500) {
          console.log(`  Skipping — content too short`);
          continue;
        }
        const khutbah = await extractKhutbahWithAI(rawText, { source: source.name, url: article.url });
        if (khutbah && !existingTitles.has(khutbah.title)) {
          newKhutbahs.push(khutbah);
          existingTitles.add(khutbah.title);
          console.log(`  ✓ Added: ${khutbah.title}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`Error fetching ${source.name}:`, err.message);
    }
  }
  if (newKhutbahs.length > 0) {
    const updated = [...newKhutbahs, ...existing];
    fs.writeFileSync(KHUTBAHS_FILE, JSON.stringify(updated, null, 2), 'utf8');
    console.log(`✅ Added ${newKhutbahs.length} new khutbahs. Total: ${updated.length}`);
  } else {
    console.log('No new khutbahs found this week.');
  }
}

run().catch(console.error);
