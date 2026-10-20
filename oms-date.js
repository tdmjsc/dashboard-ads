// OMS stores ngay_ve as UTC in a MySQL DATETIME. Date filters use Vietnam days.
export function omsDateBoundary(day, end = false) {
  const time = Date.parse(`${day}T00:00:00+07:00`) + (end ? 86400000 : 0);
  return new Date(time).toISOString().slice(0, 19).replace('T', ' ');
}
