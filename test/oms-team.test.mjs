import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOmsMarketingTeam } from '../oms.js';

const leader = { role: 'marketing', ho_ten: 'Tạ Quang Trường' };
test('OMS dùng cơ cấu team hiện tại, gồm Phong và Thu Phương', () => {
  const members = ['Nguyễn Thị Trà My', 'Lê Thị Ánh', 'Lưu Xuân Phong', 'Nguyễn Thị Thu Phương'];
  assert.deepEqual(getOmsMarketingTeam(leader, () => ({ [leader.ho_ten]: members })), [leader.ho_ten, ...members]);
});
test('đổi cơ cấu team có hiệu lực ở lần đọc tiếp theo, không giữ nhóm cũ', () => {
  let team = { [leader.ho_ten]: ['Lưu Xuân Phong'] };
  const getTeamLead = () => team;
  assert.ok(getOmsMarketingTeam(leader, getTeamLead).includes('Lưu Xuân Phong'));
  team = { [leader.ho_ten]: ['Nguyễn Thị Thu Phương'] };
  assert.deepEqual(getOmsMarketingTeam(leader, getTeamLead), [leader.ho_ten, 'Nguyễn Thị Thu Phương']);
});
test('nhân viên thường chỉ xem mình, leader không mất đơn của mình', () => {
  const employee = { role: 'marketing', ho_ten: 'Lưu Xuân Phong' };
  const getTeamLead = () => ({ [leader.ho_ten]: [employee.ho_ten] });
  assert.deepEqual(getOmsMarketingTeam(employee, getTeamLead), [employee.ho_ten]);
  assert.deepEqual(getOmsMarketingTeam(leader, () => ({})), [leader.ho_ten]);
  assert.equal(getOmsMarketingTeam({ role: 'sale' }, getTeamLead), null);
});
