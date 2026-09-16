/**
 * AIMediator.js
 * B? ?i?u ph?i Dual-AI Engine:
 * - Ch?n provider: LOCAL_OLLAMA | CLOUD_OPENAI | CLOUD_GEMINI
 * - Quản lý lịch sử hội thoại ngữ cảnh (context window)
 * - Thuật toán AI Auto-Pause 30 phút khi nhân viên gõ tay
 */
const db = require('../database/db');
const ollama = require('../connectors/ollamaConnector');
const { openAIChat, geminiChat } = require('../connectors/cloudAiConnector');

const AI_PAUSE_DURATION_MS = 30 * 60 * 1000; // 30 phút
const MAX_HISTORY_TURNS = 10; // Gi? t?i ?a 10 l??t chat trong context

class AIMediator {
  /**
   * Xử lý tin nhắn mới đến từ khách hàng.
   * - Kiểm tra AI có bị pause không
   * - L?y config AI t? CSDL
   * - Gọi đúng provider và trả về câu trả lời
   *
   * @param {object} msg - Tin nhắn khách hàng
   * @param {function} sendFn - async sendFn(thread_id, text) ? void
   * @returns {Promise<boolean>} true nếu AI đã trả lời
   */
  async processIncoming(msg, sendFn) {
    if (msg.is_outgoing) return false;
    if (!msg.content) return false;

    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(msg.thread_id);
    if (!thread) return false;

    // ?? Ki?m tra AI Auto-Pause ??
    if (thread.ai_paused_until && new Date(thread.ai_paused_until) > new Date()) {
      console.log(`[AIMediator] AI t?m d?ng ??n ${thread.ai_paused_until} cho thread ${msg.thread_id}`);
      return false;
    }

    // ── Lấy cấu hình AI của tài khoản ──
    const config = db.prepare(`
      SELECT * FROM ai_configs WHERE account_id = ? AND is_active = 1
    `).get(thread.account_id);

    if (!config) return false; // AI chưa được cấu hình

    // ── Lấy lịch sử chat làm context ──
    const history = db.prepare(`
      SELECT content, is_outgoing FROM messages
      WHERE thread_id = ? AND is_unsent = 0 AND media_type = 'text'
      ORDER BY created_at DESC LIMIT ?
    `).all(msg.thread_id, MAX_HISTORY_TURNS * 2).reverse();

    const chatHistory = history.map((m) => ({
      role: m.is_outgoing ? 'assistant' : 'user',
      content: m.content
    }));

    // Đảm bảo message cuối là của user
    if (chatHistory[chatHistory.length - 1]?.role !== 'user') {
      chatHistory.push({ role: 'user', content: msg.content });
    }

    // ── Gọi đúng AI provider ──
    let aiResponse = '';
    try {
      console.log(`[AIMediator] ?ang g?i ${config.provider} - model: ${config.model_name}`);

      switch (config.provider) {
        case 'LOCAL_OLLAMA':
          aiResponse = await ollama.chat(config.model_name, chatHistory, config.system_prompt);
          break;

        case 'CLOUD_OPENAI':
          aiResponse = await openAIChat(config.api_key, config.model_name, chatHistory, config.system_prompt);
          break;

        case 'CLOUD_GEMINI':
          aiResponse = await geminiChat(config.api_key, config.model_name, chatHistory, config.system_prompt);
          break;

        default:
          console.warn(`[AIMediator] Provider không được hỗ trợ: ${config.provider}`);
          return false;
      }
    } catch (err) {
      console.error(`[AIMediator] L?i khi g?i AI (${config.provider}):`, err.message);
      return false;
    }

    if (!aiResponse.trim()) return false;

    // ── Gửi câu trả lời AI ──
    await sendFn(msg.thread_id, aiResponse);
    console.log(`[AIMediator] Đã gửi phản hồi AI cho thread ${msg.thread_id}`);
    return true;
  }

  /**
   * Gọi khi nhân viên gõ/gửi tin nhắn tay.
   * → Tạm dừng AI cho thread đó trong 30 phút.
   * @param {string} thread_id
   */
  pauseForThread(thread_id) {
    const pauseUntil = new Date(Date.now() + AI_PAUSE_DURATION_MS).toISOString();
    db.prepare('UPDATE threads SET ai_paused_until = ? WHERE id = ?').run(pauseUntil, thread_id);
    console.log(`[AIMediator] AI t?m d?ng cho thread ${thread_id} ??n ${pauseUntil}`);
    return { paused: true, until: pauseUntil };
  }

  /**
   * Bỏ tạm dừng AI thủ công cho một thread.
   * @param {string} thread_id
   */
  resumeForThread(thread_id) {
    db.prepare('UPDATE threads SET ai_paused_until = NULL WHERE id = ?').run(thread_id);
    console.log(`[AIMediator] AI ti?p t?c ho?t ??ng cho thread ${thread_id}`);
    return { paused: false };
  }

  // ── CRUD cấu hình AI ──────────────────────────────────────────────────────

  /** Tạo hoặc cập nhật cấu hình AI cho tài khoản */
  upsertConfig({ account_id, provider, api_key, model_name, system_prompt, is_active = 1 }) {
    db.prepare(`
      INSERT INTO ai_configs (account_id, provider, api_key, model_name, system_prompt, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        provider = excluded.provider,
        api_key = excluded.api_key,
        model_name = excluded.model_name,
        system_prompt = excluded.system_prompt,
        is_active = excluded.is_active
    `).run(account_id, provider, api_key || null, model_name, system_prompt, is_active ? 1 : 0);
    return { success: true };
  }

  /** Lấy cấu hình AI của tài khoản */
  getConfig(account_id) {
    return db.prepare('SELECT * FROM ai_configs WHERE account_id = ?').get(account_id);
  }

  /** Bật/tắt AI cho tài khoản */
  toggleAI(account_id, is_active) {
    db.prepare('UPDATE ai_configs SET is_active = ? WHERE account_id = ?').run(is_active ? 1 : 0, account_id);
    return { success: true, is_active };
  }

  /** Kiểm tra Ollama có đang chạy local không */
  async checkOllamaHealth() {
    return ollama.healthCheck();
  }
}

module.exports = new AIMediator();
