'use strict';
// 计费规则：基础价 + 各类重印/减量的费用处理
const round2 = (n) => Math.round(n * 100) / 100;

const PAGE_RATE = { A0: 12, A1: 6, A2: 3, A3: 1.5, A4: 0.8 }; // 元/页（黑白）
const COLOR_MULT = { bw: 1, color: 3 };
const SIDE_MULT = { single: 1, double: 1.8 };
const BINDING_FEE = { none: 0, staple: 2, ring: 5, glue: 8 }; // 元/份

const REPRINT_HANDLING = {
  font_missing: '字体缺失：店方承担，免费重印',
  layer_unprinted: '图层未打印：店方承担，免费重印',
  paper_jam: '机器卡纸：店方承担，免费重印',
  scale_mismatch: '尺寸比例不符：客户已确认校样，半价重印（收 50%）',
};

function perPage(order) {
  return PAGE_RATE[order.paper_size] * COLOR_MULT[order.color] * SIDE_MULT[order.sides];
}

function perCopy(order, pageCount) {
  return pageCount * perPage(order) + BINDING_FEE[order.binding];
}

function baseAmount(order, pageCount) {
  return round2(order.copies * perCopy(order, pageCount));
}

// 重印费用：按受影响页数×份数核算，再按原因决定收取比例
function reprintAmount(reason, order, pages, copies) {
  const full = pages * copies * perPage(order);
  switch (reason) {
    case 'font_missing':
    case 'layer_unprinted':
    case 'paper_jam':
      return 0; // 店方责任
    case 'scale_mismatch':
      return round2(full * 0.5); // 客户已确认校样，半价
    default: {
      const e = new Error(`未知重印原因: ${reason}`);
      e.status = 400;
      throw e;
    }
  }
}

// 客户临时减量：按减量份数退 90%（扣 10% 已排版手续费），返回负数
function reductionRefund(order, pageCount, reducedCopies) {
  return -round2(perCopy(order, pageCount) * reducedCopies * 0.9);
}

module.exports = {
  PAGE_RATE, COLOR_MULT, SIDE_MULT, BINDING_FEE, REPRINT_HANDLING,
  perPage, perCopy, baseAmount, reprintAmount, reductionRefund, round2,
};
