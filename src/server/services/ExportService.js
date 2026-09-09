const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { APP_DATA_ROOT } = require('../utils/appDataRoot');

const EXPORT_DIR = path.join(APP_DATA_ROOT, 'exports');
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

class ExportService {
  /**
   * Xuất danh sách Lead thu thập được ra file Excel (.xlsx)
   * @returns {string} Đường dẫn file Excel đã xuất
   */
  async exportLeadsToExcel() {
    const leads = db.prepare(`
      SELECT
        c.name AS ho_ten,
        c.phone AS so_dien_thoai,
        c.email,
        c.notes AS ghi_chu,
        t.account_id AS tai_khoan_fb,
        t.last_activity AS hoat_dong_cuoi,
        c.tags
      FROM contacts c
      JOIN threads t ON c.thread_id = t.id
      WHERE c.lead_captured = 1
        AND (c.phone IS NOT NULL OR c.email IS NOT NULL)
      ORDER BY t.last_activity DESC
    `).all();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AutoChatbot FB CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Danh Sách Lead', {
      pageSetup: { paperSize: 9, orientation: 'landscape' }
    });

    // Thiết lập Header Row với màu sắc đẹp
    sheet.columns = [
      { header: 'Họ tên khách hàng', key: 'ho_ten', width: 28 },
      { header: 'Số điện thoại', key: 'so_dien_thoai', width: 18 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Ghi chú', key: 'ghi_chu', width: 40 },
      { header: 'Tài khoản FB', key: 'tai_khoan_fb', width: 20 },
      { header: 'Hoạt động cuối', key: 'hoat_dong_cuoi', width: 22 },
      { header: 'Thẻ phân loại', key: 'tags', width: 20 }
    ];

    // Style Header Row
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E3A5F' }
      };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF3B82F6' } }
      };
    });
    headerRow.height = 28;

    // Thêm dữ liệu từng Lead
    leads.forEach((lead, idx) => {
      const row = sheet.addRow({
        ...lead,
        tags: lead.tags ? JSON.parse(lead.tags).join(', ') : ''
      });
      // Màu xen kẽ dòng
      if (idx % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
        });
      }
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    });

    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = 'A1:G1';

    const fileName = `leads_${Date.now()}.xlsx`;
    const filePath = path.join(EXPORT_DIR, fileName);
    await workbook.xlsx.writeFile(filePath);

    console.log(`[ExportService] Đã xuất ${leads.length} Lead ra file: ${filePath}`);
    return filePath;
  }

  /**
   * Xuất danh sách Lead ra file CSV
   * @returns {string} Đường dẫn file CSV đã xuất
   */
  exportLeadsToCSV() {
    const leads = db.prepare(`
      SELECT c.name, c.phone, c.email, c.notes, t.account_id, t.last_activity
      FROM contacts c
      JOIN threads t ON c.thread_id = t.id
      WHERE c.lead_captured = 1
    `).all();

    const header = ['Họ tên,Số điện thoại,Email,Ghi chú,Tài khoản FB,Hoạt động cuối'];
    const rows = leads.map((l) =>
      [l.name, l.phone, l.email, l.notes, l.account_id, l.last_activity]
        .map((v) => `"${(v || '').toString().replace(/"/g, '""')}"`)
        .join(',')
    );

    const csv = [...header, ...rows].join('\n');
    const fileName = `leads_${Date.now()}.csv`;
    const filePath = path.join(EXPORT_DIR, fileName);
    fs.writeFileSync(filePath, '\uFEFF' + csv, 'utf8'); // BOM UTF-8 cho Excel mở đúng

    console.log(`[ExportService] Đã xuất ${leads.length} Lead ra CSV: ${filePath}`);
    return filePath;
  }
}

module.exports = new ExportService();
