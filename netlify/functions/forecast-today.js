// Netlify Function: /.netlify/functions/forecast-today
// (mapped to /api/forecast/today via the redirect in netlify.toml)
//
// Pipeline:
// 1. Call Astrologer API's moon-phase "context" endpoint (real astronomy, Kerykeion engine)
//    -> returns structured moon-phase facts PLUS an AI-ready XML context string.
// 2. If GEMINI_API_KEY is set, feed that context to Gemini and ask it to write the
//    forecast in Evia's warm, second-person voice. Otherwise return the raw facts
//    (aiSkipped: true) so the app still has something sensible to show.
//
// Env vars needed (Netlify → Site configuration → Environment variables):
//   ASTROLOGER_API_KEY  — RapidAPI key for the Astrologer API (astrologer.p.rapidapi.com)
//   YANDEX_GPT_API_KEY  — API key for a Yandex Cloud service account (role ai.languageModels.user)
//   YANDEX_FOLDER_ID    — the Yandex Cloud folder id the key belongs to
const WEEKDAYS_RU = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

const PLANET_RU = {
  Sun: 'Солнце', Moon: 'Луна', Mercury: 'Меркурий', Venus: 'Венера', Mars: 'Марс',
  Jupiter: 'Юпитер', Saturn: 'Сатурн', Uranus: 'Уран', Neptune: 'Нептун', Pluto: 'Плутон',
  Chiron: 'Хирон',
  Mean_Node: 'Северный узел', True_Node: 'Северный узел', North_Node: 'Северный узел',
  Mean_South_Node: 'Южный узел', True_South_Node: 'Южный узел', South_Node: 'Южный узел'
};
function prettyPlanet(name) {
  return PLANET_RU[name] || String(name || '').replace(/_/g, ' ');
}

const PHASE_RU = {
  'New Moon': 'новолуние', 'Waxing Crescent': 'растущий серп', 'First Quarter': 'первая четверть',
  'Waxing Gibbous': 'растущая Луна', 'Full Moon': 'полнолуние', 'Waning Gibbous': 'убывающая Луна',
  'Last Quarter': 'последняя четверть', 'Waning Crescent': 'убывающий серп'
};
const ZODIAC_RU = {
  Ari:'Овне', Tau:'Тельце', Gem:'Близнецах', Can:'Раке', Leo:'Льве', Vir:'Деве',
  Lib:'Весах', Sco:'Скорпионе', Sag:'Стрельце', Cap:'Козероге', Aqu:'Водолее', Pis:'Рыбах'
};
const ASPECT_RU = {
  conjunction: 'Соединение', opposition: 'Оппозиция', trine: 'Тригон', square: 'Квадрат',
  sextile: 'Секстиль'
};
const MAJOR_ASPECTS = ['conjunction', 'opposition', 'trine', 'square', 'sextile'];

async function fetchAspects() {
  try {
    const now = new Date();
    const subject = {
      name: 'Now',
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      city: 'Moscow',
      nation: 'RU',
      longitude: 37.6173,
      latitude: 55.7558,
      timezone: 'Europe/Moscow'
    };
    const resp = await fetch('https://astrologer.p.rapidapi.com/api/v5/chart/transit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Host': 'astrologer.p.rapidapi.com',
        'X-RapidAPI-Key': process.env.ASTROLOGER_API_KEY
      },
      body: JSON.stringify({ first_subject: subject, transit_subject: subject })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`fetchAspects: Astrologer API ${resp.status}: ${errText.slice(0, 300)}`);
      return [];
    }
    const data = await resp.json();
    console.error('fetchAspects: raw aspects count =', (data?.chart_data?.aspects || []).length);
    const raw = data?.chart_data?.aspects || [];
    const majors = raw.filter(a =>
      MAJOR_ASPECTS.includes(String(a.aspect || '').toLowerCase()) &&
      a.p1_name !== a.p2_name // drop self-pairs (Sun-Sun etc.) — both subjects are the same moment
    );
    // Moon changes position fastest and is traditionally the most relevant body for a
    // single day's forecast, so its aspects are surfaced first; ties broken by tightest orb.
    majors.sort((a, b) => {
      const aMoon = (a.p1_name === 'Moon' || a.p2_name === 'Moon') ? 0 : 1;
      const bMoon = (b.p1_name === 'Moon' || b.p2_name === 'Moon') ? 0 : 1;
      if (aMoon !== bMoon) return aMoon - bMoon;
      return Math.abs(a.orb) - Math.abs(b.orb);
    });
    const seen = new Set();
    const deduped = [];
    for (const a of majors) {
      const key = [a.p1_name, a.p2_name].sort().join('|') + '|' + String(a.aspect || '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(a);
    }
    return deduped.slice(0, 4).map(a => {
      const p1 = prettyPlanet(a.p1_name);
      const p2 = prettyPlanet(a.p2_name);
      const asp = ASPECT_RU[String(a.aspect || '').toLowerCase()] || a.aspect;
      return `${asp} ${p1}-${p2}`;
    });
  } catch (err) {
    console.error('fetchAspects failed:', err.message);
    return [];
  }
}

exports.handler = async function (event) {
  try {
    const forceRefresh = event.queryStringParameters && event.queryStringParameters.refresh === '1';

    const [facts, aspects] = await Promise.all([fetchAstroFacts(), fetchAspects()]);
    facts.aspects = aspects;

    const hasYandexKeys = !!(process.env.YANDEX_GPT_API_KEY && process.env.YANDEX_FOLDER_ID);
    let aiResult = null;
    let aiSkipped = true;

    if (hasYandexKeys) {
      try {
        aiResult = await rewriteWithYandexGPT(facts);
        aiSkipped = false;
      } catch (err) {
        console.error('YandexGPT rewrite failed, falling back to raw facts:', err.message);
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
      aspects: facts.aspects || [],
      teaser: aiResult ? aiResult.teaser : buildFallbackTeaser(facts),
      text: aiResult ? aiResult.text : buildFallbackText(facts),
      aiSkipped,
      source: 'astrologer-api',
      generatedAt: now.toISOString()
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': forceRefresh ? 'no-store' : 's-maxage=3600, stale-while-revalidate=1800'
      },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    console.error('forecast-today failed:', err);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: 'forecast_unavailable',
        message: 'Не удалось получить прогноз. Попробуйте обновить чуть позже.',
        generatedAt: new Date().toISOString()
      })
    };
  }
};

async function fetchAstroFacts() {
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
  const contextStr = data?.context || '';
  const phaseNameMatch = contextStr.match(/<phase_name>([^<]+)<\/phase_name>/);
  const illuminationMatch = contextStr.match(/<illumination>([^<]+)<\/illumination>/);
  const emojiMatch = contextStr.match(/<emoji>([^<]+)<\/emoji>/);
  const moonSignMatch = contextStr.match(/moon_sign="([^"]+)"/);

  const rawPhaseName = phaseNameMatch ? phaseNameMatch[1] : null;
  const rawMoonSign = moonSignMatch ? moonSignMatch[1] : null;

  return {
    phaseName: rawPhaseName ? (PHASE_RU[rawPhaseName] || rawPhaseName) : 'уточняется',
    moonSignRu: rawMoonSign ? (ZODIAC_RU[rawMoonSign] || rawMoonSign) : null,
    illumination: illuminationMatch ? illuminationMatch[1] : null,
    emoji: emojiMatch ? emojiMatch[1] : '🌙',
    aiContext: contextStr || JSON.stringify(data).slice(0, 2000),
    rawOverview: data
  };
}

async function rewriteWithYandexGPT(facts) {
  const systemPrompt = `Ты — голос приложения «Эвия», тёплого женского wellness-приложения о чакрах, эмоциях и лунных циклах.
Тебе дают реальные астрономические факты о текущей фазе Луны и её знаке (посчитаны точной астрономической библиотекой, не выдуманы).
Пиши так, будто ты рассказываешь всё это лучшей подруге, которая искренне верит в астрологию, но совсем не разбирается в терминах — простыми словами, тепло, без зауми и без «звёзды говорят».
Пиши по-русски, на «ты». Структура ответа — строго JSON без пояснений: {"teaser": "...", "text": "..."}.

teaser — одна короткая строка (до 60 символов), например "Луна в Близнецах растёт · 62%".

text — подробный текст из 10-14 коротких абзацев (пустая строка между ними), в этом порядке:
1. Что за фаза Луны сегодня и что это в целом значит для настроения и энергии дня.
2. Если известен знак Луны — отдельным абзацем расскажи, что значит "Луна в этом знаке" простыми словами, как будто объясняешь подруге суть знака на пальцах (не используй слово "транзит").
3. Аспекты дня — если они даны, разбери КАЖДЫЙ аспект отдельным коротким абзацем: что за планеты участвуют, что это создаёт в жизни (простыми словами: про чувства, общение, работу, отношения — не используй термины "орб" или "транзит"). Если аспектов нет — пропусти этот пункт без упоминания.
4. Абзац для тех, кто работает по найму: как сегодняшний день скажется на работе в коллективе, на общении с начальством/коллегами, на продуктивности.
5. Абзац для тех, кто работает на себя (фрилансер, предприниматель): как день скажется на самостоятельных решениях, клиентах, деньгах, инициативе.
6. Абзац про сны — что может присниться в такую лунную фазу и стоит ли обращать внимание.
7. Абзац про здоровье и тело — на что обратить внимание сегодня (мягко, без медицинских диагнозов, просто общие наблюдения вроде "может тянуть на сладкое" или "лучше лечь пораньше").
8. Абзац про отношения — с партнёром, семьёй, друзьями.
9. Тёплый итог — на что хорошо направить внимание сегодня.

Обращайся к читательнице на «ты» на протяжении всего текста, дружелюбно и без клише.`;

  const userPrompt = `Факты на сегодня (реальные астрономические данные):
Фаза Луны: ${facts.phaseName}
Освещённость: ${facts.illumination}
${facts.moonSignRu ? 'Луна в знаке: ' + facts.moonSignRu : ''}

Аспекты дня: ${(facts.aspects && facts.aspects.length) ? facts.aspects.join(', ') : 'нет выраженных аспектов'}

Дополнительный контекст от астрономического движка:
${facts.aiContext || '(нет дополнительных данных)'}`;

  const resp = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Api-Key ${process.env.YANDEX_GPT_API_KEY}`,
      'x-folder-id': process.env.YANDEX_FOLDER_ID
    },
    body: JSON.stringify({
      modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.6, maxTokens: 1200 },
      messages: [
        { role: 'system', text: systemPrompt },
        { role: 'user', text: userPrompt }
      ]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`YandexGPT ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const rawAnswer = data?.result?.alternatives?.[0]?.message?.text;
  if (!rawAnswer) throw new Error('YandexGPT returned no text');

  const cleaned = rawAnswer.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.teaser || !parsed.text) throw new Error('YandexGPT JSON missing fields');
  return parsed;
}

function buildFallbackTeaser(facts) {
  return `Луна: ${facts.phaseName}${facts.illumination ? ' · ' + facts.illumination + ' освещённости' : ''}`;
}

function buildFallbackText(facts) {
  const lines = [
    `Сегодня фаза Луны — ${facts.phaseName}${facts.illumination ? `, освещённость ${facts.illumination}` : ''}.`,
    '',
    'Подключите YANDEX_GPT_API_KEY и YANDEX_FOLDER_ID, чтобы этот текст переписывался в тёплом голосе Эвии автоматически.'
  ];
  return lines.join('\n');
}
