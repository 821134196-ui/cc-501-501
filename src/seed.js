'use strict';
// 演示数据：设备 + 图纸样本（含比例错误样例）+ 三个处于不同阶段的订单
const fs = require('node:fs');
const path = require('node:path');

const SAMPLES_DIR = path.join(__dirname, '..', 'samples');

// 比例错误样例：A1 图幅 841×594，内容实际跨度 73200×51800mm → 实际比例 1:87.0（非标准），
// 且声明 1:100 与实际不符；另含缺失字体 HZTXT 与未打印图层「临时标注」
const SCALE_ERROR_SAMPLE = {
  name: '厂房结构图-首层平面',
  pages: [
    {
      width_mm: 841, height_mm: 594, declared_scale: '1:100',
      content_mm: { w: 73200, h: 51800 },
      fonts: ['SimSun', 'HZTXT'],
      layers: [
        { name: '轴线', print: true }, { name: '墙体', print: true },
        { name: '尺寸标注', print: true }, { name: '临时标注', print: false },
      ],
    },
    {
      width_mm: 841, height_mm: 594, declared_scale: '1:100',
      content_mm: { w: 84100, h: 59400 },
      fonts: ['SimSun'],
      layers: [{ name: '轴线', print: true }, { name: '配筋', print: true }],
    },
  ],
};

const CLEAN_COLOR_SAMPLE = {
  name: '商业楼效果图',
  pages: [{
    width_mm: 594, height_mm: 420, declared_scale: '1:50',
    content_mm: { w: 29700, h: 21000 },
    fonts: ['SimHei', 'Arial'],
    layers: [{ name: '总平', print: true }, { name: '绿化', print: true }],
  }],
};

const CLEAN_BW_SAMPLE = {
  name: '办公室平面图',
  pages: [{
    width_mm: 420, height_mm: 297, declared_scale: '1:100',
    content_mm: { w: 42000, h: 29700 },
    fonts: ['SimSun'],
    layers: [{ name: '墙体', print: true }, { name: '家具', print: true }],
  }],
};

function writeSamples() {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const files = {
    '厂房结构图-A1-比例错误.json': SCALE_ERROR_SAMPLE,
    '商业楼效果图-A2.json': CLEAN_COLOR_SAMPLE,
    '办公室平面图-A3.json': CLEAN_BW_SAMPLE,
  };
  for (const [name, data] of Object.entries(files)) {
    const p = path.join(SAMPLES_DIR, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(data, null, 2));
  }
  return Object.keys(files);
}

function seed({ db, service }) {
  const sampleFiles = writeSamples();

  service.addDevice('绘图仪-1', 'plotter');
  service.addDevice('绘图仪-2', 'plotter');
  service.addDevice('激光机-1', 'laser');

  const read = (name) => fs.readFileSync(path.join(SAMPLES_DIR, name), 'utf8');

  // 订单1：比例错误样例 —— 已上传预检、已出校样，等待客户确认
  const o1 = service.createOrder({ customer: '中建三局-王工', paper_size: 'A1', color: 'bw', sides: 'single', binding: 'glue', copies: 2 });
  service.uploadVersion(o1.id, { filename: '厂房结构图-A1-比例错误.json', content: read('厂房结构图-A1-比例错误.json') });
  const proof1 = service.generateProof(o1.id);
  service.addAnnotation(proof1.id, { x: 420, y: 300, text: '此处比例请再核对', author: '门店' });

  // 订单2：已确认校样，在打印队列中
  const o2 = service.createOrder({ customer: '华阳设计-李工', paper_size: 'A2', color: 'color', sides: 'double', binding: 'none', copies: 2 });
  service.uploadVersion(o2.id, { filename: '商业楼效果图-A2.json', content: read('商业楼效果图-A2.json') });
  const proof2 = service.generateProof(o2.id);
  service.confirmProof(proof2.id);

  // 订单3：已打印完成，等待取件
  const o3 = service.createOrder({ customer: '个人-赵先生', paper_size: 'A3', color: 'bw', sides: 'single', binding: 'staple', copies: 1 });
  service.uploadVersion(o3.id, { filename: '办公室平面图-A3.json', content: read('办公室平面图-A3.json') });
  const proof3 = service.generateProof(o3.id);
  service.confirmProof(proof3.id);
  const task3 = db.prepare('SELECT * FROM print_tasks WHERE order_id=?').get(o3.id);
  service.claimTask(task3.id, '张伟');
  service.finishTask(task3.id, '张伟');

  return { orders: 3, sampleFiles, scaleErrorFile: 'samples/厂房结构图-A1-比例错误.json' };
}

module.exports = { seed, writeSamples };
