# Ghi chú cho Claude

Đẩy lên `main` là tự deploy lên ads.tdmjsc.com (`.github/workflows/deploy.yml`).

## Dữ liệu (`DATA_DIR` = `/home/u112372823/data`) — đọc trước khi thêm/sửa file dữ liệu

- **Backup hằng ngày của Hostinger KHÔNG có `DATA_DIR`** (chỉ chụp `domains/`). Từng mất toàn bộ sản phẩm Tên xuất HĐ (10/2026) mà không có bản nào để khôi phục. `backupDataDir` trong `server.js` chép các file `.json`/`.bak` của `DATA_DIR` sang `domains/ads.tdmjsc.com/data-backup/YYYY-MM-DD/` mỗi 6 giờ (giữ 14 ngày) để backup Hostinger có dữ liệu. File dữ liệu mới phải nằm thẳng trong `DATA_DIR` với đuôi `.json` thì mới được chép.
- **Máy chủ có thể chạy nhiều tiến trình Node.** Đừng viết kiểu nạp file một lần vào `STORE` rồi `save()` ghi cả bộ nhớ ra file: tiến trình giữ bản cũ sẽ xoá dữ liệu tiến trình khác vừa ghi. Làm theo `ten-hoa-don.js` (`reload` + `commit`: đọc file mới nhất → sửa theo id → ghi file tạm rồi đổi tên) hoặc `saveManual` trong `server.js` (gộp với file trên đĩa trước khi ghi + `.bak`). Thêm bản sao dự phòng + tự khôi phục khi khởi động nếu file chính hỏng.

## Báo cáo marketing (`/api/marketing/report`, hàm `sandboxReport` trong `server.js`)

Doanh số / đơn chốt / số SP lấy từ báo cáo Sandbox `ReportLeadByNhanSuMktSearch`, gọi mới mỗi lần mở trang (không cache). Chỉ chi tiêu Meta là có cache (`meta-cache.json`).

**Bắt buộc giữ cả hai tham số** (Sandbox đã xác nhận đây là cách ra số đúng, đã đối chiếu: Lưu Xuân Phong ngày 7/10/2026 = 11 SP / 4.900.000):

- `kieuNgay: 'NgayTaoContact'`: chỉ tính contact về trong khoảng ngày chọn.
  - Đừng dùng `'NgayTao'`: kiểu này tính cả đơn chốt trong ngày của contact về từ các ngày trước, nên tỷ lệ chốt có thể vượt 100%.
- `khongGioiHanNgayChot` (Không giới hạn ngày chốt): tính mọi đơn chốt của các contact đó, kể cả đơn chốt những ngày sau.
  - Thiếu cờ này thì Sandbox chỉ đếm đơn chốt trong chính khoảng ngày, nên xem lại ngày cũ sẽ thiếu doanh số của đơn chốt muộn.

Đã từng xảy ra lỗi: chỉ có `NgayTaoContact` mà không có cờ thì thiếu doanh số. Có lần gửi cờ dạng `true` thì Sandbox báo "Lỗi gọi báo cáo". Vì vậy `sandboxReport` thử lần lượt các dạng `[true, 1, 'true']` và nhớ dạng chạy được. Nếu không dạng nào chạy được, hàm gọi không có cờ và trang hiện cảnh báo. Đừng gỡ cơ chế thử lần lượt này.

Muốn kiểm tra số liệu thì mở endpoint dành cho admin: `/api/marketing/check-ngay-chot?since=YYYY-MM-DD&until=YYYY-MM-DD&name=<tên NV>`. Endpoint này so sánh các cách gọi và hiện lỗi gốc của Sandbox.

Không có tài khoản Sandbox trong môi trường dev. Đổi tham số báo cáo xong thì nhờ người dùng đối chiếu số với Sandbox.

## Tên xuất hoá đơn theo lô (`ten-hoa-don.js`, trang `/ten-hoa-don.html`)

Một sản phẩm Sandbox nhập từ nhiều nhà cung cấp, mỗi nhà cung cấp có tên riêng trên MISA. Module giữ hàng đợi tên xuất hoá đơn. Khi tên đang dùng hết số lượng (tồn MISA, hoặc số nhập tay trừ dần theo tồn MISA giảm), module tự đổi ô "Tên xuất hoá đơn" trên Sandbox sang tên kế tiếp.

- Cách chính (khi có `SANDBOX_WEB_USER`/`SANDBOX_WEB_PASS`): admin nhập **Mã SP Sandbox**, máy chủ dùng phiên đăng nhập của nó (`global.__sandboxAuth` trong `server.js`) gọi web API của form Cập nhật sản phẩm: `TimTheoDieuKienSPCha` (tìm id theo mã) → `SanPhamInit` (`data.data`) → `CapNhatThongTin`. `buildSaveBody` dựng body y hệt form (đã so khớp từng trường với một lần Lưu thật 9/10/2026). Sau khi lưu, đọc lại và so mọi trường; lệch thì ghi lại dữ liệu cũ và báo lỗi. Sản phẩm có thuộc tính con / cấu thành thì từ chối.
- Sandbox xác thực bằng cookie (không có header Authorization). Mỗi tài khoản chỉ một phiên: máy chủ đăng nhập lại sẽ đá phiên trình duyệt cùng tài khoản và ngược lại.
- Cách dự phòng: admin dán request "Lưu" (và request chi tiết) từ DevTools, máy chủ gửi lại request đó và chỉ thay trường tên (`tenXuatHoaDon`).
- "Gửi thử" lưu lại nguyên trạng tên đang có trên Sandbox, không lấy tên trong hàng đợi.
- Số lượng đã xuất hoá đơn dưới tên đang dùng (`refreshInvoiced`, chạy trong `checkAll` và mỗi 20 phút): hoá đơn điện tử từ `invoice/api/Invoice/TimHoaDonDienTuTheoDieuKien` (phiên web, chỉ `actionCode` 1 = phát hành, `ngayTao` giờ VN ≥ lúc tên bắt đầu dùng). Hoá đơn không có dòng hàng → dòng hàng lấy theo mã đơn qua web API `orderlogistic/api/DonHangLogistic/GetChiTietDonByMa` `{MaDon}` (cùng phiên web), cache ở `STORE.orders`. Dòng hàng: `donHangLogisticSanPhamDtos` (đã xác nhận với đơn thật) + combo `donHangLogisticComboDtos` (`soLuong` combo × `soLan` của sản phẩm trong `comBoSpaKhachHangChiTietDtos`; đã xác nhận với đơn combo thật 12/10/2026). `idSanPham` ở dòng đơn là id con, khác id sản phẩm gốc (`idSanPhamCha` mới là id gốc). Dòng trong combo không có mã SP (chỉ `ten`, `idSanPham`) → nhận qua id trong đơn: sản phẩm có thuộc tính thì `TimTheoDieuKienSPCha` trả id "cha", còn đơn dùng id do `SanPham/TimTheoDieuKien` trả (bắt buộc truyền nhóm SP, tìm theo tên rồi lọc đúng mã) → `rule.sbBranchIds`. Đã đối chiếu 12/10/2026 với máy đo và gel. Thêm dự phòng: id học từ dòng bán lẻ khớp mã SP (`rule.sbIds`). Đừng dùng API đối tác `GetOrderByConditions` cho việc này: nó lọc theo ngày data về (không theo mã đơn) và bị giới hạn ~1 lần gọi / 30–60 giây (dùng chung với trang marketing). Chẩn đoán một đơn: `/api/ton-kho/hd/debug-don?ma=DHLOG…`. Nhập tay SL được xuất thì còn lại = SL − số đã xuất HĐ (thay cách trừ theo tồn MISA). Chưa xử lý hoá đơn thay thế/điều chỉnh/huỷ.
- Kiểm tra chạy sau mỗi lần tồn MISA đổi (`afterSnapshot` trong `tonkho.js`).
- **Nhiều tiến trình:** Passenger có thể chạy nhiều tiến trình Node, mỗi cái một `STORE` trong bộ nhớ. Đã mất dữ liệu (10/2026): tiến trình giữ bản cũ ghi đè cả `ten-hoa-don.json`, xoá sản phẩm vừa thêm ở tiến trình khác. Vì vậy đọc lại file (`reload`) trước mỗi việc và mọi lần ghi đi qua `commit(fn)` (đọc file mới nhất → sửa theo id → ghi ngay, không `await` ở giữa). Việc gọi mạng lâu (đếm hoá đơn, đổi tên) làm trên bản sao rồi mới `commit` kết quả. Đừng thêm kiểu `STORE.x = …; save()` ghi cả bộ nhớ ra file. Bản sao mỗi giờ ở `DATA_DIR/ten-hoa-don.bak/` (giữ 72), khởi động mà file chính mất/hỏng thì tự khôi phục từ bản mới nhất.
- Cùng cách này (helper `jsonStore` trong `json-store.js`) dùng cho `tonkho.js` (`ton-kho.json`), `telegram-kho.js` (`kho-bot.json`), `telegram-all.js` (`tg-all.json`). Test hai tiến trình: `npm test` (`test/nhieu-tien-trinh.test.mjs`).

## Lương MKT: doanh thu TikTok + Shopee ghi nhận cho ai (`salary.html`, `ttspAdminPortion` trong `server.js`)

Đơn TikTok/Shopee không gán NV marketing nên nằm trong dòng Admin (dòng này còn lẫn đơn khác). Mỗi tháng admin chọn người ghi nhận (lưu `salary-ttsp.json`; tháng chưa cài thì lấy người nhận của tháng trước). Phần chuyển sang nhân viên được tính vào lương 2% nhưng không tính Thưởng DTT / Top 1 / HH Leader (`tinhLuongMKT` trong `salary-calc.js`, opts `ttsp`).

Số tự động: lấy `id` các nguồn có tên TikTok/Shopee từ báo cáo "Leads theo nguồn", rồi gọi báo cáo sản phẩm `BaoCaoMktTheoSanPham` với `strIdNguonDuLieu` = các id nối dấu phẩy, `idUserMkts` = [id Admin = GUID toàn số 0], theo từng trạng thái giao/thanh toán → doanh số + số lượng từng SP (giá vốn). Đã đối chiếu 14/10/2026 tháng 8/2026: Shopee 85.252.625 + TikTok 39.894.000 = 125.146.625 (Admin tổng 132.962.625).
- Báo cáo lương theo nhân sự `ReportLeadByNhanSuMktSearch` **bỏ qua** `strIdNguonDuLieu`; nó chỉ lọc nguồn qua `idLandingSanPham` (1 id dạng chuỗi, mảng thì ra 0).
- Ô nhập tay trên trang ghi đè số tự động (để trống = tự động).

## Bot Telegram "chat all" (`telegram-all.js`)

Gõ `@all` hoặc `/all` trong nhóm có bot → bot nhắc tên mọi thành viên (mặc định 50 người / tin, chỉnh bằng `TG_ALL_PER_MSG`; chưa kiểm chứng Telegram có báo đủ cho mọi người được nhắc trong 1 tin không; mỗi nhóm tối đa 1 lần / 30 giây). Token riêng `TELEGRAM_ALL_BOT_TOKEN` trong `.env`; không có token thì bot tắt. Nhận tin qua webhook `/tg-all/webhook` (loại trừ khỏi middleware đăng nhập, kiểm tra header secret_token); máy chủ tự `setWebhook` lúc khởi động. Đừng chạy bản dev có cùng token: nó sẽ chiếm webhook của máy chủ thật.

Telegram không cho bot lấy danh sách thành viên → bot ghi nhớ người đã nhắn / vào / rời nhóm (`DATA_DIR/tg-all.json`). Cần tắt privacy mode (BotFather /setprivacy) hoặc cho bot làm admin để bot thấy mọi tin. Xem tình trạng: `/api/tg-all` (admin).

## Báo đơn lỗi Shopee/TikTok (`don-loi-san.js`)

Mỗi 2 tiếng máy chủ (phiên web `global.__sandboxAuth`) đọc trang Sandbox "Danh sách đơn hàng lỗi TMĐT": `orderlogistic/api/DonHang/CRM_GetOrderCreateError` (`ecommerceCode` SHOPEE/TIKTOK bắt buộc, `sorts: []` bắt buộc, 7 ngày gần nhất) và gian hàng lỗi token `warehouse/api/UnitConnect/CRM_GetListUnitConnect` (`isErrorToken: true`), rồi nhắn đơn lỗi / gian hàng lỗi **mới** vào nhóm kho qua `global.__khoNotify`. Id đã báo lưu ở `DATA_DIR/don-loi-san.json` (đánh dấu trong `commit` trước khi gửi → nhiều tiến trình không báo trùng; gửi lỗi thì bỏ đánh dấu). Endpoint lấy từ mã JS Sandbox 18/10/2026, lúc đó chưa có đơn lỗi thật nên tên trường đơn (`partnerOrderCode`, `description`, `updatedDate`, `unitConnectId`) theo cột bảng trên trang. Xem / chạy ngay: `/api/don-loi-san?check=1` (admin).

## Đơn OMS theo chiến dịch / nhóm quảng cáo (trang Ads, cột "Đơn OMS")

Đơn Ladipage về OMS mang UTM. Tham số URL quảng cáo: `utm_source=facebook&utm_campaign={{campaign.id}}&utm_medium={{adset.id}}&utm_content={{ad.id}}`. **Chỉ tính đơn từ `AD_REF_FROM` = 2026-10-29** (`oms-ad-ref.js`, người dùng chọn không xử lý đơn cũ). `oms-ad-ref.js` tra từng ID số trong `utm_content/medium/term/campaign` qua Graph API (`global.__fbAdRef` trong `server.js`: ad → nhóm + chiến dịch, nhóm → chiến dịch), không dựa vào vị trí, không khớp theo tên. **Đơn từ link bình luận** (không UTM): fbclid kiểu mới (`Iw…`) chứa trường `adid` = ID quảng cáo (8 byte big-endian sau chữ `adid` trong base64url, đã đối chiếu 30/10/2026: link bình luận bài quảng cáo → 120250903464480253) → `adIdFromFbclid`/`findFbclid` (`oms-ad-ref.js`), tra trước UTM. OMS lưu `fbclid`, `url_page` của đơn. Chưa kiểm chứng Ladipage có gửi URL kèm fbclid ra webhook (tìm trong `fbclid` hoặc mọi trường chuỗi có `?fbclid=`). Kết quả ghi vào cột `fb_campaign_id/_name`, `fb_adset_id/_name`, `fb_ad_id`, `fb_ref_at` của `oms_orders`: lúc đơn về (không chặn webhook) và `fixAdRefs` mỗi 30 phút cho đơn tra lỗi (đơn 14 ngày chưa ra chiến dịch thì tra lại mỗi 6 giờ). Thẻ đơn + cột "Quảng cáo" tab Marketing trên `oms-admin.html` và cột "Quảng cáo" ở `oms-marketing.html` hiện chiến dịch › nhóm + UTM gốc (`adRefLine`, 2 bản giống nhau) để kiểm tra. Chẩn đoán một đơn: `/oms/api/ad-ref-debug?sdt=<SĐT>` (admin OMS: fbclid, `adidTuFbclid`, kết quả/lỗi Meta theo từng token). Chạy tay: `/oms/api/fix-ad-refs` (`?all=1` tra lại hết từ `AD_REF_FROM`, admin OMS).

**Đơn từ link trong bài / bình luận (chỉ có `fbclid`, không UTM):** fbclid kiểu mới mang `adid` = ID "ad" **nội bộ** của Meta, không phải ID quảng cáo (Ads Manager gọi quảng cáo là adgroup; adid sinh lúc Meta duyệt quảng cáo, đổi khi sửa rồi duyệt lại; quảng cáo nhân bản có adid riêng; nút, link trong bài và link bình luận của cùng quảng cáo cho cùng adid). Đã kiểm chứng 30/10/2026: Graph API công khai **không** tra được adid (không phải ad/nhóm/chiến dịch/creative, quét ~40 trường của Ad không trường nào chứa nó), Ads Manager không xuất được; chỉ Thư viện quảng cáo `facebook.com/ads/library/?id=<adid>` mở được (trang, nội dung, ngày chạy). Vì vậy OMS tự lập **thư viện adid** (bảng `oms_adid_map`, cột `oms_orders.fb_adid`, `'-'` = có fbclid không có adid): học khi link có cả fbclid lẫn UTM ra ID quảng cáo (`learn` trong `adRefFromUtm`; UTM ưu tiên hơn thư viện), từ `/oms/track` (đoạn script Ladipage gửi `location.href`, không cần đăng nhập), hoặc admin / NV marketing thêm tay ở `/oms-adid.html` (dán link có fbclid + ID quảng cáo). Cặp mới → ghép ngay đơn mang adid đó; `fixAdRefs` cũng ghép đơn chưa ra chiến dịch có adid trong thư viện. UTM báo quảng cáo khác cho adid đã có → `xung_dot`, cặp đó thôi dùng. Đừng gửi adid lên Graph API. Thông số URL quảng cáo phải dùng macro (`{{ad.id}}`…), không dùng ID cố định hay `{{…name}}`.

Thống kê: `/api/ads/oms-orders?since&until` (đọc mới, không cache; `since` bị nâng lên `AD_REF_FROM`; chốt = Đã chốt / Đang ship / Ship thành công như `mkt-stats`; DT chốt = `tong_tien` đơn chốt). Không phải admin chỉ thấy đơn của chiến dịch thuộc NV mình hoặc đơn mang tên mình. Nhóm trên trang khớp theo `adsets[].id` (cache Ads trước ngày này không có id nhóm → không ghép). Đơn inbox / gọi điện / sale tự tạo không có UTM → nằm ở "chưa rõ chiến dịch".

Khi đọc được OMS, cột **Kết quả = số đơn về OMS** và CP/kết quả = chi tiêu / đơn OMS (cả ô tổng và từng nhóm; `useOms`/`sums` trong `index.html`), thay cho kết quả Meta. Ngoại lệ: chiến dịch tin nhắn chưa có đơn OMS nào giữ kết quả Meta (đơn inbox không về OMS). Không hiện đơn chốt / doanh thu (người dùng không cần; API vẫn trả `chot`, `doanhThu`). Đối chiếu với Meta: dưới ô Kết quả hiện "Meta: x đơn" = sự kiện Pixel Meta ghi nhận (`metaOrders` trong `server.js`: mua hàng `omni_purchase` → `purchase` → `fb_pixel_purchase`, lấy loại đầu tiên có số; không có thì lead; `mDt` = giá trị từ `action_values`, trang không hiện), đọc cùng lời gọi insights chiến dịch (`daily[].mDon/mDt`) và nhóm (`adsets[].mDon/mDt`). Chỉ đọc, không gửi gì về Meta (người dùng chỉ muốn đối chiếu). Dữ liệu Ads trong cache nạp trước khi có số này thì không hiện dòng Meta.

## Quyền xem của team lead

Lead xem được kết quả của mọi NV có `team` = tên lead ở trang Nhân viên (`employees.html`, lưu `employees.json`). Middleware sau bước kiểm tra đăng nhập trong `server.js` tính lại `req.session.user.employees` mỗi request (danh sách trong `users.js` + team). Đừng ghi thành viên team vào `users.js`: chia NV cho lead ở trang Nhân viên. `salaryName` của tài khoản lead phải trùng tên lead ở trang Nhân viên.

`employees.json` cũng theo cách nhiều tiến trình: `refreshEmployees()` (đọc lại khi file đổi, chạy mỗi request) + `commitEmployees(fn)` (đọc file → sửa theo tên → ghi file tạm rồi đổi tên, bản trước sang `employees.json.bak`; khởi động mà file hỏng thì khôi phục từ `.bak`). Đừng sửa `EMPLOYEES` rồi ghi cả mảng ra file.

## Sổ quỹ tiền mặt (`thu-chi.js`, trang `/thu-chi.html`, menu nhỏ trong Kết quả kinh doanh)

Admin (cả kế toán) ghi tay từng khoản thu / chi tiền mặt (ngày, nhóm, nội dung, người nộp/nhận, số tiền). Tiền mặt còn lại = tồn quỹ ban đầu + Σ thu − Σ chi (mọi khoản, không theo kỳ đang xem). Lưu `DATA_DIR/thu-chi.json` theo cách nhiều tiến trình (`commit` theo id, bản trước sang `thu-chi.json.bak`). Khác `json-store.js`: file chính hỏng thì đọc `.bak`, cả hai hỏng thì từ chối ghi (không coi là sổ trống). Khác trang "Dòng tiền" (`dong-tien.html`, chỉ admin thật): trang đó chụp số dư theo ngày, không phải sổ thu chi.

## Tồn kho MISA Hộ kinh doanh: gia hạn token (`misa-tonkho.js`)

Admin dán request `paging_filter` (cURL) + **mã làm mới** `AidEncode` (`copy(localStorage.AidEncode)` trong Console trang MISA). Từ 10/2026 MISA chuyển HKD sang môi trường g2: trang MISA làm mới token bằng `POST /hkd/g1/api/auth/v1/account/refresh_token` `{tid, did, mid, sid: AidEncode}` + `X-Device` (`refreshSession`; tid/did từ X-MISA-Context, mid = claim `uid` của token; mỗi lần trả AidEncode mới, mã cũ bỏ). Cách cũ đăng nhập lại qua phiên AMIS (`renewSession`, `app/redirect/hkd` → `/hkd/callback?sid=`) từ máy chủ giờ bị đẩy sang `hkd.misa.vn/api/oauth/amis/login` (29–31/10/2026), chỉ còn là dự phòng. Tab MISA còn mở cùng tài khoản sẽ tự làm mới và làm mã của máy chủ hết hiệu lực → dán xong phải đóng tab. Khi bật tự gia hạn, máy chủ làm mới mỗi `hkdKeepAliveMinutes` (60) phút.
