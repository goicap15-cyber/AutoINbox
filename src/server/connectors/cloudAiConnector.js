/**
 * cloudAiConnector.js
 * K?t n?i t?i Cloud AI APIs: OpenAI & Google Gemini.
 * Dùng fetch() built-in (Node.js 18+). Không cần SDK nặng.
 */

// ?? OpenAI ???????????????????????????????????????????????????????????????????

/**
 * G?i OpenAI Chat Completions API.
 * @param {string} apiKey
 * @param {string} model - vd: 'gpt-4o', 'gpt-3.5-turbo'
 * @param {object[]} messages - [{ role, content }]
 * @param {string} systemPrompt
 * @returns {Promise<string>}
 */
async function openAIChat(apiKey, model, messages, systemPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt || 'Bạn là trợ lý tư vấn bán hàng thân thiện.' },
        ...messages
      ],
      max_tokens: 1024,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ?? Google Gemini ?????????????????????????????????????????????????????????????

/**
 * G?i Google Gemini generateContent API.
 * @param {string} apiKey
 * @param {string} model - vd: 'gemini-1.5-flash', 'gemini-pro'
 * @param {object[]} messages - [{ role, content }]
 * @param {string} systemPrompt
 * @returns {Promise<string>}
 */
async function geminiChat(apiKey, model, messages, systemPrompt) {
  // Gemini API: systemInstruction riêng, contents dùng role 'user'/'model'
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: systemPrompt
        ? { parts: [{ text: systemPrompt }] }
        : undefined,
      contents,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

module.exports = { openAIChat, geminiChat };
