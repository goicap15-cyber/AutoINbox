/**
 * ollamaConnector.js
 * K?t n?i t?i Ollama Local API (http://localhost:11434).
 * Hỗ trợ streaming và non-streaming response.
 */
const http = require('http');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'localhost';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);

/**
 * Gửi prompt tới Ollama và nhận câu trả lời.
 * @param {string} model  - Tên model (vd: 'llama3', 'mistral', 'qwen2.5')
 * @param {string[]} messages - M?ng { role, content }
 * @param {string} systemPrompt - System prompt đầu tiên
 * @returns {Promise<string>} Câu trả lời từ AI
 */
async function chat(model, messages, systemPrompt) {
  const payload = JSON.stringify({
    model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt || 'Bạn là trợ lý tư vấn bán hàng thân thiện.' },
      ...messages
    ]
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.message?.content || '');
          } catch (e) {
            reject(new Error('L?i parse Ollama response: ' + data));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Ki?m tra k?t n?i t?i Ollama server
 */
async function healthCheck() {
  return new Promise((resolve) => {
    http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

module.exports = { chat, healthCheck };
