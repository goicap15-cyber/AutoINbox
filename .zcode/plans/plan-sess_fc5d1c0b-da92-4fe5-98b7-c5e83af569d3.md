## Kế hoạch: Hoàn tất nốt phần kiểm thử (code đã sửa xong ~95%)

### Đã hoàn thành (đã verify syntax OK)
1. ✅ `threadIdResolver.js` — bare-first policy (bare = chuẩn; `page:P:bare` chỉ khi collision thật với src_* khác) — **7/7 test pass**
2. ✅ `ConversationRepository.upsertThread` — adopt row bare chưa bind source thay vì mint namespaced
3. ✅ Migration v62 trong `database/db.js` — gộp row namespaced về bare (messages + mọi bảng có thread_id + contacts), có nhánh skip cho collision thật
4. ✅ `background.js` — `getVisibleBizContactName` + `looseBizNameMatch`; `ensureTabOnThread` verify header trước mỗi return-true; `handleSyncThreadMessages` identity nghiêm ngặt (null ID → đối chiếu header, sai → abort `thread_route_mismatch`); payload `REQUEST_PAGE_BATCH_SYNC` thêm `expected_bare_id` + `contact_name`; relay `PAGE_THREAD_ROUTE_MISMATCH`
5. ✅ `page_content.js` — `resolveCurrentThreadId` bỏ fallback "link đầu tiên trong DOM" (trả null); crawl verify route trước collect + mỗi vòng (null-tolerant cho crawl mutex); realtime dùng `lastKnownBizThreadId` fallback
6. ✅ `server.js` dispatch — fallback `page_id` từ `thread_url` + fallback `contact_name` từ thread row

### Còn lại (bị plan mode chặn giữa chừng)
1. **Cập nhật `tests/unit/pageThreadIngestAndRoute.test.js`**: test "PAGE_THREAD_MESSAGES_SYNCED_V1 pipeline" đang assert kỳ vọng namespaced CŨ (`page:1209...:100018089229407`) — sửa thành kỳ vọng bare-first (`100018089229407`), các assertion khác giữ nguyên (vẫn kiểm chứng không nổ FK, ACK giữ bare).
2. **Chạy toàn bộ test suite** liên quan: threadIdResolver, pageThreadIngestAndRoute, initialMessageSweepService, inboxSyncScheduler — sửa nếu còn fail nào.
3. **Kiểm chứng migration v62 trên BẢN SAO DB thật** (an toàn, không đụng DB live): copy `data/database.db` → `scratch/`, chạy migration bằng env `CRM_DATA_ROOT` trỏ vào bản copy, đối chiếu: hết row `page:%` trùng, messages được gộp về bare, source_id được bind.
4. **Smoke load server** (`node --check` + require module) — xác nhận migration chạy sạch khi khởi động thật.

### Không đụng tới
- DB thật chỉ được migration khi **bạn tự chạy `npm start`** (migration v62 sẽ chạy tự động, có backup cơ chế sẵn của runMigrations).