// GET /api/forecast/today
//
// Pipeline:
// 1. Call Astrologer API's moon-phase "context" endpoint (real astronomy, Kerykeion engine)
//    -> returns structured moon-phase facts PLUS an AI-ready XML context string.
// 2. If GEMINI_API_KEY is set, feed that context to Gemini and ask it to write the
//    forecast in Evia's warm, second-person voice. Otherwise return the raw facts
//    (aiSkipped: true) so the app still has something sensible to show.
// 3. Cache the response at the edge until the next scheduled refresh.
//
// Env vars needed:
//   ASTROLOGER_API_KEY  — RapidAPI key for the Astrologer API (astrologer.p.rapidapi.com)
//   GEMINI_API_KEY      — API key from https://aistudio.google.com (free tier, no card needed)
//   GEMINI_MODEL        — optional, defaults to "gemini-2.5-flash"
//
// NOTE: the moon-phase endpoint is location-independent for the phase/illumination
// numbers themselves (same everywhere on Earth at a given instant) — we call the
// UTC "now" variant so no birth-data / geocoding setup is required.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const WEEKDAYS_RU = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

module.exports = async (req, res) => {
  try {
    const forceRefresh = req.query && (req.query.refresh === '1');

    const facts = await fetchAstroFacts();

    const hasGeminiKey = !!process.env.GEMINI_API_KEY;
    let aiResult = null;
    let aiSkipped = true;

    if (hasGeminiKey) {
      try {
        aiResult = await rewriteWithGemini(facts);
        aiSkipped = false;
      } catch (err) {
        console.error('Gemini rewrite failed, falling back to raw facts:', err.message);
        aiSkipped = true;
      }
    }

    const now = new Date();
    const payload = {
      ok: true,
      date: now.toISOString().slice(0, 10),
      weekday: WEEKDAYS_RU[now.getDay()],
      moonPhaseName: facts.phaseName,
      moonIllumination: facts.illumination,
      moonEmoji: facts.emoji,
      teaser: aiResult ? aiResult.teaser : buildFallbackTeaser(facts),
      text: aiResult ? aiResult.text : buildFallbackText(facts),
      aiSkipped,
      source: 'astrologer-api',
      generatedAt: now.toISOString()
    };

    if (!forceRefresh) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.status(200).json(payload);
  } catch (err) {
    console.error('forecast/today failed:', err);
    res.status(200).json({
      ok: false,
      error: 'forecast_unavailable',
      message: 'Не удалось получить прогноз. Попробуйте обновить чуть позже.',
      generatedAt: new Date().toISOString()
    });
  }
};

async function fetchAstroFacts() {
  // The API needs a full date/time + location payload (no bare "now" shortcut exists
  // in this API version) — we feed it the current UTC moment. Moon phase itself is the
  // same everywhere on Earth at a given instant; the location only affects chart framing,
  // so a fixed reference point (Moscow, since Evia is a Russian-language app) is fine.
  const now = new Date();
  const resp = await fetch('https://astrologer.p.rapidapi.com/api/v5/moon-phase/context', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Host': 'astrologer.p.rapidapi.com',
      'X-RapidAPI-Key': process.env.ASTROLOGER_API_KEY
    },
    body: JSON.stringify({
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      latitude: 55.7558,
      longitude: 37.6173,
      timezone: 'Europe/Moscow',
      location_precision: 4
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Astrologer API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  // The API returns the facts embedded as an XML-flavoured string inside "context"
  // (not as separate JSON fields) — e.g. <phase_name>Waning Crescent</phase_name>.
  // We pull out the bits we want to show directly, and always keep the full context
  // string to hand to the AI rewrite step regardless of whether these matches hit.
  const contextStr = data?.context || '';
  const phaseNameMatch = contextStr.match(/<phase_name>([^<]+)<\/phase_name>/);
  const illuminationMatch = contextStr.match(/<illumination>([^<]+)<\/illumination>/);
  const emojiMatch = contextStr.match(/<emoji>([^<]+)<\/emoji>/);

  return {
    phaseName: phaseNameMatch ? phaseNameMatch[1] : 'уточняется',
    illumination: illuminationMatch ? illuminationMatch[1] : null,
    emoji: emojiMatch ? emojiMatch[1] : '🌙',
    aiContext: contextStr || JSON.stringify(data).slice(0, 2000),
    rawOverview: data
  };
}

async function rewriteWithGemini(facts) {
  const systemPrompt = `Ты — голос приложения «Эвия», тёплого женского wellness-приложения о чакрах, эмоциях и лунных циклах.
Тебе дают реальные астрономические факты о текущей фазе Луны (посчитаны точной астрономической библиотекой, не выдуманы).
Перепиши их в живой, тёплый, поддерживающий текст на «ты», без эзотерического жаргона и воды. Пиши по-русски.
Структура ответа — строго JSON без пояснений: {"teaser": "...", "text": "..."}.
teaser — одна короткая строка (до 60 символов), например "Луна убывает · 62% освещённости".
text — 5-8 коротких абзацев с пустой строкой между ними: что означает эта фаза Луны для настроения и энергии дня, на что хорошо направить внимание сегодня, тёплый итог. Обращайся к читательнице на «ты», без клише вроде «звёзды говорят».`;

  const userPrompt = `Факты о текущей фазе Луны (реальные астрономические данные):
Фаза: ${facts.phaseName}
Освещённость: ${facts.illumination}

Дополнительный контекст от астрономического движка:
${facts.aiContext || '(нет дополнительных данных)'}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 1000,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const rawAnswer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawAnswer) throw new Error('Gemini returned no text');

  const cleaned = rawAnswer.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.teaser || !parsed.text) throw new Error('Gemini JSON missing fields');
  return parsed;
}

function buildFallbackTeaser(facts) {
  return `Луна: ${facts.phaseName}${facts.illumination ? ' · ' + facts.illumination + ' освещённости' : ''}`;
}

function buildFallbackText(facts) {
  const lines = [
    `Сегодня фаза Луны — ${facts.phaseName}${facts.illumination ? `, освещённость ${facts.illumination}` : ''}.`,
    '',
    'Подключите GEMINI_API_KEY, чтобы этот текст переписывался в тёплом голосе Эвии автоматически.'
  ];
  return lines.join('\n');
}
