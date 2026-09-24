'use strict';

/*
 * 余料库存页「筛选后整单释放范围」回归测试。
 *
 * 缺陷场景：同一预占单含大小不同的两块余料，按最小尺寸筛选后明细列表
 * 只剩一块，页面分组却按筛选后的列表统计（显示「占用 1 块」），而
 * 「释放该预占」按预占单号释放整单（实际释放两块），显示与操作范围不一致。
 *
 * 修复：GET /api/offcuts 在同一次库存读取中，除遵循筛选条件的明细列表外，
 * 另返回完整已预占单分组（allocations）——组内编号、总块数与释放按钮
 * 始终对应整单，不随列表筛选裁剪；即使没有任何明细行匹配，分组仍可见。
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const {
  _resetStore,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
  allocationGroups,
} = require('../src/offcuts');
const { ocAllocationsHtml } = require('../public/offcuts');

beforeEach(() => _resetStore());

/* 同一预占单预占大小不同的两块余料（大块 300×300、小块 120×120） */
function setupMixedAllocation() {
  createOffcut({ paperName: '大块', width: 300, height: 300 });
  createOffcut({ paperName: '小块', width: 120, height: 120 });
  const alloc = allocateOffcuts({ width: 100, height: 100, quantity: 2, grain: 'any' });
  assert.equal(alloc.status, 'fulfilled');
  assert.equal(alloc.reservedCount, 2);
  return alloc;
}

test('查询返回完整预占单分组：最小尺寸筛选只剩一块时，分组仍对应整单两块', () => {
  const alloc = setupMixedAllocation();

  // 最小尺寸 200×200：明细列表只剩 300×300 的大块
  const filtered = listOffcuts({ minW: 200, minH: 200 });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.offcuts[0].w, 300);

  // 分组不随筛选裁剪：仍是整单 2 块，编号齐全
  assert.equal(filtered.allocations.length, 1);
  const g = filtered.allocations[0];
  assert.equal(g.allocationId, alloc.allocationId);
  assert.equal(g.count, 2);
  assert.deepEqual(g.offcutIds, ['OC-000001', 'OC-000002']);
  assert.equal(g.offcuts.length, 2);
  assert.deepEqual(g.product, { width: 100, height: 100, grain: 'any' });
  assert.ok(g.createdAt);
});

test('无任何明细行匹配时，预占单分组仍返回（页面分组仍可见）', () => {
  const alloc = setupMixedAllocation();

  // 最小尺寸筛到一块都不剩
  const none = listOffcuts({ minW: 500, minH: 500 });
  assert.equal(none.count, 0);
  assert.equal(none.allocations.length, 1);
  assert.equal(none.allocations[0].allocationId, alloc.allocationId);
  assert.equal(none.allocations[0].count, 2);

  // 只看「可用」：两块都已预占，明细为空，分组仍在
  const availOnly = listOffcuts({ status: 'available' });
  assert.equal(availOnly.count, 0);
  assert.equal(availOnly.allocations.length, 1);
  assert.equal(availOnly.allocations[0].count, 2);

  // 关键字不匹配任何记录：分组仍在
  const kw = listOffcuts({ q: '不存在的纸型' });
  assert.equal(kw.count, 0);
  assert.equal(kw.allocations.length, 1);
});

test('分组排序确定：组按预占单号升序，组内余料按编号升序', () => {
  createOffcut({ width: 400, height: 400 }); // OC-000001
  createOffcut({ width: 300, height: 300 }); // OC-000002
  createOffcut({ width: 200, height: 200 }); // OC-000003
  const a1 = allocateOffcuts({ width: 150, height: 150, quantity: 1 });
  const a2 = allocateOffcuts({ width: 150, height: 150, quantity: 2 });
  assert.notEqual(a1.allocationId, a2.allocationId);

  const groups = allocationGroups();
  assert.deepEqual(groups.map((g) => g.allocationId), [a1.allocationId, a2.allocationId]);
  assert.equal(groups[1].count, 2);
  const ids = groups[1].offcutIds;
  assert.deepEqual(ids, [...ids].sort());
});

test('释放整单后分组消失，余料回到可用', () => {
  const alloc = setupMixedAllocation();
  assert.equal(listOffcuts().allocations.length, 1);

  const rel = releaseAllocations({ allocationIds: [alloc.allocationId] });
  assert.equal(rel.releasedCount, 2);

  const after = listOffcuts();
  assert.equal(after.allocations.length, 0);
  assert.equal(after.summary.reserved, 0);
  assert.equal(after.summary.available, 2);
});

test('页面分组渲染：占用块数、余料编号与释放按钮始终对应整单', () => {
  const alloc = setupMixedAllocation();

  // 模拟筛选后只剩一块明细的页面数据：分组装进整单两块
  const data = listOffcuts({ minW: 200, minH: 200 });
  assert.equal(data.count, 1);
  const html = ocAllocationsHtml(data.allocations);

  // 「占用 2 块」而非筛选后的 1 块；两块编号都列出；释放按钮指向整单单号
  assert.ok(html.includes('占用 <b>2</b> 块'), '分组应显示整单块数');
  assert.ok(html.includes('OC-000001'), '组内应包含大块编号');
  assert.ok(html.includes('OC-000002'), '组内应包含小块编号');
  assert.ok(html.includes(`data-allocation="${alloc.allocationId}"`),
    '释放按钮应对应整单预占单号');

  // 明细一行都不匹配时，分组 HTML 依然渲染
  const empty = listOffcuts({ minW: 500, minH: 500 });
  assert.equal(empty.count, 0);
  const html2 = ocAllocationsHtml(empty.allocations);
  assert.ok(html2.includes('占用 <b>2</b> 块'));
  assert.ok(html2.includes(alloc.allocationId));
});
