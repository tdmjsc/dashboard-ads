// json-store.js — FILE JSON DÙNG CHUNG GIỮA NHIỀU TIẾN TRÌNH
//
// Passenger có thể chạy nhiều tiến trình Node cùng lúc, mỗi tiến trình một bản dữ liệu trong bộ nhớ.
// Ghi cả bản trong bộ nhớ ra file sẽ xoá thay đổi tiến trình khác vừa ghi (từng mất dữ liệu 10/2026,
// xem ten-hoa-don.js). Vì vậy:
//   • read()      đọc file mới nhất (dùng trước mỗi việc).
//   • commit(fn)  đọc file mới nhất → fn(s) sửa đúng phần cần đổi → ghi ngay (đồng bộ, không await
//                 ở giữa) qua file tạm + đổi tên. fn trả về false thì không ghi.
// Việc gọi mạng lâu làm trước, rồi mới commit phần kết quả.
import fs from 'node:fs';

export function jsonStore(file, defaults = () => ({}), { mode = 0o600, space = 1, tag = 'STORE' } = {}) {
  const read = () => {
    try { return { ...defaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch { return defaults(); }
  };
  function commit(fn) {
    const s = read();
    const out = fn(s);
    if (out !== false) {
      try {
        const tmp = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(s, null, space), { mode });
        fs.renameSync(tmp, file); // ghi file tạm rồi đổi tên: không để file dở dang
      } catch (e) { console.error(`[${tag}] lưu file lỗi:`, e.message); }
    }
    return { s, out };
  }
  return { read, commit };
}
