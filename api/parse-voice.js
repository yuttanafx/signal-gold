// /api/parse-voice.js
// Vercel Serverless Function — ตัวกลางเรียก AI (Claude หรือ Gemini) เพื่อแปลคำสั่งเสียงอิสระ
// ให้กลายเป็น action ที่ front-end เข้าใจได้ (กัน API key ไม่ให้หลุดไปฝั่ง browser)
//
// วิธีตั้งค่า:
// 1. เลือกอย่างน้อยหนึ่งค่าย:
//    - Claude: สมัคร key ที่ https://console.anthropic.com
//    - Gemini: สมัคร key ที่ https://aistudio.google.com/apikey
// 2. ใน Vercel Dashboard -> Project -> Settings -> Environment Variables เพิ่ม:
//    - ANTHROPIC_API_KEY (ถ้าจะใช้ Claude)
//    - GEMINI_API_KEY (ถ้าจะใช้ Gemini)
// 3. Deploy ใหม่ — ไฟล์นี้ต้องอยู่ที่ /api/parse-voice.js ที่ root ของโปรเจกต์ (นอกโฟลเดอร์ public)
//
// front-end ส่ง { transcript, customAssetKeys, provider } มาที่ endpoint นี้
// provider เป็น "claude" หรือ "gemini" — ถ้าไม่ส่งมาจะ default เป็น "claude"

function buildSystemPrompt(customList) {
  return `คุณคือระบบแปลคำสั่งเสียงสำหรับแอปเทรด TVE Global Signal
หน้าที่ของคุณคือแปลงประโยคภาษาไทยหรืออังกฤษที่ผู้ใช้พูด ให้เป็นคำสั่ง JSON เท่านั้น
ห้ามมีข้อความอื่นนอกเหนือจาก JSON ห้ามใช้ code fence ห้ามมีคำอธิบายเพิ่ม

รูปแบบคำตอบที่ต้องส่งกลับ (JSON เท่านั้น):
{"action": "<ค่าหนึ่งใน changeAsset|changeTF|changeRR|refresh|addSymbol|unknown>", "value": "<string หรือ null>"}

กติกาการตีความ:
- action="changeAsset": ใช้เมื่อผู้ใช้ต้องการดูสินทรัพย์ที่มีอยู่แล้ว
  value ต้องเป็นหนึ่งใน: XAUUSD, BTCUSD, ETHUSD, EURUSD หรือ custom asset ที่มีอยู่แล้วในระบบ: ${customList}
- action="changeTF": ใช้เมื่อผู้ใช้ต้องการเปลี่ยนไทม์เฟรม
  value ต้องเป็นหนึ่งใน "15" (M15), "60" (H1), "240" (H4)
- action="changeRR": ใช้เมื่อผู้ใช้ต้องการเปลี่ยนอัตราส่วน risk:reward
  value ต้องเป็นหนึ่งใน "1" (RR 1:1), "2" (RR 1:2)
- action="refresh": ใช้เมื่อผู้ใช้สั่งให้ตรวจสอบ/รีเฟรชสัญญาณ ไม่ต้องมี value (ใส่ null)
- action="addSymbol": ใช้เมื่อผู้ใช้ต้องการเพิ่มสินทรัพย์ใหม่ที่ยังไม่มีในระบบ
  value ต้องเป็น Binance trading symbol ตัวพิมพ์ใหญ่ ลงท้ายด้วย USDT เสมอ เช่น SOLUSDT, BNBUSDT
  ถ้าผู้ใช้พูดชื่อเหรียญเป็นภาษาไทยหรืออังกฤษ ให้เดา symbol ที่ถูกต้องที่สุดจากความรู้ทั่วไปเกี่ยวกับคริปโต
- ถ้าประโยคไม่เกี่ยวข้องกับคำสั่งข้างต้นเลย หรือตีความไม่ได้ ให้ตอบ {"action":"unknown","value":null}

ตอบเป็น JSON object เดียวเท่านั้น ไม่มีข้อความอื่นใดๆ ทั้งก่อนและหลัง`;
}

function safeParseJSON(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

async function callClaude(transcript, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY on server');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: transcript }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error: ${errText}`);
  }

  const data = await response.json();
  const rawText = (data.content || [])
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('');

  return rawText;
}

async function callGemini(transcript, systemPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY on server');

  // ใช้ gemini-flash-latest (ปัจจุบันชี้ไปที่ gemini-3.5-flash) — เร็วและถูก เหมาะกับงานแปลคำสั่งสั้นๆ แบบนี้
  // ถ้า Google เปลี่ยนชื่อรุ่นในอนาคต ให้เช็ครุ่นล่าสุดที่ https://ai.google.dev/gemini-api/docs/models
  const model = 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      generationConfig: {
        responseMimeType: 'application/json', // บังคับให้ Gemini ตอบเป็น JSON ล้วนๆ ไม่ต้อง strip code fence เอง
        maxOutputTokens: 512, // เผื่อ buffer ให้พอ แม้ thinkingBudget:0 แล้วก็ยังกันไว้เผื่อโมเดลรุ่นถัดไปเปลี่ยนพฤติกรรม
        thinkingConfig: { thinkingBudget: 0 } // ปิดโหมด "คิดก่อนตอบ" — งานนี้แค่ classify ประโยคสั้นๆ ไม่ต้องคิดลึก
        // สำคัญ: ถ้าไม่ตั้งค่านี้ โมเดล 2.5/3.x Flash จะเปิด thinking เป็นค่าเริ่มต้น และ token ที่ใช้คิด
        // จะถูกหักจาก maxOutputTokens ทำให้ตอบว่างเปล่าได้แม้ maxOutputTokens จะดูเยอะพอแล้วก็ตาม
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return rawText;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ action: 'unknown', value: null, error: 'Method not allowed' });
  }

  const { transcript, customAssetKeys, provider } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ action: 'unknown', value: null, error: 'Missing transcript' });
  }

  const selectedProvider = provider === 'gemini' ? 'gemini' : 'claude'; // default = claude
  const customList = Array.isArray(customAssetKeys) && customAssetKeys.length
    ? customAssetKeys.join(', ')
    : 'ไม่มี';
  const systemPrompt = buildSystemPrompt(customList);

  try {
    const rawText = selectedProvider === 'gemini'
      ? await callGemini(transcript, systemPrompt)
      : await callClaude(transcript, systemPrompt);

    const parsed = safeParseJSON(rawText);
    if (!parsed || !parsed.action) {
      return res.status(200).json({ action: 'unknown', value: null, provider: selectedProvider, error: 'Could not parse AI response' });
    }

    return res.status(200).json({ ...parsed, provider: selectedProvider });

  } catch (e) {
    return res.status(500).json({ action: 'unknown', value: null, provider: selectedProvider, error: e.message });
  }
}
