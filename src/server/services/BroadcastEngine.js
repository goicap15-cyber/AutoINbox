/**
 * BroadcastEngine.js
 * Gửi tin nhắn hàng loạt an toàn với:
 * - Quota tối đa 150 tin/tài khoản/ngày
 * - Random delay 15s–45s giữa mỗi lần gửi
 * - Realtime Progress qua Socket.io
 */
const db = require('../database/db');

const DAILY_LIMIT = 150;
const MIN_DELAY_MS = 15_000; // 15 giây
const MAX_DELAY_MS = 45_000; // 45 giây

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BroadcastEngine {
  constructor() {
    this._runningCampaigns = new Map(); // campaignId ? { cancelled: bool }
  }

  /**
   * B?t ??u chi?n d?ch broadcast.
   * @param {object} opts
   * @param {string} opts.account_id - ID tài khoản FB
   * @param {string[]} opts.thread_ids - Danh sách Thread IDs nhận tin
   * @param {string} opts.message - N?i dung tin nh?n (h? tr? {ten_khach_hang})
   * @param {function} opts.sendFn - Hàm gửi: async sendFn(thread_id, text) → void
   * @param {function} opts.onProgress - Callback: onProgress({ sent, total, thread_id, status })
   * @returns {string} campaignId
   */
  async startCampaign({ account_id, thread_ids, message, sendFn, onProgress }) {
    // Kiểm tra và reset quota nếu sang ngày mới
    this._checkResetDailyQuota(account_id);

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
    if (!account) throw new Error('Tài khoản không tồn tại');

    const remaining = DAILY_LIMIT - (account.broadcast_daily_count || 0);
    if (remaining <= 0) {
      throw new Error(`Tài khoản đã đạt giới hạn ${DAILY_LIMIT} tin/ngày. Thử lại vào ngày mai.`);
    }

    const targets = thread_ids.slice(0, remaining);
    const total = targets.length;
    const campaignId = `campaign_${Date.now()}`;
    const state = { cancelled: false };
    this._runningCampaigns.set(campaignId, state);

    console.log(`[Broadcast] Bắt đầu chiến dịch ${campaignId}: ${total}/${thread_ids.length} targets (limit ${DAILY_LIMIT}/ngày)`);

    // Chạy async không block
    (async () => {
      let sent = 0;
      for (const thread_id of targets) {
        if (state.cancelled) {
          console.log(`[Broadcast] Chiến dịch ${campaignId} đã bị huỷ.`);
          break;
        }

        const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(thread_id);
        const personalizedMsg = message.replace(
          /\{ten_khach_hang\}/g,
          thread?.contact_name || 'b?n'
        );

        try {
          await sendFn(thread_id, personalizedMsg);
          sent++;

          // T?ng daily count
          db.prepare(`
            UPDATE accounts SET broadcast_daily_count = broadcast_daily_count + 1 WHERE id = ?
          `).run(account_id);

          onProgress?.({ sent, total, thread_id, status: 'SENT', campaignId });
          console.log(`[Broadcast] [${sent}/${total}] Đã gửi đến ${thread_id}`);
        } catch (err) {
          console.error(`[Broadcast] L?i g?i ${thread_id}:`, err.message);
          onProgress?.({ sent, total, thread_id, status: 'ERROR', error: err.message, campaignId });
        }

        // Random delay trước khi gửi tiếp (trừ tin cuối cùng)
        if (sent < total && !state.cancelled) {
          const delay = randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
          console.log(`[Broadcast] Ch? ${(delay / 1000).toFixed(1)}s tr??c khi g?i ti?p...`);
          await sleep(delay);
        }
      }

      this._runningCampaigns.delete(campaignId);
      onProgress?.({ sent, total, status: sent === total ? 'COMPLETED' : 'PARTIAL', campaignId });
      console.log(`[Broadcast] Chiến dịch ${campaignId} hoàn tất: ${sent}/${total} tin gửi thành công.`);
    })();

    return campaignId;
  }

  /** Hu? chi?n d?ch ?ang ch?y */
  cancelCampaign(campaignId) {
    const state = this._runningCampaigns.get(campaignId);
    if (state) {
      state.cancelled = true;
      return { success: true, message: `?ang hu? chi?n d?ch ${campaignId}...` };
    }
    return { success: false, error: 'Không tìm thấy chiến dịch' };
  }

  /** Lấy quota còn lại trong ngày */
  getDailyQuota(account_id) {
    this._checkResetDailyQuota(account_id);
    const account = db.prepare('SELECT broadcast_daily_count FROM accounts WHERE id = ?').get(account_id);
    const used = account?.broadcast_daily_count || 0;
    return { used, remaining: DAILY_LIMIT - used, limit: DAILY_LIMIT };
  }

  /** Reset quota nếu đã sang ngày mới */
  _checkResetDailyQuota(account_id) {
    db.prepare(`
      UPDATE accounts
      SET broadcast_daily_count = 0, last_broadcast_date = DATE('now')
      WHERE id = ? AND last_broadcast_date < DATE('now')
    `).run(account_id);
  }
}

module.exports = new BroadcastEngine();
