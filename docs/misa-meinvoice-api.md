# MISA meInvoice OpenAPI — tóm tắt để tích hợp OMS

Đọc 27/11/2026 từ developer.misa.vn (cần đăng nhập MISA ID): ứng dụng **TDMJSC Internal app**
(`/my-integration/01a21bd6-9ea6-7ef4-b568-9bd9c1670cad`), sản phẩm **Hóa đơn điện tử** (Đang hoạt động),
tài liệu `/products-openapi/MEINVOICE`. Client ID / Client Secret xem ở trang ứng dụng, **không ghi vào repo**
(để trong `.env` hoặc ô nhập admin). Trang ứng dụng có sẵn một tài khoản kiểm thử MISA cấp (MST, username,
password) để thử API mà không đụng dữ liệu thật.

Một ứng dụng dùng cho nhiều hộ: mỗi lần lấy token gửi ClientID/Secret của ứng dụng + **MST, tài khoản,
mật khẩu meInvoice của từng hộ** (HKD TD, HKD Thắng…).

## Chung
- Base URL: `https://developer.misa.vn/apis/itg/meinvoice/` (cùng cho thử và thật; tài khoản quyết định).
- Header mọi request: `ClientID`, `Content-Type: application/json`, `Authorization: Bearer <token>`.
- Giới hạn 10 request / 60 giây mỗi API (vượt → HTTP 429, `ErrorCode: TooManyRequests`).
- Response phát hành: `{ success, errorCode, descriptionErrorCode, createInvoiceResult, publishInvoiceResult, errors, data, customData }`.
  Kiểm tra theo thứ tự: `success` → `errorCode` → `publishInvoiceResult[i].ErrorCode` (null/rỗng = thành công).
  `publishInvoiceResult` có thể là **chuỗi JSON** cần `JSON.parse`.

## Token
- `POST /invoice/token` — header `ClientID`, `ClientSecret`; body `{ taxcode, username, password }`.
  Trả `{ Success, Data: "<token>", ErrorCode, Errors, CustomData }`. Token hạn **14 ngày**, lưu lại dùng tiếp.
- Tài khoản bật xác thực 2 bước: `POST /invoice/2fa` body `{ UserID (CustomData.Id từ /token), DeviceID, Remember, Code (OTP) }`.
- Hết hạn: `POST /invoice/token/refresh`, body là chuỗi token cũ. Lỗi `TokenExpiredCode` → refresh; `UnAuthorize` / `InvalidTokenCode` → lấy token mới.

## Mẫu hoá đơn
- `GET /invoice/templates?invoiceWithCode=true|false&ticket=false&year=YYYY` → `Data[]`:
  `IPTemplateID, TemplateName, InvSeries, Inactive, IsInheritFromOldTemplate, IsSendSummary, IsPetrol, IsMoreVATRate`.
- Ký hiệu `XC25TYY`: ký tự 1 = loại (1 GTGT, **2 hoá đơn bán hàng**, 5 vé, 6 PXK); ký tự 2 = C có mã / K không mã;
  ký tự 5 = T thường / M máy tính tiền. Năm trong ký hiệu MISA tự đổi theo `InvDate`.

## Phát hành (HSM / không ký)
- `POST /invoice/publishing` body `{ SignType, InvoiceData: [...] }`.
  `SignType`: 2 = ký HSM (CKS Esign nâng cao / Softdream / CyberLotus / ICORP — kiểm tra bằng `GET /get-certificates`),
  5 = hoá đơn máy tính tiền (không hiện CKS), 1 = USB token (**không** dùng endpoint này, dùng luồng `/publishing/token`).
- Tối đa 30 hoá đơn / request, 400 dòng / hoá đơn. **Xử lý tuần tự theo từng ký hiệu**, nghỉ ~3 giây giữa các lần
  (tránh `InvoiceNumberNotCotinuous`, `InvoiceDuplicated` → gặp thì phát hành lại).
- Xem trước (tuỳ chọn): `POST /invoice/unpublishview` (link sống 5 phút).
- InvoiceData chính: `RefID` (unique, MISA khuyên theo đơn hàng; trùng → `DuplicateInvoiceRefID` → tra trạng thái theo RefID),
  `InvSeries`, `InvTemplateNo`, `InvDate` (yyyy-MM-dd, không nhỏ hơn hoá đơn cuối cùng của ký hiệu), `CurrencyCode` VND,
  `PaymentMethodName` (TM/CK), `IsInvoiceSummary` (theo mẫu `IsSendSummary`), `IsSendEmail`, người mua
  (`BuyerFullName`, `BuyerPhoneNumber`, `BuyerAddress`, `BuyerLegalName`+`BuyerTaxCode` nếu có MST, `BuyerOrderCode`),
  tổng tiền `TotalSaleAmountOC`, `TotalDiscountAmountOC`, `TotalAmountWithoutVATOC`, `TotalVATAmountOC`, `TotalAmountOC`
  (+ bản quy đổi không `OC` = × tỷ giá 1), `TotalAmountInWords` (bỏ trống → MISA tự đọc),
  `OriginalInvoiceDetail[]`, `TaxRateInfo[]` (bắt buộc với GTGT), `OptionUserDefined` (số chữ số thập phân).
- Dòng hàng: `ItemType` (1 thường, 2 khuyến mại, 3 chiết khấu thương mại, 4 ghi chú), `SortOrder`, `LineNumber`,
  `ItemCode`, `ItemName`, `UnitName`, `Quantity`, `UnitPrice`, `AmountOC`/`Amount` = SL × giá,
  `DiscountRate`, `DiscountAmountOC`/`DiscountAmount`, `AmountWithoutVATOC`/`AmountWithoutVAT` = thành tiền − chiết khấu,
  `VATRateName` (KCT, KKKNT, 0%, 5%, 8%, 10%, KHAC:x%), `VATAmountOC`/`VATAmount`.
  Giảm giá OMS (`giam_gia`) → chiết khấu trên dòng (`DiscountAmountOC`) hoặc dòng `ItemType` 3.
- Kết quả: lưu `TransactionID` (mã tra cứu) + số hoá đơn.
- Chưa rõ với hộ kinh doanh: ký hiệu / `VATRateName` / `TaxRateInfo` dùng giá trị nào → lấy từ `/invoice/templates`
  của tài khoản thật và thử bằng tài khoản kiểm thử trước.

## Đã kiểm chứng (28/11/2026, tài khoản kiểm thử MISA)
- `/invoice/token` + `/invoice/templates` chạy; tài khoản thử có các ký hiệu 1C/1K (GTGT), 2C26MYT (bán hàng MTT), 2C26TYY (bán hàng thường), 6C (PXK).
- `/invoice/publishing` thành công với 2C26MYT (SignType 5), 2C26TYY (SignType 2), 1C26TYY thuế 8%; `InvTemplateNo` = ký tự đầu ký hiệu.
  Kết quả: `[{ RefID, TransactionID, InvTemplateNo, InvSeries, InvNo, InvCode, InvDate, ErrorCode: "", DescriptionErrorCode: "" }]`.
- Gửi lại cùng RefID → `ErrorCode: DuplicateInvoiceRefID` (kèm `InvNo` của hoá đơn đã có).
- `/invoice/status?inputType=2` với body `[RefID]` trả hoá đơn (`TransactionID, InvNo, PublishStatus 1, InvoiceCode, SendTaxStatus…`).

## Tra cứu
- `POST /invoice/status?inputType=1|2&invoiceWithCode=…&invoiceCalcu=…` body `["TransactionID…"]` (1 = TransactionID, 2 = RefID).
  `Data[]`: `TransactionID, PublishStatus, InvoiceCode, SendTaxStatus, IsDelete, …`. Đang xử lý → hỏi lại sau 3–5 giây, tối đa 3 lần.
- Xem / tải sau phát hành, gửi email khách: có API riêng (chưa đọc chi tiết).

## Lỗi hay gặp
`TemplateNotExist` / `InvoiceTemplateNotExist` (sai ký hiệu), `InvalidInvoiceData`, `InvoiceDetail_{field}` / `RequireError_{field}`
(sai trường), `LicenseInfo_NotBuy` / `LicenseInfo_OutOfInvoice` / `LicenseInfo_Expired` (hết tài nguyên — mua thêm),
`DeclarationNotExist` / `InvalidDeclaration` (chưa có tờ khai được CQT chấp nhận), `CallSignServiceFail` (CKS không ký HSM được),
`InvalidXMLContainEmoji` (bỏ emoji khỏi tên KH / SP), `InvalidInvoiceDate`, `SystemError` (thử lại có giãn cách).
