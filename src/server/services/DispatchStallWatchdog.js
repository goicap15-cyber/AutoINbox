// Phase C (ke hoach 2026-10-01 ws-socket-adoption): phat hien kenh dispatch
// "cam". Khi server giu mot socket zombie (half-open sau force-reload) thi
// ws.send() thanh cong nhung extension khong bao gio nhan: reproduce
// 2026-10-01 la 252 DISPATCHED / 0 THREAD_MESSAGES_SYNCED / SW console khong
// thay mot log xu ly sync nao, trong khi chieu nguoc (THREAD_SEEN, sidebar)
// van chay binh thuong vi server xu ly tin den theo type khong can dang ky.
//
// Tracker THUAN (khong biet socket, khong biet io): dem so dispatch lien tiep
// KHONG co ket qua cua moi account. Vuot nguong -> server goi probe
// (COMMAND_PROBE); co ACK hoac co bat ky ket qua sync nao -> kenh song, reset.
// Khong ACK -> server dong socket de extension tu dong ky lai (xem wire trong
// server.js). REGISTER socket moi cung reset.
class DispatchStallWatchdog {
  constructor({ stallLimit = 20 } = {}) {
    this.stallLimit = Math.max(1, Number(stallLimit) || 20);
    this.counts = new Map(); // account_id -> so dispatch lien tiep khong co ket qua
    this.probing = new Set(); // account dang cho COMMAND_PROBE_ACK
  }

  noteDispatch(accountId) {
    const accId = String(accountId || '');
    if (!accId || this.probing.has(accId)) return;
    this.counts.set(accId, (this.counts.get(accId) || 0) + 1);
  }

  // Bat ky ket qua sync nao (ca count=0) deu chung to kenh van song 2 chieu.
  noteResult(accountId) {
    const accId = String(accountId || '');
    if (!accId) return;
    this.counts.delete(accId);
    this.probing.delete(accId);
  }

  noteRegistered(accountId) {
    const accId = String(accountId || '');
    if (!accId) return;
    this.counts.delete(accId);
    this.probing.delete(accId);
  }

  // Tra ve true DUNG MOT LAN khi cham nguong (de server gui probe).
  shouldProbe(accountId) {
    const accId = String(accountId || '');
    if (!accId || this.probing.has(accId)) return false;
    if ((this.counts.get(accId) || 0) < this.stallLimit) return false;
    this.probing.add(accId);
    return true;
  }

  noteProbeAck(accountId) {
    const accId = String(accountId || '');
    if (!accId) return;
    this.probing.delete(accId);
    this.counts.delete(accId);
  }

  // Het han cho ACK: chu ky probe ket thuc. Wire trong server.js da dong
  // socket sau timeout nen keu hoi phuc luon di qua re-register (reset o
  // noteRegistered) hoac ACK den tre (noteProbeAck) - xoa ca bo dem de chu
  // ky stall sau nay (neu co) dem lai tu dau, tranh probe spam.
  probeTimedOut(accountId) {
    const accId = String(accountId || '');
    if (!accId) return;
    this.probing.delete(accId);
    this.counts.delete(accId);
  }

  // Exposed for tests only.
  _reset() {
    this.counts.clear();
    this.probing.clear();
  }
}

module.exports = { DispatchStallWatchdog };
