'use strict';
// 打印机模拟适配器：不接触真实设备，只记录作业事件，便于测试与演示
class MockPrinter {
  constructor() {
    this.jobs = []; // {event, taskId, deviceId, operator, at}
  }
  start(job) {
    this.jobs.push({ event: 'start', ...job, at: new Date().toISOString() });
  }
  finish(job) {
    this.jobs.push({ event: 'finish', ...job, at: new Date().toISOString() });
  }
  jam(deviceId) {
    this.jobs.push({ event: 'jam', deviceId, at: new Date().toISOString() });
  }
}

module.exports = { MockPrinter };
