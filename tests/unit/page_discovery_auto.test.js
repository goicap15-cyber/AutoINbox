const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Import module pageDiscovery (hỗ trợ CommonJS trong Node.js test runner)
const pageDiscovery = require('../../src/extension/pageDiscovery');

test('Unit Test: pageDiscovery.cleanPageName', async (t) => {
  await t.test('làm sạch tên Page hợp lệ và loại bỏ khoảng trắng / ngoặc kép thừa', () => {
    assert.equal(pageDiscovery.cleanPageName('  "Shop Thời Trang GenZ"  '), 'Shop Thời Trang GenZ');
    assert.equal(pageDiscovery.cleanPageName('(99+) Mỹ Phẩm Chính Hãng'), 'Mỹ Phẩm Chính Hãng');
    assert.equal(pageDiscovery.cleanPageName('• Tiệm Bánh Nhà Làm •'), 'Tiệm Bánh Nhà Làm •');
  });

  await t.test('loại bỏ các tên generic hệ thống hoặc thuần chữ số', () => {
    assert.equal(pageDiscovery.cleanPageName('Facebook'), null);
    assert.equal(pageDiscovery.cleanPageName('Trang'), null);
    assert.equal(pageDiscovery.cleanPageName('1234567890'), null);
    assert.equal(pageDiscovery.cleanPageName('undefined'), null);
    assert.equal(pageDiscovery.cleanPageName(''), null);
    assert.equal(pageDiscovery.cleanPageName(null), null);
  });
});

test('Unit Test: pageDiscovery.decodeFbUnicode', async (t) => {
  await t.test('giải mã các ký tự escape của Facebook', () => {
    assert.equal(pageDiscovery.decodeFbUnicode('Cửa hàng \\u0026 Dịch vụ'), 'Cửa hàng & Dịch vụ');
    assert.equal(pageDiscovery.decodeFbUnicode('\\u003CShop ABC\\u003E'), '<Shop ABC>');
  });
});

test('Unit Test: pageDiscovery.parsePagesFromHtml', async (t) => {
  await t.test('bóc tách Page từ JSON Comet trong thẻ <script data-sjs>', () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <script type="application/json" data-sjs>
          {
            "require": [
              ["RelayProvider", "init", [], [{
                "viewer": {
                  "actor": {
                    "all_pages": {
                      "edges": [
                        {
                          "node": {
                            "__typename": "Page",
                            "id": "100234567891",
                            "name": "Nội Thất Hiện Đại",
                            "category_name": "Thiết kế nội thất",
                            "profile_picture": {
                              "uri": "https://scontent.xx.fbcdn.net/p1.jpg"
                            }
                          }
                        },
                        {
                          "node": {
                            "__typename": "Page",
                            "id": "100234567892",
                            "name": "Quán Cà Phê Mộc",
                            "category_name": "Quán cà phê",
                            "profile_photo": {
                              "uri": "https://scontent.xx.fbcdn.net/p2.jpg"
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }]]
            ]
          }
        </script>
      </head>
      <body></body>
      </html>
    `;

    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].page_id, '100234567891');
    assert.equal(pages[0].name, 'Nội Thất Hiện Đại');
    assert.equal(pages[0].category, 'Thiết kế nội thất');
    assert.equal(pages[0].avatar_url, 'https://scontent.xx.fbcdn.net/p1.jpg');

    assert.equal(pages[1].page_id, '100234567892');
    assert.equal(pages[1].name, 'Quán Cà Phê Mộc');
    assert.equal(pages[1].category, 'Quán cà phê');
  });

  await t.test('bóc tách Page từ cấu trúc delegate_page (chuyển đổi profile)', () => {
    const mockHtml = `
      <script>
        var comet_data = {
          "user": {
            "delegate_page": {
              "id": "200345678901",
              "name": "Trang Blog Cá Nhân",
              "category_name": "Người sáng tạo nội dung",
              "profile_picture": {
                "uri": "https://scontent.xx.fbcdn.net/avatar.jpg"
              }
            }
          }
        };
      </script>
    `;

    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].page_id, '200345678901');
    assert.equal(pages[0].name, 'Trang Blog Cá Nhân');
    assert.equal(pages[0].avatar_url, 'https://scontent.xx.fbcdn.net/avatar.jpg');
  });

  await t.test('bóc tách bằng regex fallback khi JSON bị nhúng trong chuỗi string JS', () => {
    const mockHtml = `
      <script>
        /* JS fragment */
        {"id":"300456789012","name":"Gia Dụng Thông Minh","__typename":"Page"}
      </script>
    `;

    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].page_id, '300456789012');
    assert.equal(pages[0].name, 'Gia Dụng Thông Minh');
  });

  await t.test('loại bỏ trùng lặp nếu cùng 1 Page xuất hiện nhiều lần', () => {
    const mockHtml = `
      <script type="application/json">
        [
          {"__typename": "Page", "id": "400111222333", "name": "Cửa Hàng X", "profile_picture": {"uri": "https://x.jpg"}},
          {"__typename": "Page", "id": "400111222333", "name": "Cửa Hàng X", "profile_picture": {"uri": "https://x.jpg"}}
        ]
      </script>
    `;

    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].page_id, '400111222333');
  });

  await t.test('bỏ qua tài khoản cá nhân (User) và trùng với accountId', () => {
    const mockHtml = `
      <script type="application/json">
        [
          {"__typename": "User", "id": "100008005082872", "name": "Mai Nguyen Ngoc"},
          {"__typename": "Page", "id": "1112641435276011", "name": "Quản Lý Tài Chính Trẻ - 334"}
        ]
      </script>
    `;

    const pages = pageDiscovery.parsePagesFromHtml(mockHtml, '100008005082872');
    assert.equal(pages.length, 1);
    assert.equal(pages[0].page_id, '1112641435276011');
    assert.equal(pages[0].name, 'Quản Lý Tài Chính Trẻ - 334');
  });

  await t.test('khử trùng lặp NPE Dual ID (Actor ID 6159... và Legacy Page ID 1112...) cho cùng 1 tên Page', () => {
    const mockHtml = `
      <script type="application/json">
        [
          {
            "id": "61590861931263",
            "name": "Quản Lý Tài Chính Trẻ - 334",
            "delegate_page": {
              "id": "1112641435276011",
              "name": "Quản Lý Tài Chính Trẻ - 334"
            }
          }
        ]
      </script>
    `;

    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    assert.equal(pages.length, 1);
    // Ưu tiên Canonical Legacy Page ID
    assert.equal(pages[0].page_id, '1112641435276011');
    assert.equal(pages[0].name, 'Quản Lý Tài Chính Trẻ - 334');
  });
});

// ── 2026-09-28: Sửa mất page 20 & đảo ngược Cổng nhôm đúc 24h ──────────────

test('Unit Test: pageDiscovery đọc delegate_page_id dạng CHUỖI (không có object)', async (t) => {
  await t.test('page Meditech B chỉ có delegate_page_id chuỗi -> lấy đúng ID page thật, loại profile', () => {
    // Node thật từ payload 28/9: User node có delegate_page_id chuỗi,
    // KHÔNG có delegate_page object như page thường.
    const mockHtml = `
      <script>
        [{"__typename":"User","id":"61594384621540","name":"Phòng Khám Meditech - Filler Botox Cân Chỉnh Mặt","delegate_page_id":"1283058584897853"}]
      </script>
    `;
    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    // Trang thật phải được extract với ID delegate_page_id
    const real = pages.filter(p => p.page_id === '1283058584897853' && !p.dropped);
    assert.equal(real.length, 1, 'page thật 1283058584897853 phải được giữ');
    assert.equal(real[0].name, 'Phòng Khám Meditech - Filler Botox Cân Chỉnh Mặt');
    // Profile 61594384621540 phải bị loại (suspicious hoặc profile_alias)
    const profile = pages.filter(p => p.page_id === '61594384621540');
    const profileKept = profile.filter(p => !p.dropped);
    assert.equal(profileKept.length, 0, 'profile 61594384621540 không được lọt danh sách chính');
  });

  await t.test('hai page THẬT trùng tên không bị gộp mất (dedupe theo page-id, không theo tên)', () => {
    const mockHtml = `
      <script>
        [
         {"__typename":"Page","id":"1258043150736673","name":"Phòng Khám Meditech - Filler Botox Cân Chỉnh Mặt"},
         {"__typename":"User","id":"61594384621540","name":"Phòng Khám Meditech - Filler Botox Cân Chỉnh Mặt","delegate_page_id":"1283058584897853"}
        ]
      </script>
    `;
    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    const kept = pages.filter(p => !p.dropped);
    const ids = kept.map(p => p.page_id);
    // Cả 2 page thật (A 1258... và B 1283...) phải cùng sống sót
    assert.ok(ids.includes('1258043150736673'), 'Page A phải giữ');
    assert.ok(ids.includes('1283058584897853'), 'Page B phải giữ (trước đây bị gộp/ filter mất)');
  });
});

test('Unit Test: pageDiscovery đảo ngược Cổng nhôm đúc 24h (7684 là page thật)', async (t) => {
  await t.test('node User có delegate_page object: giữ delegate id, profile alias bị loại', () => {
    // Node thật từ payload 28/9 (raw_fragment): User 61583290945157
    // có delegate_page.id = 768461266361443 (đây mới là Page thật)
    const mockHtml = `
      <script>
        [{"__typename":"User","delegate_page_id":"768461266361443","delegate_page":{"id":"768461266361443","name":"Cổng nhôm đúc 24h"},"if_viewer_can_login_as_profile_plus":{"__typename":"User","id":"61583290945157"},"id":"61583290945157","name":"Cổng nhôm đúc 24h"}]
      </script>
    `;
    const pages = pageDiscovery.parsePagesFromHtml(mockHtml);
    const kept = pages.filter(p => !p.dropped);
    // Page thật 7684 phải được giữ
    const real = kept.filter(p => p.page_id === '768461266361443');
    assert.equal(real.length, 1);
    assert.equal(real[0].name, 'Cổng nhôm đúc 24h');
    // Profile 6158 không được lọt danh sách chính (dù bị extract nhầm từ node lồng)
    const profileKept = pages.filter(p => p.page_id === '61583290945157' && !p.dropped);
    assert.equal(profileKept.length, 0, 'profile 61583290945157 phải bị loại');
  });
});
